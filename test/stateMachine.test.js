'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CallStateMachine, STATES } = require('../stateMachine');
const { createFakeClock } = require('./fakeClock');

function buildMachine(overrides = {}) {
  const clock = createFakeClock();
  const checkIns = [];
  const closings = [];
  const logs = [];
  let checkInBehavior = overrides.checkInBehavior || (async () => {});
  let closingBehavior = overrides.closingBehavior || (async () => {});

  const sm = new CallStateMachine('call-1', {
    idleMs: overrides.idleMs != null ? overrides.idleMs : 5000,
    waitMs: overrides.waitMs != null ? overrides.waitMs : 5000,
    controlUrl: overrides.controlUrl || 'https://example.vapi.ai/control/call-1',
    scheduleTimeout: clock.scheduleTimeout,
    clearTimeoutFn: clock.clearTimeoutFn,
    sendCheckIn: async (url) => { checkIns.push({ url, t: clock.now() }); return checkInBehavior(url); },
    sendClosing: async (url) => { closings.push({ url, t: clock.now() }); return closingBehavior(url); },
    onLog: (entry) => logs.push(entry),
  });

  return { sm, clock, checkIns, closings, logs };
}

// ---- A: Continuous silence -> exactly one check-in, exactly one closing ----
test('A - continuous silence: exactly one check-in then exactly one closing', async () => {
  const { sm, clock, checkIns, closings } = buildMachine();
  sm.onAssistantSpeechStarted(); // greeting starts
  sm.onAssistantSpeechStopped(); // greeting ends -> idle timer armed
  await clock.advance(5000); // idle timer fires -> check-in sent, wait timer armed
  assert.equal(checkIns.length, 1);
  assert.equal(sm.state, STATES.WAITING_FOR_RESPONSE);
  await clock.advance(5000); // wait timer fires -> closing sent
  assert.equal(closings.length, 1);
  assert.equal(sm.state, STATES.CLOSING);
  sm.onCallEnded('status-update:ended');
  assert.equal(sm.state, STATES.ENDED);
  assert.equal(clock.pendingCount(), 0);
});

// ---- B: Recovery -- caller speaks during wait, pending close cancelled ----
test('B - recovery: customer speech during wait cancels close, returns to ACTIVE, no stale close later', async () => {
  const { sm, clock, checkIns, closings } = buildMachine();
  sm.onAssistantSpeechStarted();
  sm.onAssistantSpeechStopped();
  await clock.advance(5000);
  assert.equal(checkIns.length, 1);
  assert.equal(sm.state, STATES.WAITING_FOR_RESPONSE);

  sm.onCustomerSpeech(); // caller responds
  assert.equal(sm.state, STATES.ACTIVE);

  // Let a long time pass -- the old wait timer must never fire a stale close.
  await clock.advance(60000);
  assert.equal(closings.length, 0, 'no closing must ever fire from the cancelled wait timer');
});

// ---- C: Second silence episode after recovery gets a fresh check-in/window ----
test('C - second silence episode: fresh check-in and fresh wait window', async () => {
  const { sm, clock, checkIns, closings } = buildMachine();
  sm.onAssistantSpeechStarted();
  sm.onAssistantSpeechStopped();
  await clock.advance(5000);
  sm.onCustomerSpeech(); // recovery
  assert.equal(sm.state, STATES.ACTIVE);

  // Assistant replies, then finishes -- new idle window begins.
  sm.onAssistantSpeechStarted();
  sm.onAssistantSpeechStopped();
  await clock.advance(5000);
  assert.equal(checkIns.length, 2, 'second episode must produce its own check-in');
  assert.equal(sm.state, STATES.WAITING_FOR_RESPONSE);

  await clock.advance(5000);
  assert.equal(closings.length, 1);
});

// ---- D: Late save / race -- speech immediately before expiry wins, deterministically ----
test('D - late save: customer speech 1ms before wait-timer expiry keeps call active', async () => {
  const { sm, clock, checkIns, closings } = buildMachine();
  sm.onAssistantSpeechStarted();
  sm.onAssistantSpeechStopped();
  await clock.advance(5000);
  assert.equal(checkIns.length, 1);

  await clock.advance(4999); // 1ms before the 5000ms wait timer would fire
  sm.onCustomerSpeech();
  assert.equal(sm.state, STATES.ACTIVE, 'customer speech must win deterministically, not by luck');

  await clock.advance(1); // now cross the original expiry instant
  assert.equal(closings.length, 0, 'closing must not fire once recovery has happened, regardless of original expiry timing');
});

// ---- E: Duplicate webhook -- same triggering event delivered twice ----
test('E - duplicate webhook delivery of the stop event: exactly one check-in armed/sent', async () => {
  const { sm, clock, checkIns } = buildMachine();
  sm.onAssistantSpeechStarted();
  sm.onAssistantSpeechStopped();
  sm.onAssistantSpeechStopped(); // duplicate delivery of the same logical event
  await clock.advance(5000);
  assert.equal(checkIns.length, 1, 'duplicate stop events must not produce duplicate check-ins');
});

