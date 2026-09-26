# Step 5 — 2.0 architecture refactor

**Release:** 2.0.0 (breaking) · **Size:** L (1–2 weeks) · **Depends on:**
steps 2–4 (their tests pin the behaviour the refactor must keep)

## Goal

Replace the constructor-closure god object with small, separately testable
components and a deliberate public API; move to maintained transports; give
secure-by-configuration hooks for authentication and authorization.

## Problems addressed

| # | Problem | Where |
|---|---|---|
| A1 | Everything defined as closures in the constructor (`this.x = function`), `util.inherits` on an empty prototype; not unit-testable without a real ws server | `stompServer.js` |
| A2 | Per-connection state monkey-patched onto the transport socket (8+ fields); middleware gets the raw socket and can change protocol state | `stompServer.js`, `lib/stomp.js`, `lib/stomp-utils.js` |
| A3 | Server-side subscriptions use the EventEmitter namespace (`subscribe(..., {id: 'error'})` collides); ids from `Math.random`; shared `'self_1234'` session hides server `send()` from server `subscribe()` | `stompServer.js` `subscribe`, `send`, `_sendToSubscriptions` |
| A4 | Middleware applied inconsistently (server `subscribe()` skips it), `(socket, args, next)` with falsy-return rejection; `send()` returns nothing, rejections unhandled | `stompServer.js` |
| A5 | Error handling mixes throw / conditional emit / swallowed / string return | throughout |
| A6 | `sockjs` required eagerly for every user; forced transport options; hard-coded, unpinned CDN `sockjs_url`; no `close()`/shutdown | `lib/adapter/index.js`, `lib/config.js` |
| A7 | Leaky public surface: `conf`, `subscribes`, `middleware`, `frameHandler`, `heartbeatOn`, `parseRequest`, … are public and mutable; `this.socket` is the server | `stompServer.js` |
| A8 | Linear routing O(subscriptions) per message | `_sendToSubscriptions` |
| A9 | `ws` 5.x end of life; `sockjs` pulls `uuid` < 11.1.1 (GHSA-w5hq-g745-h8pq) | `package.json` |
| A10 | No authentication/authorization defaults; any client can subscribe `/**` and read everything, or publish to server-side destinations | — |
| A11 | Misleading JSDoc (heart-beat default, event payloads), dead code (`ServerFrame.MESSAGE`, `want_receipt`, re-exports) | `stompServer.js`, `lib/*` |

## Target structure

```
index.js                     exports { StompServer, StompError, transports }
index.d.ts                   hand-written types (checked in CI with tsc --noEmit)
lib/
  StompServer.js             class StompServer extends EventEmitter — public API only
  Session.js                 wraps a transport connection; owns decoder, state,
                             heart-beats, subscriptions, transactions
  SessionState.js            OPEN → CONNECTED → DISCONNECTING → CLOSED
  SubscriptionRegistry.js    exact Map<dest, Set<sub>> + token trie for * / **;
                             bySession index
  MiddlewareChain.js         async (ctx, next), Koa-style
  HeartbeatManager.js        timers per session, single clamp/negotiate place
  Router.js                  SEND → registry match → serialize once → deliver
  codec/json.js              body codecs for in-process subscribers
  transport/ws.js            ws ≥ 8 adapter
  transport/sockjs.js        optional, lazy require; sockjs is a peerDependency
  errors.js                  StompError, ProtocolError, LimitError
  parser.js, frame.js        from step 2
```

Transport interface:

```ts
interface Transport {
  onConnection(cb: (conn: Connection, req?: IncomingMessage) => void): void;
  close(): Promise<void>;
}
interface Connection {
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount: number;
  onMessage(cb: (data: Buffer, isBinary: boolean) => void): void;
  onClose(cb: () => void): void;
  onError(cb: (err: Error) => void): void;
}
```

`StompServer` accepts `transport: 'ws' | 'sockjs' | Transport` so users can
plug uWebSockets.js, a test double, etc. Unit tests use an in-memory
transport — no ports.

## Public API 2.0

