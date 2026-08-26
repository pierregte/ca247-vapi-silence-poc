'use strict';

/**
 * CA247 -- deterministic per-call idle/close state machine.
 *
 * Rebuilt after the 2026-08-26 engineering gate forensic finding: the previous
 * implementation detected the Vapi-native "Are you still there?" hook by
 * matching `assistant.speechStarted` events with `source === 'force-say'`.
 * Real production webhook traffic (captured from Render logs for calls
 * 01a03c99-5794-7000-800e-3425a051e21c and 01a03c9a-577b-7004-be4f-787986912ccd)
 * proves Vapi never sends that event/source combination for hook-triggered
 * speech -- only `speech-update` events, with no `source` field at all. The old
 * detection condition could therefore never be true, the timer was never armed,
 * and every call fell through to Vapi's native `silenceTimeoutSeconds` hard
 * backstop with no graceful closing line -- exactly matching the two reported
 * failures. A second, independent bug was found in the same audit: the
 * customer-speech detector checked `role === 'customer'` on `speech-update`
 * events, but real payloads use `role === 'user'` for that event type -- so
 * even the "customer spoke, cancel the timer" recovery path could never have
 * fired correctly either.
 *
 * New design: CA247 no longer depends on Vapi's native customer.speech.timeout
 * hook or on matching any assistant speech text. CA247 owns the idle timer and
 * the check-in decision itself, driven purely by generic `speech-update`
 * started/stopped edges (role: assistant | user) and `transcript` events
 * (role: user) as a redundant safety net. No business-state decision depends
 * on matching spoken/transcribed text content, and no LLM is involved in any
 * state transition.
 *
 * State machine:
 *   ACTIVE -> (idle timer fires) -> WAITING_FOR_RESPONSE
 *   WAITING_FOR_RESPONSE -> (customer speech) -> ACTIVE            [recovery]
 *   WAITING_FOR_RESPONSE -> (wait timer fires) -> CLOSING
 *   any -> ENDED  [on end-of-call-report / status-update:ended]
 *
 * Idempotency: every timer arm increments a per-call `generation` counter.
 * A timer callback is honored only if (a) the call is still in the exact
 * state that timer was armed for, and (b) the generation captured at arm
 * time still matches the call's current generation. Any stale, duplicate,
 * or late-firing callback is therefore a guaranteed no-op -- this covers
 * duplicate webhook delivery, duplicate timer callbacks, and callbacks that
 * outlive a state change (e.g. recovery, or an already-active new episode).
 */

const STATES = Object.freeze({
  ACTIVE: 'ACTIVE',
  WAITING_FOR_RESPONSE: 'WAITING_FOR_RESPONSE',
  CLOSING: 'CLOSING',
  ENDED: 'ENDED',
});

class CallStateMachine {
  constructor(callId, opts = {}) {
    this.callId = callId;
    this.state = STATES.ACTIVE;
    this.generation = 0;
    this.idleTimer = null;
    this.waitTimer = null;
    this.controlUrl = opts.controlUrl || null;

    this.idleMs = opts.idleMs != null ? opts.idleMs : 5000;
    this.waitMs = opts.waitMs != null ? opts.waitMs : 5000;

    this.scheduleTimeout = opts.scheduleTimeout || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = opts.clearTimeoutFn || clearTimeout;
    this.sendCheckIn = opts.sendCheckIn || (async () => {});
    this.sendClosing = opts.sendClosing || (async () => {});
    this.onLog = opts.onLog || (() => {});
  }

  _log(event, extra) {
    this.onLog({
      callId: this.callId,
      state: this.state,
      generation: this.generation,
      event,
      ts: new Date().toISOString(),
      ...extra,
    });
  }

  setControlUrl(url) {
    if (url) this.controlUrl = url;
  }

  _clearIdleTimer() {
    if (this.idleTimer) {
      this.clearTimeoutFn(this.idleTimer);
      this.idleTimer = null;
    }
  }

  _clearWaitTimer() {
    if (this.waitTimer) {
      this.clearTimeoutFn(this.waitTimer);
      this.waitTimer = null;
    }
  }

