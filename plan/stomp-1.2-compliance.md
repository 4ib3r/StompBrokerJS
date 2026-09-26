# STOMP 1.2 compliance check

Implementation checked: `claude/project-worst-practices-ye8za2` at `725189c`
(master after steps 1–4 plus step 5a). Specification:
[STOMP 1.2](https://stomp.github.io/stomp-specification-1.2.html)
(source: `stomp/stomp-spec`, `src/stomp-specification-1.2.md`).

## Summary

- The broker speaks **STOMP 1.0 and 1.1** and negotiates at most 1.1
  (`SUPPORTED_VERSIONS` in `lib/stomp.js`). A client offering
  `1.0,1.1,1.2` gets 1.1, which the negotiation rules allow; a client offering
  only `1.2` is rejected. So the broker is not a STOMP 1.2 server yet.
- Most 1.2 requirements that also exist in 1.1 are met: framing, `content-length`,
  repeated headers, no trimming, size limits, ERROR-then-close, receipts,
  transactions, heart-beats, subscription and transaction id scope.
- **Four gaps block 1.2 support**:
  1. 1.2 can't be negotiated.
  2. Carriage returns in header values aren't escaped on output or accepted on input.
  3. MESSAGE frames have no `ack` header for client-ack subscriptions.
  4. ACK and NACK use the 1.1 headers instead of `id`.

  See [G1–G4](#gaps-for-stomp-12).
- **One bug independent of the version:** a frame received before the client
  disconnected is dropped when its async middleware finishes after DISCONNECT
  or the close. The spec says such frames SHOULD still be processed. See
  [B1](#b1-frames-received-before-a-disconnect-are-dropped), which I reproduced.
- **Deliberate deviations** are listed under [D1–D5](#deliberate-deviations).

Legend: ✅ compliant · ⚠️ deviation (SHOULD / lenient / equivalent) ·
❌ not compliant · — not applicable.

## Conformance matrix

| Spec section | Requirement | Level | Status | Where / notes |
|---|---|---|---|---|
| STOMP Frames | EOL is optional CR + LF; NULL may be followed by EOLs | MUST | ✅ | `lib/parser.js`: CRLF is accepted for every version, and EOLs between frames count as heart-beats |
| | Commands and header names are case sensitive | MUST | ✅ | commands must match `^[A-Z]+$`, unknown commands get ERROR |
| Value Encoding | CONNECT and CONNECTED are not escaped, all other frames are | MUST | ⚠️ | `STOMP` frames are also left unescaped, like CONNECT ([D2](#deliberate-deviations)) |
| | Decode `\r` `\n` `\c` `\\` | MUST | ⚠️ | all four are decoded, but a decoded CR is then rejected ([G2](#g2-carriage-return-in-headers)) |
| | Undefined escapes (e.g. `\t`) are a fatal error | MUST | ⚠️ | kept verbatim on purpose ([D1](#deliberate-deviations)) |
| | Encode headers with the reverse transformation | MUST | ❌ (1.2) | `\n`, `:` and `\` are escaped; a header containing CR is left out instead of escaped as `\r` ([G2](#g2-carriage-return-in-headers)) |
| | Never trim or pad headers | MUST | ✅ | since step 2 |
| Body | Only SEND, MESSAGE and ERROR have a body | MUST (sender) | ✅ / ⚠️ | the server's own frames comply. A body on a client SUBSCRIBE etc. is silently ignored, not rejected; that is lenient and allowed |
| content-length | Read exactly that many octets, then NUL | MUST | ✅ | ERROR if the NUL is missing |
| | Frames whose body contains NUL MUST have content-length; SEND, MESSAGE and ERROR SHOULD | MUST / SHOULD | ✅ | MESSAGE and ERROR always carry it |
| content-type | MESSAGE and ERROR SHOULD carry it | SHOULD | ✅ / ⚠️ | ERROR uses `text/plain`; MESSAGE carries the sender's `content-type` if there was one |
| receipt | Every client frame except CONNECT may request a RECEIPT | — | ✅ | SEND, SUBSCRIBE, UNSUBSCRIBE, BEGIN, COMMIT, ABORT, ACK, NACK, DISCONNECT |
| Repeated headers | The first entry wins | SHOULD | ✅ | `lib/parser.js` |
| Size limits | On limit, send ERROR then close | SHOULD | ✅ / ⚠️ | ERROR plus close from the decoder. A single WebSocket message above ws's `maxPayload` makes ws close the connection itself, without an ERROR ([D5](#deliberate-deviations)) |
| Connection lingering | Support clients that connect and disconnect rapidly | — | ✅ | the RECEIPT or ERROR is written before `close()` (ws flushes before the close frame) |
| Connecting | Rejecting a connection: send ERROR, then close | SHOULD | ✅ | |
| CONNECT or STOMP | Handle STOMP exactly like CONNECT | MUST | ✅ | |
| | `host` header | MUST (client) | — | ignored, since there are no virtual hosts; the spec allows that |
| CONNECTED | `version` | MUST | ✅ | |
| | `server` is `name/version` | MAY | ✅ | `STOMP-JS/<version>` |
| | `heart-beat` is the server's `<sx>,<sy>` | — | ⚠️ | the negotiated values are sent instead; the client ends up with the same result ([D3](#deliberate-deviations)) |
| Protocol negotiation | No `accept-version` means 1.0; use the highest common version | MUST | ✅ | |
| | No common version: ERROR "similar to" the example, then close | MUST | ⚠️ | ERROR plus close happen, but the ERROR has no `version` header listing the supported versions ([G5](#g5-version-header-on-negotiation-error)) |
| | Support 1.2 | — | ❌ | [G1](#g1-negotiate-12) |
| Heart-beating | Two integers; missing means `0,0` | MUST | ✅ | malformed values get ERROR |
| | Interval is MAX of the two sides; 0 disables | MUST | ✅ | capped at 2³¹−1 ms, the conformance section allows implementation limits |
| | Send EOL at least every *n* ms; any data counts as a heart-beat; tolerate lateness | MUST / SHOULD | ✅ | `heartbeatErrorMargin` sets the tolerance |
| Client frames | Unknown frame: MAY answer ERROR and close | MAY | ✅ | since step 3 |
| SEND | `destination` required | MUST | ✅ | missing gets ERROR `Destination is required` |
| | User headers passed through to MESSAGE | MUST | ✅ | only protocol headers are dropped (`receipt`, `transaction`, `content-length`, `destination`, `subscription`, `message-id`); the broker sets its own |
| | Cannot process: ERROR, then close | MUST | ✅ | since step 3 |
| SUBSCRIBE | `destination` and `id` required; ids unique per connection | MUST | ✅ | STOMP 1.0 clients may leave out the id (the destination is used) |
| | `ack` is one of `auto`, `client`, `client-individual` (default `auto`) | — | ✅ | validated, but the mode isn't stored ([G3](#g3-ack-header-on-message)) |
| | Cannot create: ERROR, then close | MUST | ✅ | |
| | client / client-individual: MAY redeliver unacknowledged messages | MAY | ✅ | at-most-once delivery, documented (decision in step 4) |
| UNSUBSCRIBE | `id` required and must match a subscription | MUST | ✅ / ⚠️ | an unknown or missing id gets ERROR; a missing id reads "No subscription undefined" |
| ACK / NACK | `id` required, matching the MESSAGE `ack` header; `transaction` optional | MUST | ❌ (1.2) | the 1.1 headers (`subscription` plus `message-id`) are required instead ([G4](#g4-ack--nack-id-header)) |
| BEGIN / COMMIT / ABORT | `transaction` required; unique per connection; uncommitted transactions aborted on DISCONNECT or connection failure | MUST | ✅ | step 4 |
| DISCONNECT | RECEIPT, then close; the client sends nothing after it | — | ✅ | frames after DISCONNECT are ignored |
| MESSAGE | `destination` (same as in SEND), unique `message-id`, `subscription` | MUST | ✅ | |
| | `ack` header for client / client-individual subscriptions | MUST | ❌ (1.2) | [G3](#g3-ack-header-on-message) |
| | User headers included | — | ✅ | |
| RECEIPT | `receipt-id`; sent after the frame is processed | MUST | ✅ | answered after middleware finishes |
| | Previously received frames SHOULD still be processed if the client disconnects | SHOULD | ❌ | [B1](#b1-frames-received-before-a-disconnect-are-dropped) |
| ERROR | Close right after ERROR | MUST | ✅ | since step 3 |
| | `message` header; `receipt-id` when the failing frame had a receipt | SHOULD | ✅ | not possible for frames the decoder rejects, because they were never parsed |
| BNF | Header name is at least one octet | MUST | ✅ | an empty name gets ERROR |
| | No raw `:` in header values | — | ⚠️ | raw colons in values are accepted: the line is split at the first colon. Lenient on purpose (STOMP 1.0 clients) |

## Bug

### B1 Frames received before a disconnect are dropped

The spec, under RECEIPT, says: *"If the client disconnects, previously
received frames SHOULD continue to get processed by the server."*

Step 3 added a guard so that a command whose async middleware finishes after
the connection ended no longer takes effect (`Session#isActive()` in
`onSend`, `onSubscribe`, `onBegin`, `onCommit`, `onAbort`, `onAck`/`onNack`).
That guard is right for SUBSCRIBE, because a subscription for a closed
connection is useless. It is wrong for SEND.

Reproduced as follows:
1. Async `send` middleware delays 50 ms.
2. The client sends `SEND` and then `DISCONNECT` with a receipt.
3. The client gets the RECEIPT.
4. The subscriber never receives the message: the state became DISCONNECTING before the middleware finished, so `onSend` returns false.

The same happens when the socket closes after the SEND was received.

**Fix:** only guard the commands whose effect belongs to the connection
(SUBSCRIBE, BEGIN, ACK/NACK). A non-transactional SEND that was received
before DISCONNECT or close is still delivered.

For COMMIT, the transaction was implicitly aborted on disconnect, so there is
nothing left to deliver, which matches "implicitly aborted if … DISCONNECT".
Also, a DISCONNECT RECEIPT should only be sent once all previously received
frames have been processed. The client uses that RECEIPT as its "safe to close"
signal. To guarantee this, add a per-session queue of pending commands; the
DISCONNECT then waits for the queue to drain.

## Gaps for STOMP 1.2

### G1 Negotiate 1.2

Add `'1.2'` to `SUPPORTED_VERSIONS` once G2–G4 are in place. Everything else
1.2 changes is already handled: CRLF line endings, repeated headers,
`content-length`/`content-type`, the STOMP frame, connection lingering, id
scopes and RECEIPT semantics.

### G2 Carriage return in headers

- **Decode:** for a 1.2 session, `\r` decodes to CR and is a valid header
  value. Today the decoder rejects any CR after unescaping.
  - Keep rejecting raw CR inside a header line: there it can only be a
    malformed EOL.
  - Keep rejecting a decoded CR in 1.1 sessions, where `\r` is not defined.
- **Encode:** for 1.2 subscribers, escape CR as `\r` instead of leaving the
  header out. Senders on 1.1 can't produce a CR anyway.

### G3 `ack` header on MESSAGE

- Store the subscription's `ack` mode; today it is validated and then
  discarded in `onSubscribe`.
- For `client` and `client-individual` subscriptions of 1.2 sessions, add an
  `ack` header to each MESSAGE. The value is arbitrary, for example the
  `message-id`.
- `MessageTemplate.render` gains an optional `ack` value next to
  `subscription`.

### G4 ACK / NACK `id` header

For 1.2 sessions, ACK and NACK require `id` (the MESSAGE's `ack` value) instead
of `subscription` plus `message-id`. With at-most-once delivery the check can
stay light: `id` is required and passed to `ack`/`nack` middleware as
`{id, transaction}`.

To reject ids that were never sent, track outstanding ack ids per session.
Bound that set by count, because nothing is ever redelivered.

### G5 `version` header on negotiation error

The example ERROR carries `version:<supported versions>`. Add
`version: '1.0,1.1,1.2'` to the "Supported protocol versions" ERROR, and put
the supported versions in the body, as in the example.

## Deliberate deviations

These are allowed by the spec or chosen on purpose; each is documented here
so it isn't mistaken for an oversight.

| # | Deviation | Why |
|---|---|---|
| D1 | Undefined escape sequences are kept verbatim instead of treated as fatal | stompjs 2.x doesn't escape header values at all, so a value like `C:\temp` would close the connection. Could become fatal for 1.2 sessions only, where clients are known to escape |
| D2 | `STOMP` frames are decoded without unescaping, like CONNECT | the spec text only exempts CONNECT and CONNECTED, but it also says a server MUST handle STOMP like CONNECT, and clients send the same headers for both (for example a passcode containing `\`) |
| D3 | CONNECTED `heart-beat` carries the negotiated intervals, not the server's own `<sx>,<sy>` | the client computes the same result: MAX with its own value gives the negotiated interval, and 0 stays 0. Sending the configured `heartbeat` would be the literal reading and costs nothing; worth changing in G1 |
| D4 | Client frames that shouldn't have a body (SUBSCRIBE etc.) are accepted and the body ignored | the MUST NOT is on the sender; being lenient is allowed |
| D5 | A single WebSocket message above `maxPayload` is closed by ws with code 1009 (1006 for ws 5), without a STOMP ERROR | ws enforces the limit before STOMP sees the data. Frames split over several messages get a proper ERROR from the decoder |

## Proposed step 6: STOMP 1.2

Fix B1 first. It applies to 1.0 and 1.1 as well and should go in before 2.0
ships, together with 5b or as its own PR. Then:

1. G2: CR escaping, for 1.2 sessions only.
2. G3: store the ack mode; `ack` header on MESSAGE for client-ack subscriptions of 1.2 sessions.
3. G4: `id` on ACK/NACK for 1.2 sessions.
4. G5 and D3: `version` header on the negotiation ERROR; CONNECTED `heart-beat` carries the server's own values.
5. G1: add `1.2` to `SUPPORTED_VERSIONS`.
6. Tests: one conformance test per MUST in the matrix, named after its spec section, so this document can be checked again by running them.

Optional:
- Make undefined escapes fatal for 1.2 sessions (D1).
- Reject a body on frames that shouldn't have one (D4).
