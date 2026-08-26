'use strict';

/**
 * CA247 -- Vapi Server URL webhook: deterministic staged silence-close state
 * machine (isolated POC).
 *
 * REBUILT 2026-08-26 per the CA247 Final Engineering Gate, after forensic
 * analysis of two failed live test calls proved the previous implementation's
 * core detection assumption was false in production (see stateMachine.js and
 * eventAdapter.js header comments for the full evidence trail). This version:
 *
 *   - Does NOT depend on Vapi's native customer.speech.timeout hook, or on
 *     matching any assistant speech text, to detect idle state. CA247 owns
 *     the idle timer and the check-in decision itself, driven only by
 *     generic speech-update started/stopped edges and transcript events.
 *   - Uses the exact same state-machine and event-classification modules
 *     (./stateMachine.js, ./eventAdapter.js) that the automated test suite
 *     (./test/*.test.js) exercises -- production and tests share one code
 *     path, not a parallel "test-only" implementation.
 *   - Is idempotent by construction: every timer arm carries a generation
 *     number; stale/duplicate callbacks and duplicate webhook deliveries are
 *     guaranteed no-ops (see stateMachine.js).
 *
 * Explicitly NOT implemented here: transfer, message-taking, appointments,
 * prank-call handling, or any other CA247 functionality. This service does
 * not touch Telnyx, phone numbers, Retell, or production CA247 in any way.
 */

const http = require('http');
const crypto = require('crypto');
const { CallStateMachine } = require('./stateMachine');
const { classify, extractCall, dispatch } = require('./eventAdapter');

// ---- Config -------------------------------------------------------------

const PORT = process.env.PORT || 3000;

// Vapi private API key -- only used as a fallback to look up a call's
// monitor.controlUrl via GET /call/:id if it wasn't present on the webhook
// payload itself. Not required for the core state machine to function.
const VAPI_PRIVATE_KEY = process.env.VAPI_PRIVATE_KEY || '';

// Webhook authentication. AUTH_MODE:
//   "hmac"   (default) -- verifies an HMAC-SHA256 signature header.
//   "secret" -- simple shared-secret compare against a fixed header
//            (matches assistant.server.secret / X-Vapi-Secret).
//   "none"   -- no verification. Local smoke-testing only.
const AUTH_MODE = process.env.AUTH_MODE || 'hmac';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const SIGNATURE_HEADER = (process.env.SIGNATURE_HEADER || 'x-vapi-signature').toLowerCase();
const TIMESTAMP_HEADER = (process.env.TIMESTAMP_HEADER || 'x-vapi-timestamp').toLowerCase();
const LEGACY_SECRET_HEADER = (process.env.LEGACY_SECRET_HEADER || 'x-vapi-secret').toLowerCase();
const REPLAY_WINDOW_MS = Number(process.env.REPLAY_WINDOW_MS || 5 * 60 * 1000);

const IDLE_MS = Number(process.env.IDLE_MS || 5000);
const SECOND_CHANCE_MS = Number(process.env.SECOND_CHANCE_MS || 5000);
const CHECKIN_LINE = process.env.CHECKIN_LINE || 'Are you still there?';
const CLOSING_LINE = process.env.CLOSING_LINE
  || "It seems you're no longer there. Thank you for calling ABC Plumbing. Goodbye.";

if (AUTH_MODE !== 'none' && !WEBHOOK_SECRET) {
  console.error('[FATAL] WEBHOOK_SECRET is not set. Refusing to start with unverifiable webhook auth.');
  console.error('[FATAL] Set WEBHOOK_SECRET, or explicitly set AUTH_MODE=none for local smoke-testing only.');
  if (require.main === module) process.exit(1);
}
if (AUTH_MODE === 'none') {
  console.warn('[WARN] AUTH_MODE=none -- webhook signature verification is DISABLED. Do not use in this mode against a real Vapi assistant.');
}

// ---- Structured logging --------------------------------------------------
// One JSON line per event/transition, sufficient to reconstruct any call
// without listening to it: callId, previous state, new state, event type,
// timer generation, reason, and timestamp (gate doc section 10).
function log(entry) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), callId: null, ...entry }));
}

// ---- Per-call registry --------------------------------------------------
// callId -> CallStateMachine instance. Nothing here is shared across calls
// (see eventAdapter/stateMachine test suite scenario J).
const machines = new Map();

function getOrCreateMachine(callId, controlUrl) {
  let sm = machines.get(callId);
  if (!sm) {
    sm = new CallStateMachine(callId, {
      idleMs: IDLE_MS,
      waitMs: SECOND_CHANCE_MS,
      controlUrl,
      sendCheckIn: (url) => sendSay(callId, url, CHECKIN_LINE, false),
      sendClosing: (url) => sendSay(callId, url, CLOSING_LINE, true),
      onLog: log,
    });
    machines.set(callId, sm);
  } else if (controlUrl) {
    sm.setControlUrl(controlUrl);
  }
  return sm;
}

