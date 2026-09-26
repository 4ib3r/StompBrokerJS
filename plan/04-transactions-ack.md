# Step 4 — Transactions, ACK/NACK

**Release:** 2.0.0 · **Size:** S–M (1–2 days) · **Depends on:** step 3
(ERROR closes, per-session state, `ack` mode validated at SUBSCRIBE)

## As implemented

- **ACK/NACK are no-ops** (decided): validated, passed to `ack`/`nack`
  middleware and answered with RECEIPT; delivery stays at-most-once. The
  subscription's `ack` mode (`client`, `client-individual`) doesn't change
  that; README "Delivery guarantees" says so.
- **`maxTransactionBytes` is per connection** (all open transactions
  together), not per transaction: 16 × 4 MiB per connection would be too
  much buffered data per client.
- **Header checks before middleware** (missing `transaction`, `message-id`,
  or `subscription` for 1.1) as for SUBSCRIBE; state checks (open
  transaction, own subscription) after middleware.
- STOMP 1.0 ACK needs only `message-id`.
- Transaction store: `lib/transactions.js`, one per connection
  (`socket.transactions`), cleared on close; buffered SENDs have passed
  send middleware and their destination is validated when they arrive.

## Goal

Every STOMP 1.1 client command is handled: transactions have real
all-or-nothing semantics, ACK/NACK are validated and answered, and the
broker's delivery guarantee is documented.

## Problems addressed

| # | Problem | Where |
|---|---|---|
| T1 | BEGIN/COMMIT/ABORT not handled: receipts never answered, clients waiting for them hang | `stompServer.js` `parseRequest` (`'Command not found'`) |
| T2 | SEND with `transaction` delivered immediately; the header is stripped as reserved, ABORT cannot roll back | `stompServer.js` `onSend`, `RESERVED_HEADERS` |
| T3 | ACK/NACK not handled | `lib/stomp.js` |
| T4 | `addMiddleware('conect', …)` silently never runs | `stompServer.js` `addMiddleware` |

## Design

### Delivery semantics (decision)

The broker is non-persistent pub/sub: a MESSAGE is written once to each
matching subscriber socket, there is no store and no redelivery.

**Recommended:** document *at-most-once* delivery; ACK/NACK are validated
and answered but do not change delivery. Apps that need redelivery hook the
new `ack`/`nack` middleware.

**Alternative (bigger, separate feature):** track unacked messages per
subscription for `client`/`client-individual` modes, redeliver on NACK or
reconnect, bounded by a per-subscription window. Not part of this step.

### Transactions (`lib/transactions.js`)

Per session: `Map<txId, {frames: Frame[], bytes: number}>`.

| Command | Behaviour |
|---|---|
| `BEGIN` | requires `transaction`; id must not be open (ERROR); at most `limits.maxTransactions` (default 16) open per session; RECEIPT if requested |
| `SEND` with `transaction` | tx must be open (ERROR); frame buffered, not delivered; bytes of all open transactions of the connection checked against `limits.maxTransactionBytes` (default 4 MiB) |
| `ACK`/`NACK` with `transaction` | tx must be open; recorded no-op |
| `COMMIT` | tx must be open; buffered frames delivered in order through the normal routing path; tx removed; RECEIPT |
| `ABORT` | tx must be open; frames discarded; tx removed; RECEIPT |
| close / DISCONNECT | all open transactions discarded |

- Send middleware runs when the transactional SEND arrives; only accepted
  frames are buffered (a rejected one gets ERROR + close, which discards the
  transaction). COMMIT therefore delivers the whole buffer and cannot be
  partially rejected, which keeps it atomic from the client's perspective.
- `transaction` stays a reserved header (never forwarded to subscribers).

### ACK / NACK

- 1.1: require `subscription` and `message-id` headers; 1.2 (future): `id`.
- Subscription must belong to the session (ERROR otherwise).
- Run `ack`/`nack` middleware; answer RECEIPT.

### Frame handler and middleware

- `lib/stomp.js`: add `BEGIN`, `COMMIT`, `ABORT`, `ACK`, `NACK` handlers.
- Middleware commands: `connect, disconnect, send, subscribe, unsubscribe,
  begin, commit, abort, ack, nack`. `addMiddleware` / `setMiddleware` /
  `removeMiddleware` throw `TypeError` for anything else (T4) — behaviour
  change for typos only.

## Tasks

- [ ] `lib/transactions.js` + unit tests
- [ ] `limits.maxTransactions`, `limits.maxTransactionBytes` in config
- [ ] handlers in `lib/stomp.js`; SEND path branches on `transaction`
- [ ] cleanup on close/DISCONNECT
- [ ] middleware command validation
- [ ] README: "Delivery guarantees" and "Transactions" sections; CHANGELOG

## Tests

- RECEIPT for BEGIN, COMMIT, ABORT, ACK, NACK
- transactional SEND not delivered before COMMIT; delivered in order after
  COMMIT; ABORT delivers nothing
- mixed: non-transactional SEND between BEGIN and COMMIT is delivered
  immediately
- BEGIN duplicate id, COMMIT/ABORT unknown id, SEND with unknown tx → ERROR +
  close
- `maxTransactions`, `maxTransactionBytes` → ERROR + close
- connection closed with an open transaction → nothing delivered, no leak
  (transaction map size 0)
- ACK without `message-id`, ACK for another session's subscription → ERROR
- `ack` middleware is called with subscription and message id
- `addMiddleware('conect')` throws

## Acceptance criteria

- Every 1.1 client command has a handler and a test; no command reaches the
  "unknown command" path.
- README states the delivery guarantee.
