'use strict';

/**
 * CA247 -- Vapi webhook message -> state-machine event adapter.
 *
 * This is the ONLY place raw Vapi payload shapes are interpreted. It exists
 * so production (server.js) and the automated test suite exercise the exact
 * same classification logic (engineering gate requirement: "Refactor if
 * necessary so the production event handlers and automated tests share the
 * exact same logic").
 *
 * Field mappings below are verified against real webhook payloads captured
 * in Render logs for calls 01a03c99-5794-7000-800e-3425a051e21c and
 * 01a03c9a-577b-7004-be4f-787986912ccd on 2026-08-26, NOT assumed from
 * documentation. Specifically:
 *   - `speech-update` events use role "assistant" or "user" (NOT "customer" --
 *     the previous implementation checked for "customer" and could never match).
 *   - Vapi-native hook-triggered speech (the "Are you still there?" customer.
 *     speech.timeout hook) never produced an `assistant.speechStarted` event
 *     with `source: "force-say"` in either observed call -- only generic
 *     `speech-update` events with no `source` field at all. `assistant.
 *     speechStarted` events with `source: "model"` DID appear, but only for
 *     the model's own normal conversational replies, and fire many times per
 *     utterance (once per streamed chunk) with no corresponding "stopped"
 *     event -- unusable as a start/stop signal.
 *   - `speech-update` reliably provides exactly one started + one stopped
 *     event per logical utterance (assistant or user side), which is why the
 *     state machine is driven by `speech-update` exclusively for turn-taking,
 *     with `transcript` (role "user") kept only as a redundant safety net for
 *     detecting customer speech.
 */

function classify(message) {
  if (!message || typeof message !== 'object') return null;

  if (message.type === 'end-of-call-report') {
    return { kind: 'call_ended', reason: 'end-of-call-report' };
  }
  if (message.type === 'status-update' && message.status === 'ended') {
    return { kind: 'call_ended', reason: 'status-update:ended' };
  }

  if (message.type === 'speech-update') {
    const role = message.role;
    const status = message.status;
    if (role === 'assistant' && status === 'started') return { kind: 'assistant_speech_started' };
    if (role === 'assistant' && status === 'stopped') return { kind: 'assistant_speech_stopped' };
    // Accept both "user" (confirmed real value) and "customer" (originally
    // assumed value) defensively -- either indicates the same logical event.
    if ((role === 'user' || role === 'customer') && status === 'started') {
      return { kind: 'customer_speech' };
    }
    return { kind: 'ignored' };
  }

  if (message.type === 'transcript') {
    if (message.role === 'user' && message.transcript) {
      return { kind: 'customer_speech', via: 'transcript' };
    }
    return { kind: 'ignored' };
  }

  // assistant.speechStarted and any other subscribed-but-unused event types
  // are intentionally NOT load-bearing in the new design. Kept classified as
  // 'ignored' rather than removed from the switch so the intent is explicit.
  return { kind: 'ignored' };
}

function extractCall(message, body) {
  const call = (message && message.call) || (body && body.call) || {};
  const callId = call.id || null;
  const controlUrl = (call.monitor && call.monitor.controlUrl) || null;
  return { callId, controlUrl };
}

/**
 * Applies a classified Vapi message to a CallStateMachine instance.
 * Returns the classification for logging purposes.
 */
function dispatch(stateMachine, message) {
  const classification = classify(message);
  switch (classification.kind) {
    case 'assistant_speech_started':
      stateMachine.onAssistantSpeechStarted();
      break;
    case 'assistant_speech_stopped':
      stateMachine.onAssistantSpeechStopped();
      break;
    case 'customer_speech':
      stateMachine.onCustomerSpeech();
      break;
    case 'call_ended':
      stateMachine.onCallEnded(classification.reason);
      break;
    default:
      break;
  }
  return classification;
}

module.exports = { classify, extractCall, dispatch };
