# StompBrokerJS
NodeJS StompBroker

This is simple NodeJs STOMP 1.1 broker for embedded usage.

[![CI](https://github.com/4ib3r/StompBrokerJS/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/4ib3r/StompBrokerJS/actions/workflows/ci.yml)
[![Support](https://beerpay.io/4ib3r/StompBrokerJS/badge.svg?style=flat-square)](https://beerpay.io/4ib3r/StompBrokerJS)
# Features
* Destination wildcards
    * . is used to separate names in a path (`/one.two`; `/one/two` is a single name)
    * \* is used to match exactly one name in a path (`/a.*` matches `/a.b`, not `/a` or `/a.b.c`)
    * \*\* is used to recursively match path names (`/a.**` matches `/a.b` and `/a.b.c`)
* STOMP 1.0 and 1.1 (version negotiation, header escaping, heart-beats in both directions)
* Transactions (BEGIN / COMMIT / ABORT)
* ACK / NACK (at-most-once delivery, see "Delivery guarantees")
* WebSocket (`ws`) and SockJS transports

# TODO
* Authorization
* Redelivery of unacknowledged messages
* Async send messages
* Composite Destinations
* Message selectors

# Changelog
* 0.1.0 First working version.
* 0.1.1 Added wildcards to destination, change subscribe method [no backward compatibility]
* 0.1.2 Bug fixes, changed websocket library, updated documentation.
* 0.1.3 Unsubscribe on server, updated documentation, added events.
* 2.0.0 (unreleased)
    * Breaking changes:
        * Node.js 20 or newer.
        * Every ERROR frame closes the connection (rejected commands, unknown subscription ids, malformed
          frames, exceeded limits); unknown commands are answered with ERROR.
        * DISCONNECT closes the connection; frames sent after it are ignored.
        * Default `limits` apply, e.g. frames over 1 MiB and more than 256 subscriptions per connection are
          rejected; see "Limits".
        * SUBSCRIBE requires an `id` header from STOMP 1.1 clients (1.0 clients may omit it, the destination
          is used instead, also for UNSUBSCRIBE); ids must be unique per connection; the `ack` header must be
          `auto`, `client` or `client-individual`; server-side `subscribe()` throws for an id already in use.
        * `send` middleware gets JSON bodies as received (text), not as parsed objects; binary bodies are
          `Buffer`s.
        * ERROR frames no longer contain internal error messages, throw a `StompServer.StompError` to send a
          message to the client.
        * SEND frames with a `transaction` header are delivered on COMMIT (and dropped on ABORT) instead of
          immediately; the transaction must have been started with BEGIN.
        * `addMiddleware`, `setMiddleware` and `removeMiddleware` throw a `TypeError` for commands without
          middleware (e.g. a typo like `'conect'`).
        * Middleware and the `subscribe` / `unsubscribe` events (`subscription.socket`) get a session object
          (`sessionId`, `version`, `state`, `close()`) instead of the raw WebSocket; `subscribes` is a read-only
          snapshot; the internal `heartbeatOn` / `heartbeatOff` methods are gone.
    * Malformed frames (e.g. missing destination) are answered with ERROR instead of crashing the process;
      socket errors are emitted only when an `error` listener is registered.
    * Frames are decoded incrementally: a WebSocket message may contain several frames and a frame may span
      several messages (stompjs splits frames larger than 16 KB, those were truncated before).
    * Binary bodies are relayed byte for byte, as binary WebSocket messages; text bodies as text messages.
    * Header names and values are escaped in relayed frames, headers containing NUL or CR are rejected with ERROR;
      a sender can no longer inject headers or frames into MESSAGEs of other clients. Header whitespace is kept.
    * `application/json` bodies are relayed as received (no re-serialization), and decoded only for server-side
      subscribers and `send` event listeners; invalid JSON is passed on as text instead of closing the connection.
      `send` middleware sees the body as received (text), no longer as a parsed object.
    * Malformed frames (invalid command, header line or `content-length`, missing NUL after `content-length`
      octets) are answered with ERROR and the connection is closed.
    * Configurable `limits` (frame size, headers, subscriptions per connection, queued data, CONNECT timeout)
      and `slowConsumerPolicy`, see "Limits".
    * Invalid `heart-beat` headers are rejected; very large intervals no longer overflow timers (which made
      the server send heart-beats every millisecond).
    * Subscriptions accepted by asynchronous middleware after the connection closed are no longer leaked.
    * ERROR frames carry the message of a `StompError` or `Internal error`, not internal error details;
      the passcode is no longer passed to `debug`.
    * MESSAGE frames are serialized once per message instead of once per subscriber.
    * Frames of a connection are processed one after another, in the order received (also with asynchronous
      middleware); a DISCONNECT RECEIPT is sent once all earlier frames were processed, and a SEND received
      before DISCONNECT or before the connection closed is still delivered.
    * The ERROR for a client without a common protocol version has a `version` header listing the supported
      versions; the undefined escape `\r` in a STOMP 1.1 header is reported as `Undefined escape sequence \r`.
    * Routing uses a destination trie: the cost of a message depends on the destination depth and the number
      of matching subscriptions, not on the number of subscriptions (`bench/fanout.js`).
    * Transactions: BEGIN, COMMIT and ABORT; limits `maxTransactions` and `maxTransactionBytes`.
    * ACK and NACK are validated and answered (RECEIPT) instead of being ignored; delivery stays at-most-once.
    * Middleware for `begin`, `commit`, `abort`, `ack` and `nack`.
    * Frames other than CONNECT/STOMP are rejected until the client is connected.
    * MESSAGE frames contain `destination` and `message-id` headers, `content-length` is the UTF-8 byte length;
      `receipt`, `message-id` and `subscription` headers sent by clients are not forwarded.
    * RECEIPT is sent for SEND/SUBSCRIBE/UNSUBSCRIBE with a `receipt` header; DISCONNECT without receipt sends none.
    * Heart-beats are negotiated in both directions and work with SockJS.
    * Bodies containing blank lines or NULL octets (with `content-length`) are parsed correctly.
    * Fixed wildcard matching (`/a.b.c` no longer receives messages for `/a.b`).
    * Rejected CONNECT closes the connection; middleware may return a Promise.
    * TypeScript type definitions (`stompServer.d.ts`).
    * `protocolConfig.noServer` is supported for the `ws` protocol.
    * Errors are thrown as `Error` instances.

# Example
```javascript
var http = require("http");
var StompServer = require('stomp-broker-js');

var server = http.createServer();
var stompServer = new StompServer({server: server});

server.listen(61614);

// messages sent by clients to any destination
stompServer.subscribe("/**", function(msg, headers) {
  var topic = headers.destination;
  console.log(topic, "->", msg);
});

// delivered to subscribed clients (not to server-side subscriptions)
stompServer.send('/test', {}, 'testMsg');
```

Clients connect to `ws://localhost:61614/stomp` (the default `path` is `/stomp`).

TypeScript (typings are included):
```typescript
import http = require('http');
import StompServer = require('stomp-broker-js');

const stompServer = new StompServer({server: http.createServer()});
stompServer.addMiddleware('subscribe', (socket, args, next) => {
  if (args.dest.startsWith('/private')) {
    throw new StompServer.StompError('Access denied');
  }
  return next();
});
```
The package is CommonJS: use `import StompServer = require(...)`, or a default import with `esModuleInterop`.

## Configuration
```javascript
new StompServer({
  server: server,                // http.Server, required unless protocolConfig.noServer is set
  path: '/stomp',                // WebSocket path (SockJS prefix)
  protocol: 'ws',                // 'ws' or 'sockjs'
  protocolConfig: {},            // extra options for the ws / sockjs server
  heartbeat: [0, 0],             // [server sends every ms, server expects every ms], 0 disables
  heartbeatErrorMargin: 1000,    // tolerance for late client heart-beats
  serverName: 'STOMP-JS/x.y.z',
  debug: function () {},
  limits: {},                    // see "Limits"
  slowConsumerPolicy: 'drop'     // 'drop' or 'close', see "Limits"
});
```

### Limits
Every limit can be raised, or disabled with `Infinity`; unknown names are rejected when the server is created.
```javascript
limits: {
  maxFrameSize: 1048576,         // bytes per frame (also the ws maxPayload default)
  maxHeaders: 64,                // headers per frame
  maxHeaderLength: 8192,         // characters per header line
  maxSubscriptions: 256,         // subscriptions per connection
  maxBufferedAmount: 8388608,    // bytes queued for a connection before it counts as a slow consumer
  connectTimeout: 10000,         // ms from opening the socket to the CONNECT frame
  maxTransactions: 16,           // open transactions per connection
  maxTransactionBytes: 4194304   // body bytes buffered in the open transactions of a connection
}
```
A client that breaks a limit gets an ERROR frame and the connection is closed. Messages for a slow consumer
are dropped (`slowConsumerPolicy: 'drop'`, the `slowConsumer` event is emitted) or its connection is closed
(`'close'`); SockJS connections don't report queued data, so this applies to `ws` connections only.
Options in `protocolConfig` (e.g. `maxPayload`, `perMessageDeflate`) take precedence over these defaults.

### Sharing an http server (`noServer`)
```javascript
var stompServer = new StompServer({protocolConfig: {noServer: true}});
server.on('upgrade', function (request, socket, head) {
  if (request.url === '/stomp') {
    stompServer.socket.handleUpgrade(request, socket, head, function (ws) {
      stompServer.socket.emit('connection', ws, request);
    });
  }
});
```

## Message bodies
Bodies are relayed as they are received: text sent in text WebSocket messages stays text, binary data sent
in binary messages is delivered as a `Buffer` and as binary messages to subscribers.
For server-side subscribers (and `send` event listeners) `application/json` bodies are decoded to objects;
`stompServer.send(topic, {'content-type': 'application/json'}, object)` serializes an object body.

## Delivery guarantees
The broker keeps no messages: a message is written once to each matching subscription that is connected at
that moment (at-most-once). ACK and NACK frames are validated (the subscription must belong to the
connection) and answered with a RECEIPT when requested, whatever the subscription's `ack` mode, but they
don't cause redelivery. To act on them, use `ack` / `nack` middleware, which receives
`{subscription, messageId, transaction}`.

## Transactions
SEND frames with a `transaction` header are buffered until COMMIT, which delivers them in order, or ABORT,
which drops them; the transaction is started with BEGIN. `send` middleware runs when each SEND arrives, so a
COMMIT delivers everything that was accepted. Open transactions of a closed connection are dropped.
ACK and NACK may name an open transaction as well.

## Validating clients on connect
Middleware receives `(socket, args, next)`; return `next()` to continue or a falsy value to reject.
A rejected command is answered with an ERROR frame and the connection is closed. Middleware may return a Promise.
```javascript
stompServer.addMiddleware('connect', function (socket, args, next) {
  return checkToken(args.headers.passcode).then(function (ok) {
    return ok ? next() : false;
  });
});
```
Middleware is also available for `send`, `subscribe`, `unsubscribe`, `disconnect`, `begin`, `commit`, `abort`,
`ack` and `nack`; registering it for any other command throws a `TypeError`.

To tell the client why a command was rejected, throw (or reject with) a `StompServer.StompError`; its message
is sent in the ERROR frame. Other errors are reported to the client as `Internal error` and emitted as `error`
events, so that internal details don't leak.
```javascript
stompServer.addMiddleware('subscribe', function (socket, args, next) {
  if (!mayRead(socket.sessionId, args.dest)) {
    throw new StompServer.StompError('Access denied');
  }
  return next();
});
```

## Events
* `connecting` (sessionId) — socket opened
* `connected` (sessionId, headers) — CONNECT accepted
* `subscribe` (subscription) — a client (or the server) subscribed, emitted without any message being sent
* `unsubscribe` (subscription)
* `send` ({dest, frame}) — message published
* `disconnected` (sessionId)
* `slowConsumer` ({sessionId, subscription, destination, messageId}) — a message was not delivered, see "Limits"
* `error` (err) — socket errors and errors thrown by middleware or listeners, emitted only when a listener
  is registered
# Documentation
<https://4ib3r.github.io/StompBrokerJS/>