// ---- Vapi API helpers --------------------------------------------------

async function fetchControlUrl(callId) {
  if (!VAPI_PRIVATE_KEY) return null;
  try {
    const res = await fetch(`https://api.vapi.ai/call/${callId}`, {
      headers: { Authorization: `Bearer ${VAPI_PRIVATE_KEY}` },
    });
    if (!res.ok) {
      log({ callId, event: 'controlUrl.fetch_failed', status: res.status });
      return null;
    }
    const data = await res.json();
    return (data && data.monitor && data.monitor.controlUrl) || null;
  } catch (err) {
    log({ callId, event: 'controlUrl.fetch_error', error: String(err) });
    return null;
  }
}

async function sendSay(callId, controlUrl, content, endCallAfterSpoken) {
  let url = controlUrl;
  if (!url) url = await fetchControlUrl(callId);
  if (!url) {
    log({
      callId,
      event: 'say.no_control_url',
      note: 'Cannot issue say command. Vapi silenceTimeoutSeconds backstop remains the fallback.',
    });
    throw new Error('no_control_url');
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'say', content, endCallAfterSpoken: !!endCallAfterSpoken }),
  });
  log({ callId, event: 'say.control_command_sent', status: res.status, ok: res.ok, endCallAfterSpoken: !!endCallAfterSpoken });
  if (!res.ok) throw new Error(`controlUrl responded ${res.status}`);
}

// ---- Signature verification --------------------------------------------

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(a || '', 'utf8');
  const bb = Buffer.from(b || '', 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function verifyRequest(headers, rawBody) {
  if (AUTH_MODE === 'none') return { ok: true, reason: 'auth_disabled' };

  if (AUTH_MODE === 'secret') {
    const provided = headers[LEGACY_SECRET_HEADER];
    if (!provided) return { ok: false, reason: 'missing_secret_header' };
    return { ok: timingSafeEqualStr(provided, WEBHOOK_SECRET), reason: 'secret_compare' };
  }

  const signature = headers[SIGNATURE_HEADER];
  if (!signature) return { ok: false, reason: 'missing_signature_header' };

  const timestamp = headers[TIMESTAMP_HEADER];
  if (timestamp) {
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > REPLAY_WINDOW_MS) {
      return { ok: false, reason: 'timestamp_out_of_window' };
    }
  }

  const signedPayload = timestamp ? `${timestamp}.${rawBody}` : rawBody;
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(signedPayload).digest('hex');
  const normalizedSig = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  return { ok: timingSafeEqualStr(normalizedSig, expected), reason: 'hmac_compare' };
}

// ---- Message handling --------------------------------------------------

function handleMessage(message, body) {
  const { callId, controlUrl } = extractCall(message, body);
  if (!callId) {
    log({ callId: null, event: 'event.no_call_id', type: message && message.type });
    return null;
  }

  const classification = classify(message);
  log({
    callId,
    event: 'event.received',
    type: message.type,
    role: message.role,
    status: message.status,
    source: message.source,
    classifiedAs: classification.kind,
  });

  const sm = getOrCreateMachine(callId, controlUrl);
  dispatch(sm, message);
  if (sm.state === 'ENDED') {
    // Release the finished call's state machine so the registry (and
    // /health's activeCalls count) doesn't leak memory over the service's
    // lifetime -- caught by the integration test suite, not assumed correct.
    machines.delete(callId);
  }
  return sm;
}

// ---- HTTP server --------------------------------------------------

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      activeCalls: machines.size,
      uptimeSec: process.uptime(),
      authMode: AUTH_MODE,
      idleMs: IDLE_MS,
      secondChanceMs: SECOND_CHANCE_MS,
      architecture: 'ca247-owned-idle-timer-v2',
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/webhook') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;

      const verification = verifyRequest(headers, rawBody);
      if (!verification.ok) {
        log({ callId: null, event: 'auth.rejected', reason: verification.reason });
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      let body;
      try {
        body = rawBody ? JSON.parse(rawBody) : {};
      } catch (err) {
        log({ callId: null, event: 'body.parse_error', error: String(err) });
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_json' }));
        return;
      }

      const message = body.message || body;
      try {
        handleMessage(message, body);
      } catch (err) {
        log({ callId: null, event: 'handler.error', error: String(err), stack: err && err.stack });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: true }));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

process.on('SIGTERM', () => {
  log({ callId: null, event: 'server.shutdown', activeCalls: machines.size });
  for (const sm of machines.values()) sm.onCallEnded('shutdown');
  machines.clear();
  server.close(() => process.exit(0));
});

// Only bind a port when run directly -- lets the test suite require() this
// file's exports without starting a real HTTP listener.
if (require.main === module) {
  server.listen(PORT, () => {
    log({ callId: null, event: 'server.started', port: PORT, authMode: AUTH_MODE, idleMs: IDLE_MS, secondChanceMs: SECOND_CHANCE_MS });
  });
}

module.exports = { server, handleMessage, machines, verifyRequest, getOrCreateMachine };
