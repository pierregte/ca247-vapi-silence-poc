'use strict';

/**
 * CA247 — Vapi Server URL webhook: staged silence-close state machine (isolated POC)
 *
 * Scope (deliberately narrow — see task instructions):
 *   - Receive Vapi Server URL events for the "Emma — ABC Plumbing POC" assistant.
 *   - Detect when the existing, validated 5s customer.speech.timeout hook's
 *     "Are you still there?" check-in has actually played (assistant.speechStarted,
 *     source === "force-say").
 *   - Arm a short per-call "second chance" timer (default 5s).
 *   - If genuine customer speech is observed before it expires, cancel the timer
 *     and do nothing else — Vapi's own conversation continues normally.
 *   - If it expires with no customer speech, POST to that call's monitor.controlUrl:
 *       { type: "say", content: <closing line>, endCallAfterSpoken: true }
 *     Vapi then plays the full closing line and ends the call itself.
 *   - silenceTimeoutSeconds on the assistant remains an untouched, independent
 *     backstop — if this service is unreachable or slow, Vapi still ends the call.
 *
 * Explicitly NOT implemented here: transfer, message-taking, appointments,
 * prank-call handling, or any other CA247 functionality. This service does not
 * touch Telnyx, phone numbers, Retell, or production CA247 in any way.
 */

const http = require('http');
const crypto = require('crypto');

// ---- Config -------------------------------------------------------------

const PORT = process.env.PORT || 3000;

// Vapi private API key — only used as a fallback to look up a call's
// monitor.controlUrl via GET /call/:id if it wasn't present on the webhook
// payload itself. Not required for the core state machine to function.
const VAPI_PRIVATE_KEY = process.env.VAPI_PRIVATE_KEY || '';

// Webhook authentication. AUTH_MODE:
//   "hmac"   (default) — verifies an HMAC-SHA256 signature header, matching
//            Vapi's Custom Credential (HMAC) scheme. Header names are
//            configurable since Vapi lets you name them at credential setup.
//   "secret" — simple shared-secret compare against a fixed header
//            (matches the legacy Bearer-Token-credential / X-Vapi-Secret style).
//   "none"   — no verification. Local smoke-testing only; refuses to start
//            in this mode unless explicitly set, and logs loudly.
const AUTH_MODE = process.env.AUTH_MODE || 'hmac';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const SIGNATURE_HEADER = (process.env.SIGNATURE_HEADER || 'x-vapi-signature').toLowerCase();
const TIMESTAMP_HEADER = (process.env.TIMESTAMP_HEADER || 'x-vapi-timestamp').toLowerCase();
const LEGACY_SECRET_HEADER = (process.env.LEGACY_SECRET_HEADER || 'x-vapi-secret').toLowerCase();
const REPLAY_WINDOW_MS = Number(process.env.REPLAY_WINDOW_MS || 5 * 60 * 1000);

const SECOND_CHANCE_MS = Number(process.env.SECOND_CHANCE_MS || 5000);
const CLOSING_LINE = process.env.CLOSING_LINE
  || "It seems you're no longer there. Thank you for calling ABC Plumbing. Goodbye.";

if (AUTH_MODE !== 'none' && !WEBHOOK_SECRET) {
  console.error('[FATAL] WEBHOOK_SECRET is not set. Refusing to start with unverifiable webhook auth.');
  console.error('[FATAL] Set WEBHOOK_SECRET, or explicitly set AUTH_MODE=none for local smoke-testing only.');
  process.exit(1);
}
if (AUTH_MODE === 'none') {
  console.warn('[WARN] AUTH_MODE=none — webhook signature verification is DISABLED. Do not use in this mode against a real Vapi assistant.');
}

// ---- Structured logging --------------------------------------------------
// One JSON line per event, sufficient to reconstruct the full sequence for
// any given call.id after the fact.
function log(callId, event, data) {
  const entry = {
    ts: new Date().toISOString(),
    callId: callId || null,
    event,
    ...(data || {}),
  };
  console.log(JSON.stringify(entry));
}

// ---- Per-call state --------------------------------------------------
// callId -> { state, timer, controlUrl, armedAt }
// Cleared on: genuine customer speech, timer expiry (after issuing close),
// call-ended event, or process shutdown. Nothing here is shared across calls.
const calls = new Map();

function clearCallTimer(callId, reason) {
  const s = calls.get(callId);
  if (s && s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
    log(callId, 'timer.cancelled', { reason });
  }
}

function clearCall(callId, reason) {
  clearCallTimer(callId, reason);
  if (calls.has(callId)) {
    calls.delete(callId);
    log(callId, 'call.state_cleared', { reason });
  }
}

function armSecondChanceTimer(callId, controlUrl) {
  // A later, independent silence episode re-arms cleanly: if a timer is
  // somehow already running for this call, replace it rather than stacking.
  clearCallTimer(callId, 're-armed');
  const existing = calls.get(callId);
  const timer = setTimeout(() => {
    log(callId, 'timer.expired', { waitedMs: SECOND_CHANCE_MS });
    sendClosingAndEndCall(callId);
  }, SECOND_CHANCE_MS);
  calls.set(callId, {
    state: 'WAITING_AFTER_IDLE_CHECK',
    timer,
    controlUrl: controlUrl || (existing && existing.controlUrl) || null,
    armedAt: Date.now(),
  });
  log(callId, 'timer.armed', { waitMs: SECOND_CHANCE_MS });
}

