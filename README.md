# ca247-vapi-silence-poc

Isolated POC. Implements the CA247-backend staged silence-close state
machine described in the approved architecture: the existing, validated 5s
Vapi `customer.speech.timeout` hook is unchanged and still says
"Are you still there?" on its own. This service owns everything after that.

Sequence:
1. Vapi's 5s hook fires and speaks the check-in. This server detects that
   via `assistant.speechStarted` with `source: "force-say"`.
2. A ~5s local timer is armed for that `call.id` (`SECOND_CHANCE_MS`).
3. Genuine customer speech (`speech-update` role `customer` status
   `started`, or a `transcript` with role `user`) cancels the timer — Vapi's
   conversation continues normally, nothing else happens.
4. If the timer expires with no customer speech, this server POSTs to that
   call's `monitor.controlUrl`:
   `{ "type": "say", "content": <CLOSING_LINE>, "endCallAfterSpoken": true }`
   Vapi plays the full line and ends the call itself.
5. `silenceTimeoutSeconds` on the assistant is untouched and remains the
   only backstop if this service is slow, down, or misbehaving.

Explicitly out of scope: transfer, message-taking, appointments, prank-call
handling, or any other CA247 functionality. No connection to Telnyx, phone
numbers, Retell, or production CA247.

## Endpoints

- `POST /webhook` — Vapi Server URL target. Requires a valid signature
  (see `AUTH_MODE` in `.env.example`).
- `GET /health` — liveness + current active-call count.

## Deployment (Render)

1. New Web Service → connect this repo → Node runtime.
2. Set environment variables per `.env.example` (`WEBHOOK_SECRET` is
   required; generate a long random value and use the same value when
   configuring the Vapi Custom Credential).
3. Start command: `npm start` (or `node server.js`).
4. Confirm `GET /health` returns `{ "ok": true, ... }` once deployed.

## Required Vapi assistant configuration (separate step, not part of this repo)

On the "Emma — ABC Plumbing POC" assistant only:
- `serverUrl`: `https://<this-service>/webhook`
- `serverMessages`: at minimum `assistant.speechStarted`, `speech-update`,
  `transcript`, `status-update`, `end-of-call-report`
- `credentialId`: a Custom Credential (HMAC, SHA-256) whose secret matches
  `WEBHOOK_SECRET` here.

Do not apply this to any other assistant or to production CA247.
