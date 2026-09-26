# Step 3 — Limits and session lifecycle

**Release:** 2.0.0 · **Size:** M (2–3 days) · **Depends on:** step 2
(decoder exposes `pending` and header counts)

## As implemented

Differences from the design below, decided while implementing:

- **No `heartbeatMin`:** the negotiated interval is `max(server, client)`,
  so a client can't make it shorter than the server's own setting. Only the
  upper bound is clamped (to 2³¹−1 ms, the largest timer delay), which is
  what caused the 1 ms interval. Not configurable.
- **No `maxPendingBytes`:** the decoder's `maxFrameSize` already bounds the
  data buffered for an incomplete frame; it is now also checked for frames
  that arrive complete.
- **No `LimitError`:** limit violations are `ProtocolError`s with specific
  messages (`Frame too large`, `Too many headers`, `Header too long`).
- **Connection state** stays in socket flags for now (`stompConnected`,
  `stompDisconnecting`, `stompDisconnected`, `stompClosed`); the `Session`
  state machine is step 5.
- **Tests use short real limits** (e.g. `connectTimeout: 100`) and wait for
  events (ERROR, close) instead of fake timers, which don't combine well with
  real sockets; no fixed sleeps. `sinon` is not needed.
- **Error events:** errors thrown by middleware or listeners (not
  `StompError`) are emitted as `error` in addition to `debug`; clients see
  `Internal error`.
- **Server-side `subscribe()`** throws for an id that is already in use (the
  per-session index can't hold duplicates; they could never be unsubscribed
  individually before either).
- **Transport defaults** (`perMessageDeflate: false`, `maxPayload`) are only
  applied to the `ws` transport.
- `sendFrame` still accepts plain objects (public util) but the broker's
  fan-out uses `Frame.MessageTemplate`.

## Goal

No single client can exhaust CPU or memory, and the session state machine
matches the spec: ERROR and DISCONNECT end the session, nothing is processed
afterwards, nothing leaks after close.

## Problems addressed

| # | Problem | Where |
|---|---|---|
| L1 | Client heart-beat not validated/bounded; `0,99999999999` → interval > 2³¹−1 → Node uses 1 ms | `lib/stomp.js` `negotiateHeartbeat`, `stompServer.js` `heartbeatOn` |
| L2 | Unbounded subscriptions per session, duplicate ids accepted, linear routing, every subscriber serialized separately, `bufferedAmount` ignored | `stompServer.js` `onSubscribe`, `_sendToSubscriptions` |
| L3 | O(n²) `splice` in close cleanup | `stompServer.js` `afterConnectionClose` |
| L4 | Async subscribe middleware resolving after close leaks the subscription | `stompServer.js` `onSubscribe` |
| L5 | DISCONNECT sets `stompDisconnected` but leaves `stompConnected`; socket stays open and usable | `stompServer.js` `onDisconnect`, `lib/stomp.js` `DISCONNECT` |
| L6 | No CONNECT timeout; default heart-beat `[0,0]` → idle sockets forever | `stompServer.js` `connection` |
| L7 | ws `maxPayload` 100 MiB default; header count/length unbounded; `perMessageDeflate` forced, user options overridden | `stompServer.js` constructor, decoder |
| L8 | ERROR sent without closing (`reply()`); unknown commands ignored silently | `lib/stomp.js` `reply`, `stompServer.js` `parseRequest` |
| L9 | SUBSCRIBE without `id` accepted in 1.1 (`subscription:undefined`) | `lib/stomp.js` `SUBSCRIBE` |
| L10 | Raw `err.message` from app code sent to clients; `passcode` logged via `debug`; `PING` logged every tick | `lib/stomp.js` `onHandlerError`, `stompServer.js` `onClientConnected` |
| L11 | `.then(onResult, onError)` misses throws inside `onResult` | `lib/stomp.js` `whenDone` |

## Design

### Configuration (`lib/config.js`)

```js
limits: {
  maxFrameSize:       1024 * 1024,     // bytes; default ws maxPayload
  maxHeaders:         64,
  maxHeaderLength:    8 * 1024,        // bytes per header line
  maxPendingBytes:    1024 * 1024,     // incomplete frame buffered by decoder
  maxSubscriptions:   256,             // per session
  maxBufferedAmount:  8 * 1024 * 1024, // slow-consumer threshold
  connectTimeout:     10000,           // ms from socket open to CONNECT
  heartbeatMin:       1000,            // ms, clamp for negotiated intervals
  heartbeatMax:       2147483647
},
slowConsumerPolicy: 'drop'             // 'drop' | 'close'
```

- Merged over defaults; each value validated (positive integer or
  `Infinity`); unknown keys → throw at construction (catches typos).
- `protocolConfig` wins over broker defaults: build ws options as
  `{perMessageDeflate: false, maxPayload: limits.maxFrameSize,
  ...protocolConfig, server, path}`.

### Heart-beats (L1)

- Parse `heart-beat` with `/^(\d{1,10}),(\d{1,10})$/`; mismatch → ERROR +
  close.
- `negotiateHeartbeat` result clamped to `[heartbeatMin, heartbeatMax]` when
  non-zero.
- Drop per-tick `debug('PING')`/`HEALTH CHECK ok` (or behind
  `conf.trace`).

### Connection lifecycle (L5, L6, L8)

Explicit states on the socket (become the `Session` state machine in step 5):
`OPEN → CONNECTED → DISCONNECTING → CLOSED`.