// ---- Vapi API helpers --------------------------------------------------

async function fetchControlUrl(callId) {
  if (!VAPI_PRIVATE_KEY) return null;
  try {
    const res = await fetch(`https://api.vapi.ai/call/${callId}`, {
      headers: { Authorization: `Bearer ${VAPI_PRIVATE_KEY}` },
    });
    if (!res.ok) {
      log(callId, 'controlUrl.fetch_failed', { status: res.status });
      return null;
    }
    const data = await res.json();
    return (data && data.monitor && data.monitor.controlUrl) || null;
  } catch (err) {
    log(callId, 'controlUrl.fetch_error', { error: String(err) });
    return null;
  }
}

async function sendClosingAndEndCall(callId) {
  const s = calls.get(callId);
  if (!s) return; // already cleared (e.g. cancelled right as this fired)

  let controlUrl = s.controlUrl;
  if (!controlUrl) {
    controlUrl = await fetchControlUrl(callId);
  }
  if (!controlUrl) {
    log(callId, 'close.no_control_url', {
      note: 'Cannot issue say+endCall. Vapi silenceTimeoutSeconds backstop will terminate the call instead.',
    });
    clearCall(callId, 'no_control_url');
    return;
  }

  try {
    const res = await fetch(controlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'say',
        content: CLOSING_LINE,
        endCallAfterSpoken: true,
      }),
    });
    log(callId, 'close.control_command_sent', { status: res.status, ok: res.ok });
  } catch (err) {
    log(callId, 'close.control_command_error', { error: String(err) });
  } finally {
    clearCall(callId, 'closing_issued');
  }
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

  // hmac mode (default)
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

// ---- Event classification --------------------------------------------------

function extractCall(message, body) {
  const call = (message && message.call) || (body && body.call) || {};
  const callId = call.id || null;
  const controlUrl = (call.monitor && call.monitor.controlUrl) || null;
  return { callId, controlUrl };
}

// The validated 5s hook is the ONLY hook on this assistant, so any
// force-say assistant speech is, by construction, the "Are you still
// there?" check-in — no text matching needed, which keeps this robust to
// minor wording changes.
function isCheckinSpeech(message) {
  return message.type === 'assistant.speechStarted' && message.source === 'force-say';
}

function isCustomerSpeech(message) {
  if (message.type === 'speech-update') {
    return message.role === 'customer' && message.status === 'started';
  }
  if (message.type === 'transcript') {
    return message.role === 'user' && !!message.transcript;
  }
  return false;
}

function isCallEnded(message) {
  return message.type === 'end-of-call-report'
    || (message.type === 'status-update' && message.status === 'ended');
}

function handleMessage(message, body) {
  const { callId, controlUrl } = extractCall(message, body);
  if (!callId) {
    log(null, 'event.no_call_id', { type: message && message.type });
    return;
  }

  log(callId, 'event.received', {
    type: message.type,
    role: message.role,
    status: message.status,
    source: message.source,
  });

  if (controlUrl) {
    const existing = calls.get(callId);
    if (existing) existing.controlUrl = controlUrl;
  }

  if (isCallEnded(message)) {
    clearCall(callId, 'call_ended');
    return;
  }

  if (isCheckinSpeech(message)) {
    log(callId, 'checkin.detected', { type: message.type });
    armSecondChanceTimer(callId, controlUrl);
    return;
  }

  if (isCustomerSpeech(message)) {
    const s = calls.get(callId);
    if (s && s.state === 'WAITING_AFTER_IDLE_CHECK') {
      log(callId, 'customer_speech.detected_during_wait', { type: message.type });
      clearCall(callId, 'genuine_customer_speech');
    }
    return;
  }
}

// ---- HTTP server --------------------------------------------------

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      activeCalls: calls.size,
      uptimeSec: process.uptime(),
      authMode: AUTH_MODE,
      secondChanceMs: SECOND_CHANCE_MS,
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
        log(null, 'auth.rejected', { reason: verification.reason });
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      let body;
      try {
        body = rawBody ? JSON.parse(rawBody) : {};
      } catch (err) {
        log(null, 'body.parse_error', { error: String(err) });
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_json' }));
        return;
      }

      const message = body.message || body;
      try {
        handleMessage(message, body);
      } catch (err) {
        log(null, 'handler.error', { error: String(err), stack: err && err.stack });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: true }));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(PORT, () => {
  log(null, 'server.started', { port: PORT, authMode: AUTH_MODE, secondChanceMs: SECOND_CHANCE_MS });
});

process.on('SIGTERM', () => {
  log(null, 'server.shutdown', { activeCalls: calls.size });
  for (const callId of calls.keys()) clearCall(callId, 'shutdown');
  server.close(() => process.exit(0));
});
