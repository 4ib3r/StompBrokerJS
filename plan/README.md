# Improvement plan

Remediation plan for the problems found in the project review (protocol
correctness, security, architecture, tooling). One step = one PR; each step
builds on the previous one and must leave CI green.

| Step | Scope | Release | Size | Status |
|---|---|---|---|---|
| 1 | Tooling, CI, dependencies | 1.3.2 | S | done (#36) |
| 2 | [Streaming, binary-safe parser](02-parser.md) | 1.4.0 | M | done (#39) |
| 3 | [Limits and session lifecycle](03-limits-lifecycle.md) | 1.5.0 | M | in review |
| 4 | [Transactions, ACK/NACK](04-transactions-ack.md) | 1.5.0 | S–M | planned |
| 5 | [2.0 architecture refactor](05-architecture-2.0.md) | 2.0.0 | L | planned |

## Open decisions

1. **ACK/NACK semantics** (step 4): documented no-ops for an at-most-once
   broker (recommended) vs. real unacked-message tracking with redelivery.
2. **Behaviour changes in a minor release** (step 3): "ERROR always closes the
   connection" and "unknown command → ERROR" are spec-correct but observable.
   Ship in 1.5.0 (recommended, with changelog) or hold for 2.0.
3. **GitHub Pages**: switch from committed `docs/` on `master` to a
   `gh-pages` branch built by CI, then delete `docs/` from `master`.

## Rules for every step

- Each finding fixed gets a regression test that fails before the fix.
- No sleeps in new tests: wait for a RECEIPT (`RawClient.sendWithReceipt`),
  a frame (`waitFor`) or use `flush()` for "nothing arrives" assertions;
  use fake timers for timeouts.
- `npm run lint`, `npm test` and `npm run coverage` (≥ 95 % lines) pass locally
  before pushing.
- Behaviour visible to users goes into the "Unreleased" changelog in `README.MD`.

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
