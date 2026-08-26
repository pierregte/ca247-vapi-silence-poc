'use strict';

/**
 * Integration test: exercises the ACTUAL HTTP server exported by server.js
 * (gate doc section 8 -- "Refactor if necessary so the production event
 * handlers and automated tests share the exact same logic"). Uses small
 * real timers (env-configured) rather than a fake clock, since this test
 * goes through the real HTTP + auth + JSON layers server.js runs in
 * production, not just the state-machine module in isolation.
 */

process.env.AUTH_MODE = 'secret';
process.env.WEBHOOK_SECRET = 'integration-test-secret';
process.env.IDLE_MS = '30';
process.env.SECOND_CHANCE_MS = '30';
process.env.PORT = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { server, machines } = require('../server');

function post(port, body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path: '/webhook', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: raw }));
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

test('integration: unauthenticated webhook request is rejected 401', async (t) => {
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  t.after(() => server.close());

  const res = await post(port, { message: { type: 'status-update', status: 'in-progress', call: { id: 'itest-1' } } }, {});
  assert.equal(res.status, 401);
});

test('integration: authenticated webhook drives real HTTP call through check-in to closing', async (t) => {
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  t.after(() => server.close());

  const headers = { 'X-Vapi-Secret': 'integration-test-secret' };
  const callId = 'itest-2';
  const call = { id: callId, monitor: { controlUrl: 'https://example.invalid/control/itest-2' } };

  // Real fetch() to the fake controlUrl will fail (DNS/network) -- that's
  // intentional and exercises the "controlUrl failure -> no crash, logged,
  // Vapi hard timeout remains backstop" path from the isolated unit tests,
  // now through the real HTTP server.
  let res = await post(port, { message: { type: 'speech-update', role: 'assistant', status: 'started', call } }, headers);
  assert.equal(res.status, 200);
  res = await post(port, { message: { type: 'speech-update', role: 'assistant', status: 'stopped', call } }, headers);
  assert.equal(res.status, 200);

  const health1 = await get(port, '/health');
  assert.equal(health1.body.activeCalls, 1);

  await sleep(200); // idle (30ms) + wait (30ms) + margin for the failed fetch attempt

  const sm = machines.get(callId);
  assert.ok(sm, 'state machine for the call must exist');
  assert.equal(sm.state, 'CLOSING', 'must have progressed through WAITING_FOR_RESPONSE into CLOSING even though the controlUrl fetch itself fails in this sandbox');

  // Simulate Vapi reporting the call ended.
  res = await post(port, { message: { type: 'end-of-call-report', call } }, headers);
  assert.equal(res.status, 200);
  const health2 = await get(port, '/health');
  assert.equal(health2.body.activeCalls, 0);
});

test('integration: recovery works end-to-end over real HTTP', async (t) => {
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  t.after(() => server.close());

  const headers = { 'X-Vapi-Secret': 'integration-test-secret' };
  const callId = 'itest-3';
  const call = { id: callId, monitor: { controlUrl: 'https://example.invalid/control/itest-3' } };

  await post(port, { message: { type: 'speech-update', role: 'assistant', status: 'started', call } }, headers);
  await post(port, { message: { type: 'speech-update', role: 'assistant', status: 'stopped', call } }, headers);
  await sleep(45); // past the 30ms idle timer -> WAITING_FOR_RESPONSE
  let sm = machines.get(callId);
  assert.equal(sm.state, 'WAITING_FOR_RESPONSE');

  await post(port, { message: { type: 'speech-update', role: 'user', status: 'started', call } }, headers);
  sm = machines.get(callId);
  assert.equal(sm.state, 'ACTIVE', 'real customer speech-update over HTTP must trigger recovery');

  await sleep(80); // long past the original wait window
  sm = machines.get(callId);
  assert.equal(sm.state, 'ACTIVE', 'must not have closed after recovery');
});