- `connection`: start `connectTimeout` timer; CONNECTED clears it; expiry →
  ERROR `connect timeout` + close.
- DISCONNECT: state → `DISCONNECTING`, run middleware, send RECEIPT if
  requested, then `socket.close()` (ws flushes queued data before the close
  frame). Frames arriving in `DISCONNECTING`/`CLOSED` are ignored.
- `reply()` uses `fail()` — every ERROR closes the connection (spec).
- Unknown command → ERROR `Unknown command` + close.
- `whenDone`: `result.then(onResult).catch(onError)` with a `settled` guard
  so an error is reported once (L11).

### Subscriptions (L2, L3, L4, L9)

- 1.1+ SUBSCRIBE requires `id`; `ack` must be `auto | client |
  client-individual` (validated here, used in step 4).
- Duplicate `(sessionId, id)` → ERROR.
- `maxSubscriptions` per session → ERROR `too many subscriptions`.
- After (async) middleware resolves: if state is not `CONNECTED`, return
  without storing (L4). Same guard for SEND and UNSUBSCRIBE.
- Index: `this._bySession = new Map<sessionId, Map<subId, sub>>` alongside
  the existing array. Unsubscribe and close cleanup use the index and rebuild
  the array once with `filter` (O(n) once instead of O(n²)); the array is
  replaced by the trie in step 5.

### Fan-out (L2)

- Build the MESSAGE header block once per message without `subscription`;
  per subscriber only `subscription:<id>\n` is inserted:
  `Buffer.concat([head, subLine, tail, body, NUL])` — the body Buffer is
  shared, not copied per subscriber in JS.
- Before writing: `if (socket.bufferedAmount > maxBufferedAmount)` apply
  `slowConsumerPolicy`: `drop` (skip, emit `slowConsumer` with sessionId and
  message-id) or `close` (ERROR + close). sockjs connections report 0 →
  documented limitation.

### Decoder limits (L7)

- `FrameDecoder` options `{maxFrameSize, maxHeaders, maxHeaderLength,
  maxPendingBytes}`; exceeding one throws `LimitError` → ERROR with a fixed
  message (`frame too large`, `too many headers`, `header too long`) + close.

### Error text and logging (L10)

- Errors from middleware and listeners: client gets a generic
  `message: <command> ERROR`; details go to `debug` and the `error` event.
- Middleware can choose the client text by rejecting with
  `new StompError('Access denied')` (exported from the package).
- Redact `passcode` (and `login` optionally) before `debug('CONNECT', …)`.

## Tasks

- [ ] `lib/config.js`: `limits`, `slowConsumerPolicy`, validation; option
      merge order for the transport
- [ ] `lib/errors.js`: `LimitError`; export `StompError` from the package
- [ ] heart-beat parsing + clamping
- [ ] connection state + CONNECT timeout + DISCONNECT close
- [ ] `reply()` → `fail()`; unknown command → ERROR; `whenDone` fix
- [ ] subscription validation, limits, per-session index, post-middleware
      state guard
- [ ] serialize-once fan-out + slow-consumer handling
- [ ] decoder limits wired to config
- [ ] error text sanitising, `passcode` redaction, quieter debug
- [ ] README: "Limits" section, lifecycle notes; CHANGELOG

## Tests

Add `sinon` (fake timers) as a dev dependency; no real sleeps.

- heart-beat: `0,99999999999`, `Infinity,1`, `-1,5`, `abc`, `1,2,3` → ERROR
  or clamped; negotiated interval never < `heartbeatMin`
- CONNECT timeout fires (fake timers) and is cleared by CONNECT
- each decoder limit: just below → OK, just above → ERROR + close
- `maxFrameSize` also enforced by ws (`maxPayload`) — 1009 close code
- user `protocolConfig.maxPayload` / `perMessageDeflate` are respected
- `maxSubscriptions`; duplicate id; missing id in 1.1 (1.0 still allowed)
- async subscribe middleware + close before resolve → subscription count 0
- DISCONNECT with receipt → RECEIPT then close; SEND after DISCONNECT in the
  same chunk is not delivered
- ERROR always followed by close; unknown command → ERROR + close
- slow consumer: stub `bufferedAmount` → `drop` skips + event; `close`
  closes
- close cleanup with 10 000 subscriptions completes in < 50 ms
- middleware throwing `new Error('db down at 10.0.0.5')` → client sees
  generic text; `StompError('Access denied')` → client sees `Access denied`
- `debug` never receives the passcode
- double-disconnect guard (currently uncovered): DISCONNECT then close →
  `disconnected` emitted once

Existing tests to update:

- `broker.test.js` "answers unknown commands without closing the connection"
  → now asserts ERROR + close
- tests that send more frames after an ERROR (if any) need a new connection

## Acceptance criteria

- The DoS reproductions from the review (heart-beat 1 ms timer, 1 M
  subscriptions, subscribe-then-close leak, commands after DISCONNECT) are
  regression tests and pass.
- Coverage ≥ 95 %; no test uses `setTimeout`-based waits.

## Compatibility / changelog

- **Behaviour changes:** ERROR closes the connection; unknown commands get
  ERROR; DISCONNECT closes the socket; frames > 1 MiB rejected by default;
  SUBSCRIBE without `id` rejected for 1.1 clients; heart-beats < 1 s
  clamped. All configurable except the spec-mandated ones.
- Released in 2.0.0 together with the other steps (see
  [README](README.md)).
