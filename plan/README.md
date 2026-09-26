# Improvement plan

Remediation plan for the problems found in the project review (protocol
correctness, security, architecture, tooling). One step = one PR; each step
builds on the previous one and must leave CI green.

| Step | Scope | Release | Size | Status |
|---|---|---|---|---|
| 1 | Tooling, CI, dependencies | 2.0.0 | S | done (#36) |
| 2 | [Streaming, binary-safe parser](02-parser.md) | 2.0.0 | M | done (#39) |
| 3 | [Limits and session lifecycle](03-limits-lifecycle.md) | 2.0.0 | M | done (#40) |
| 4 | [Transactions, ACK/NACK](04-transactions-ack.md) | 2.0.0 | S–M | done (#41) |
| 5a | [Internal extraction: Session, subscription trie](05-architecture-2.0.md#5a-internal-extraction) | 2.0.0 | M | in review |
| 5b | [Transports: ws 8, interface, optional SockJS, `close()`](05-architecture-2.0.md#5b-transports) | 2.0.0 | M | planned |
| 5c | [Public 2.0 API](05-architecture-2.0.md#5c-public-20-api) | 2.0.0 | L | planned |
| 5d | [Security hooks, types, docs](05-architecture-2.0.md#5d-security-hooks-types-docs) | 2.0.0 | M | planned |

**Release decision:** there are no 1.x releases in between; everything above
ships in **2.0.0**. Behaviour changes from steps 2–4 don't need to be held
back or made opt-in, but each one is listed under "Breaking changes" in the
README changelog.

## Decisions

- **Release:** everything ships in 2.0.0 (see above).
- **ACK/NACK:** documented no-ops for an at-most-once broker; redelivery of
  unacknowledged messages is not planned (step 4).

## Open decisions

1. **GitHub Pages**: switch from committed `docs/` on `master` to a
   `gh-pages` branch built by CI, then delete `docs/` from `master`.

## Rules for every step

- Each finding fixed gets a regression test that fails before the fix.
- No sleeps in new tests: wait for a RECEIPT (`RawClient.sendWithReceipt`),
  a frame (`waitFor`) or use `flush()` for "nothing arrives" assertions;
  use fake timers for timeouts.
- `npm run lint`, `npm test` and `npm run coverage` (≥ 95 % lines) pass locally
  before pushing.
- Behaviour visible to users goes into the "2.0.0 (unreleased)" changelog in `README.MD`,
  breaking changes into its "Breaking changes" list.

## Findings index

Where each review finding is addressed:

| Finding | Step |
|---|---|
| One frame per WebSocket message; frames > 16 KB from stompjs truncated | 2 |
| Binary bodies corrupted by UTF-8 decoding | 2 |
| Header injection / frame smuggling into MESSAGE frames | 2 |
| JSON bodies re-serialized (precision loss, empty body crash) | 2 |
| Header whitespace trimmed; STOMP vs CONNECT escaping; stray LF | 2 |
| Heart-beat overflow → 1 ms timers | 3 |
| Unbounded subscriptions, fan-out, output buffers; O(n²) cleanup | 3 |
| DISCONNECT leaves session usable | 3 |
| Async subscribe middleware leaks subscriptions | 3 |
| No CONNECT timeout, 100 MiB maxPayload, unbounded headers | 3 |
| ERROR without close; missing/duplicate subscription id | 3 |
| Error text / passcode leakage | 3 |
| ACK/NACK/BEGIN/COMMIT/ABORT ignored; unknown commands silent | 3, 4 |
| God object, socket monkey-patching, EventEmitter id collisions | 5 |
| Inconsistent middleware / error strategy, leaky public API | 5 |
| sockjs eager require, forced options, no `close()` | 5 |
| ws 5 end-of-life, sockjs `uuid` advisory | 5 |
| No auth/authorization defaults, `/**` eavesdropping | 5 |
