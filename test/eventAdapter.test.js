'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, dispatch } = require('../eventAdapter');
const { CallStateMachine, STATES } = require('../stateMachine');
const { createFakeClock } = require('./fakeClock');

/**
 * Regression fixtures: these are the ACTUAL webhook message shapes captured
 * from Render's live logs for the two failed 2026-08-26 test calls
 * (01a03c99-5794-7000-800e-3425a051e21c and 01a03c9a-577b-7004-be4f-787986912ccd),
 * not assumed/documented shapes. Every field name and value here was copied
 * verbatim from the structured JSON log lines Vapi actually sent.
 */

const REAL_HOOK_SPEECH_STARTED = { type: 'speech-update', role: 'assistant', status: 'started' };
const REAL_HOOK_SPEECH_STOPPED = { type: 'speech-update', role: 'assistant', status: 'stopped' };
const REAL_CUSTOMER_SPEECH_UPDATE = { type: 'speech-update', role: 'user', status: 'started' };
const REAL_MODEL_SPEECH_STARTED_EVENT = { type: 'assistant.speechStarted', source: 'model' };
const OLD_ASSUMED_HOOK_EVENT_NEVER_OBSERVED = { type: 'assistant.speechStarted', source: 'force-say' };

test('regression: real hook-triggered speech-update (role=assistant) is classified as assistant speech, not ignored', () => {
  assert.deepEqual(classify(REAL_HOOK_SPEECH_STARTED), { kind: 'assistant_speech_started' });
  assert.deepEqual(classify(REAL_HOOK_SPEECH_STOPPED), { kind: 'assistant_speech_stopped' });
});

test('regression: real customer speech-update uses role "user", not "customer" -- must be classified as customer_speech', () => {
  const result = classify(REAL_CUSTOMER_SPEECH_UPDATE);
  assert.equal(result.kind, 'customer_speech', 'the old implementation checked role === "customer" and would have classified this as ignored');
});

test('regression: assistant.speechStarted with source="model" (real, observed) is ignored, not mistaken for a check-in', () => {
  assert.equal(classify(REAL_MODEL_SPEECH_STARTED_EVENT).kind, 'ignored');
});

test('regression: the old detection condition (source="force-say") never occurred in production and the new adapter does not depend on it', () => {
  // This exact message was never observed in either failed call's Render logs.
  // The adapter must not special-case it -- speech-update is now the sole
  // signal for assistant turn-taking, so this event type is correctly ignored.
  assert.equal(classify(OLD_ASSUMED_HOOK_EVENT_NEVER_OBSERVED).kind, 'ignored');
});

test('regression: end-to-end replay of call 01a03c99 event sequence now produces a check-in and a closing', async () => {
  // Replays the real speech-update sequence observed for call
  // 01a03c99-5794-7000-800e-3425a051e21c: greeting starts/stops, then two
  // back-to-back hook speech-update cycles (the observed "doubling"), then
  // silence until the call was hard-timed-out by Vapi at 39s with NO closing
  // line ever heard. With the new adapter/state machine, the check-in fires
  // once (idempotent -- second stop event is a duplicate of the same logical
  // turn-taking edge) and, since no customer speech ever arrives, a closing
  // is sent -- the exact gap that caused the real-world failure.
  const clock = createFakeClock();
  const checkIns = [];
  const closings = [];
  const sm = new CallStateMachine('01a03c99-5794-7000-800e-3425a051e21c', {
    idleMs: 5000,
    waitMs: 5000,
    controlUrl: 'https://phone-call-websocket.example/control/01a03c99',
    scheduleTimeout: clock.scheduleTimeout,
    clearTimeoutFn: clock.clearTimeoutFn,
    sendCheckIn: async (url) => { checkIns.push(url); },
    sendClosing: async (url) => { closings.push(url); },
    onLog: () => {},
  });

  dispatch(sm, { type: 'speech-update', role: 'assistant', status: 'started' }); // greeting starts
  dispatch(sm, { type: 'speech-update', role: 'assistant', status: 'stopped' }); // greeting ends -> idle timer armed
  await clock.advance(5000); // -> check-in sent (this is the gap that was silent in production)
  assert.equal(checkIns.length, 1);
  assert.equal(sm.state, STATES.WAITING_FOR_RESPONSE);

  // No customer speech ever arrives in the real call.
  await clock.advance(5000); // wait window expires -> closing sent
  assert.equal(closings.length, 1, 'the professional closing line that was never heard in production must now be sent');
  assert.equal(sm.state, STATES.CLOSING);
});

test('regression: end-to-end replay of call 01a03c9a event sequence -- recovery works, second silence still closes gracefully', async () => {
  const clock = createFakeClock();
  const checkIns = [];
  const closings = [];
  const sm = new CallStateMachine('01a03c9a-577b-7004-be4f-787986912ccd', {
    idleMs: 5000,
    waitMs: 5000,
    scheduleTimeout: clock.scheduleTimeout,
    clearTimeoutFn: clock.clearTimeoutFn,
    sendCheckIn: async (url) => { checkIns.push(url); },
    sendClosing: async (url) => { closings.push(url); },
    onLog: () => {},
  });

  dispatch(sm, { type: 'speech-update', role: 'assistant', status: 'started' });
  dispatch(sm, { type: 'speech-update', role: 'assistant', status: 'stopped' });
  await clock.advance(5000);
  assert.equal(checkIns.length, 1);

  // Caller responded "Good morning." in the real call.
  dispatch(sm, { type: 'speech-update', role: 'user', status: 'started' });
  assert.equal(sm.state, STATES.ACTIVE, 'the real customer response must now be correctly recognized as recovery');

  // Assistant asked a follow-up question, then the caller went silent again.
  dispatch(sm, { type: 'speech-update', role: 'assistant', status: 'started' });
  dispatch(sm, { type: 'speech-update', role: 'assistant', status: 'stopped' });
  await clock.advance(5000);
  assert.equal(checkIns.length, 2, 'the second silence episode must get its own check-in');
  await clock.advance(5000);
  assert.equal(closings.length, 1, 'the professional closing that was never heard must now be sent for the second episode too');
});