// ---- F: Duplicate customer-speech event -- idempotent cancellation ----
test('F - duplicate customer-speech event during wait: exactly one recovery, no errors', async () => {
  const { sm, clock, checkIns } = buildMachine();
  sm.onAssistantSpeechStarted();
  sm.onAssistantSpeechStopped();
  await clock.advance(5000);
  assert.equal(checkIns.length, 1);

  assert.doesNotThrow(() => {
    sm.onCustomerSpeech();
    sm.onCustomerSpeech(); // duplicate
  });
  assert.equal(sm.state, STATES.ACTIVE);
});

// ---- G: Stale timer callback after call returned to ACTIVE does nothing ----
test('G - stale idle-timer callback (old generation) after recovery is a no-op', async () => {
  const { sm, clock, checkIns } = buildMachine();
  sm.onAssistantSpeechStarted();
  sm.onAssistantSpeechStopped();
  await clock.advance(5000);
  assert.equal(checkIns.length, 1);
  sm.onCustomerSpeech(); // recovery -> ACTIVE, generation has moved on
  const staleGen = sm.generation - 5; // simulate an old, already-superseded generation
  await sm._onIdleTimerFired(staleGen);
  assert.equal(checkIns.length, 1, 'stale idle-timer callback must not produce a second check-in');
  assert.equal(sm.state, STATES.ACTIVE);
});

// ---- H: Duplicate timer callback -- exactly one closing ----
test('H - duplicate wait-timer callback: exactly one closing', async () => {
  const { sm, clock, closings } = buildMachine();
  sm.onAssistantSpeechStarted();
  sm.onAssistantSpeechStopped();
  await clock.advance(5000);
  await clock.advance(5000);
  assert.equal(closings.length, 1);
  const gen = sm.generation;
  await sm._onWaitTimerFired(gen); // duplicate callback, same generation, but state is now CLOSING not WAITING_FOR_RESPONSE
  assert.equal(closings.length, 1, 'a duplicate wait-timer callback must not produce a second closing');
});

// ---- I: controlUrl failure -- no retry storm, backstop remains ----
test('I - controlUrl failure on closing: no retries, logs the fallback, does not throw', async () => {
  const { sm, clock, closings, logs } = buildMachine({
    closingBehavior: async () => { throw new Error('simulated 5xx'); },
  });
  sm.onAssistantSpeechStarted();
  sm.onAssistantSpeechStopped();
  await clock.advance(5000);
  await assert.doesNotReject(clock.advance(5000));
  assert.equal(closings.length, 1, 'exactly one attempt -- no automatic retry storm');
  assert.equal(sm.state, STATES.CLOSING);
  assert.ok(logs.some((l) => l.event === 'closing.send_error'));
  assert.ok(logs.some((l) => l.event === 'closing.fallback_to_vapi_hard_timeout'));
});

// ---- J: Concurrent calls -- no cross-call leakage ----
test('J - concurrent calls: silent call A and active call B never affect each other', async () => {
  const a = buildMachine();
  const b = buildMachine();

  a.sm.onAssistantSpeechStarted();
  a.sm.onAssistantSpeechStopped(); // A goes idle

  b.sm.onAssistantSpeechStarted();
  b.sm.onAssistantSpeechStopped();
  b.sm.onCustomerSpeech(); // B stays active (customer engaged)

  await a.clock.advance(5000);
  await b.clock.advance(5000);

  assert.equal(a.checkIns.length, 1, 'silent call A must get its check-in');
  assert.equal(b.checkIns.length, 0, 'active call B must not be touched by A\'s timers');
  assert.equal(a.sm.callId, 'call-1');
  assert.equal(b.sm.callId, 'call-1'); // same default id on purpose -- proves isolation is per-instance, not keyed by id alone
  assert.notEqual(a.sm, b.sm);
});

// ---- K: Repeated silence episodes -- no accumulated stale timers ----
test('K - repeated silence/recovery cycles: no timer accumulation', async () => {
  const { sm, clock, checkIns } = buildMachine();
  for (let i = 0; i < 5; i += 1) {
    sm.onAssistantSpeechStarted();
    sm.onAssistantSpeechStopped();
    await clock.advance(5000);
    sm.onCustomerSpeech();
    assert.ok(clock.pendingCount() <= 1, `pending timers must stay bounded after cycle ${i}`);
  }
  assert.equal(checkIns.length, 5);
  assert.equal(clock.pendingCount(), 0);
});

// ---- L: Call ends while a timer is pending -- cleaned up ----
test('L - call ends while idle timer pending: timers cleaned up, no late actions', async () => {
  const { sm, clock, checkIns, closings } = buildMachine();
  sm.onAssistantSpeechStarted();
  sm.onAssistantSpeechStopped(); // idle timer pending
  assert.equal(clock.pendingCount(), 1);
  sm.onCallEnded('end-of-call-report');
  assert.equal(clock.pendingCount(), 0);
  assert.equal(sm.state, STATES.ENDED);
  await clock.advance(60000);
  assert.equal(checkIns.length, 0);
  assert.equal(closings.length, 0);
});

test('L2 - call ends while wait timer pending: timers cleaned up, no late closing', async () => {
  const { sm, clock, closings } = buildMachine();
  sm.onAssistantSpeechStarted();
  sm.onAssistantSpeechStopped();
  await clock.advance(5000); // now WAITING_FOR_RESPONSE, wait timer pending
  assert.equal(clock.pendingCount(), 1);
  sm.onCallEnded('status-update:ended');
  assert.equal(clock.pendingCount(), 0);
  await clock.advance(60000);
  assert.equal(closings.length, 0);
});