| 1.x | 2.0 |
|---|---|
| `new StompServer(conf)` | same config (+ `limits`, `authenticate`, `authorize`); adds `server.close(): Promise<void>` (ERROR `server shutting down` to sessions, clear timers, close transport) |
| `subscribe(topic, cb, {id})` + `server.on(id, cb)` | `subscribe(topic, cb, opts) → Subscription { id, topic, unsubscribe() }`; no EventEmitter channel |
| `unsubscribe(id)` | `subscription.unsubscribe()`; `server.unsubscribe(id)` kept, deprecated |
| `send(topic, headers, body)` | `publish(topic, body, headers?, {noLocal?}) → Promise<void>`; runs `send` middleware with a server principal; `send()` kept as deprecated alias |
| middleware `(socket, args, next)`, falsy → reject | `async (ctx, next) => { …; await next(); }`; throw `StompError` → reject; `ctx = {session, command, headers, body, dest, principal}`; 1.x signature supported through `legacyMiddleware(fn)` wrapper, deprecated |
| events get raw socket | events get `SessionInfo {id, version, principal, remoteAddress, connectHeaders}` (frozen) |
| `'error'` emitted only when listened | always emitted for broker-internal errors; if no listener, `process.emitWarning` once |
| `conf`, `subscribes`, `middleware`, `frameHandler`, `heartbeatOn/Off`, `parseRequest`, `frameParser/Serializer`, `socket` public | private (`#fields`); read-only getters `sessions`, `subscriptionCount` |
| `protocol`, `protocolConfig` | `transport`, `transportOptions` (old names accepted with a deprecation warning) |

### Security hooks (A10)

```js
new StompServer({
  server,
  authenticate: async ({login, passcode, headers, request}) => principal | null,
  authorize: async (principal, action /* 'subscribe'|'send' */, destination) => boolean,
  allowWildcardSubscriptions: true
});
```

- Defaults allow everything (compatible) but log a one-time warning when
  neither hook nor `connect` middleware is configured.
- `authenticate` result is available as `ctx.principal` / `SessionInfo.principal`.

### Routing (A8)

- `SubscriptionRegistry.match(tokens)`: exact destinations via `Map`,
  wildcard subscriptions via a token trie (`*` one level, `**` rest).
  O(depth + matches) instead of O(subscriptions).

## Migration approach

1. **Characterisation first:** steps 2–4 suites + a new
   `test/compat.test.js` that uses only the documented 1.x API.
2. Extract components one at a time behind the existing `StompServer`,
   keeping the full suite green after each commit: `Session` →
   `SubscriptionRegistry` → `HeartbeatManager` → `MiddlewareChain` →
   `Router` → transports.
3. Switch to `class StompServer`, make internals private, add the new API
   and deprecation shims.
4. Upgrade `ws` 5 → 8 (`WebSocketServer`, `message(data, isBinary)`,
   Buffers everywhere), make `sockjs` an optional peer dependency.
5. Port tests to the in-memory transport where they don't need the network;
   keep a slim end-to-end suite over real ws and sockjs.
6. Delete dead code (A11) and fix JSDoc; generate docs from `index.d.ts` +
   JSDoc.
7. `MIGRATION.md`, README rewrite, CHANGELOG.

## Tasks

- [ ] in-memory transport + `test/compat.test.js`
- [ ] `Session`, `SessionState`
- [ ] `SubscriptionRegistry` (+ property test against the old linear matcher)
- [ ] `HeartbeatManager`
- [ ] `MiddlewareChain` + `legacyMiddleware` shim
- [ ] `Router` (serialize once, slow-consumer policy)
- [ ] `transport/ws.js` on ws 8, `transport/sockjs.js` lazy + peer dep
- [ ] `class StompServer`: private fields, `publish`, `Subscription`,
      `close()`, events with `SessionInfo`
- [ ] `authenticate` / `authorize` / `allowWildcardSubscriptions`
- [ ] `index.js`, `index.d.ts`, `tsc --noEmit` job in CI checking the
      examples against the types
- [ ] remove dead code, fix JSDoc
- [ ] `MIGRATION.md`, README, CHANGELOG
- [ ] `bench/fanout.js`: 10 k subscriptions × 1 k messages, 1.x vs 2.0

## Acceptance criteria

- Full suite + compat suite green; coverage ≥ 95 %.
- `npm audit --omit=dev` clean with `ws` 8 and without sockjs installed.
- A consumer that doesn't install `sockjs` can `require` the package.
- Fan-out benchmark: 2.0 not slower than 1.x; exact-destination routing with
  10 k subscriptions at least 10× faster.
- Types compile against `examples/`.
- `server.close()` leaves no open handles (mocha exits without `--exit`).

## Risks

- Scope creep: keep the refactor behaviour-preserving; new features limited
  to `close()`, `publish()` promise, security hooks.
- Users of undocumented internals (`subscribes`, `frameHandler`,
  `parseRequest`, e.g. `broker.socket.emit('connection', …)` for
  `noServer`): provide `server.handleUpgrade(req, socket, head)` for the
  `noServer` case and list removed internals in `MIGRATION.md`.