  _clearAllTimers() {
    this._clearIdleTimer();
    this._clearWaitTimer();
  }

  _armIdleTimer(reason) {
    this._clearIdleTimer();
    this.generation += 1;
    const gen = this.generation;
    this._log('idle_timer.armed', { reason, timerGen: gen, idleMs: this.idleMs });
    this.idleTimer = this.scheduleTimeout(() => this._onIdleTimerFired(gen), this.idleMs);
  }

  _armWaitTimer(reason) {
    this._clearWaitTimer();
    this.generation += 1;
    const gen = this.generation;
    this._log('wait_timer.armed', { reason, timerGen: gen, waitMs: this.waitMs });
    this.waitTimer = this.scheduleTimeout(() => this._onWaitTimerFired(gen), this.waitMs);
  }

  _transition(to, trigger) {
    const from = this.state;
    this.state = to;
    this._log('state.transition', { from, to, trigger });
  }

  // ---- Public event entry points (called from the webhook adapter) ----

  onAssistantSpeechStarted() {
    if (this.state === STATES.ENDED) return;
    if (this.state === STATES.ACTIVE) {
      this._clearIdleTimer();
      this._log('assistant_speech.started', {});
    }
    // WAITING_FOR_RESPONSE / CLOSING: ignore. Our own check-in/closing "say"
    // commands also produce assistant speech-update events; the wait window
    // is a fixed duration from when we issued the command, independent of
    // this event, by design (see _onIdleTimerFired / _onWaitTimerFired).
  }

  onAssistantSpeechStopped() {
    if (this.state === STATES.ENDED) return;
    if (this.state === STATES.ACTIVE) {
      this._log('assistant_speech.stopped', {});
      this._armIdleTimer('assistant_speech_stopped');
    }
  }

  onCustomerSpeech() {
    if (this.state === STATES.ENDED) return;
    if (this.state === STATES.ACTIVE) {
      this._log('customer_speech.detected', { note: 'idle timer reset' });
      this._clearIdleTimer();
      return;
    }
    if (this.state === STATES.WAITING_FOR_RESPONSE) {
      this._log('customer_speech.detected_during_wait', { note: 'recovery' });
      this._clearWaitTimer();
      this._transition(STATES.ACTIVE, 'customer_speech_recovery');
      return;
    }
    // CLOSING / already past the decision point: intentionally ignored.
    this._log('customer_speech.ignored', { reason: `state=${this.state}` });
  }

  onCallEnded(reason) {
    this._clearAllTimers();
    if (this.state !== STATES.ENDED) this._transition(STATES.ENDED, reason || 'call_ended');
  }

  async _onIdleTimerFired(gen) {
    if (this.state !== STATES.ACTIVE || gen !== this.generation) {
      this._log('idle_timer.stale_ignored', { timerGen: gen, currentState: this.state, currentGeneration: this.generation });
      return;
    }
    this._transition(STATES.WAITING_FOR_RESPONSE, 'idle_timer_fired');
    try {
      await this.sendCheckIn(this.controlUrl);
      this._log('checkin.sent', {});
    } catch (err) {
      this._log('checkin.send_error', { error: String(err) });
    }
    if (this.state === STATES.WAITING_FOR_RESPONSE) {
      this._armWaitTimer('checkin_sent');
    }
  }

  async _onWaitTimerFired(gen) {
    if (this.state !== STATES.WAITING_FOR_RESPONSE || gen !== this.generation) {
      this._log('wait_timer.stale_ignored', { timerGen: gen, currentState: this.state, currentGeneration: this.generation });
      return;
    }
    this._transition(STATES.CLOSING, 'wait_timer_fired');
    try {
      await this.sendClosing(this.controlUrl);
      this._log('closing.sent', {});
    } catch (err) {
      this._log('closing.send_error', { error: String(err) });
      this._log('closing.fallback_to_vapi_hard_timeout', {});
    }
  }
}

module.exports = { CallStateMachine, STATES };
