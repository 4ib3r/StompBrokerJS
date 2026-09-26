# StompBrokerJS
NodeJS StompBroker

This is simple NodeJs STOMP 1.1 broker for embedded usage.

[![build state](https://travis-ci.org/4ib3r/StompBrokerJS.svg?branch=master)](https://travis-ci.org/4ib3r/StompBrokerJS)
[![Support](https://beerpay.io/4ib3r/StompBrokerJS/badge.svg?style=flat-square)](https://beerpay.io/4ib3r/StompBrokerJS)
# Features
* Destination wildcards
    * . is used to separate names in a path (`/one.two`; `/one/two` is a single name)
    * \* is used to match exactly one name in a path (`/a.*` matches `/a.b`, not `/a` or `/a.b.c`)
    * \*\* is used to recursively match path names (`/a.**` matches `/a.b` and `/a.b.c`)
* STOMP 1.0 and 1.1 (version negotiation, header escaping, heart-beats in both directions)
* WebSocket (`ws`) and SockJS transports

# TODO
* Authorization
* Acknowledgment
* Async send messages
* Transactions
* Composite Destinations
* Message selectors

# Changelog
* 0.1.0 First working version.
* 0.1.1 Added wildcards to destination, change subscribe method [no backward compatibility]
* 0.1.2 Bug fixes, changed websocket library, updated documentation.
* 0.1.3 Unsubscribe on server, updated documentation, added events.
* Unreleased
    * Malformed frames (invalid JSON body, missing destination) are answered with ERROR instead of crashing the process;
      socket errors are emitted only when an `error` listener is registered.
    * Frames other than CONNECT/STOMP are rejected until the client is connected.
    * MESSAGE frames contain `destination` and `message-id` headers, `content-length` is the UTF-8 byte length;
      `receipt`, `message-id` and `subscription` headers sent by clients are not forwarded.
    * RECEIPT is sent for SEND/SUBSCRIBE/UNSUBSCRIBE with a `receipt` header; DISCONNECT without receipt sends none.
    * Heart-beats are negotiated in both directions and work with SockJS.
    * Bodies containing blank lines or NULL octets (with `content-length`) are parsed correctly.
    * Fixed wildcard matching (`/a.b.c` no longer receives messages for `/a.b`).
    * Rejected CONNECT closes the connection; middleware may return a Promise.
    * `protocolConfig.noServer` is supported for the `ws` protocol.
    * Errors are thrown as `Error` instances.

# Example
```javascript
var http = require("http");
var StompServer = require('stomp-broker-js');

var server = http.createServer();
var stompServer = new StompServer({server: server});

server.listen(61614);

stompServer.subscribe("/**", function(msg, headers) {
  var topic = headers.destination;
  console.log(topic, "->", msg);
});

stompServer.send('/test', {}, 'testMsg');
```

Clients connect to `ws://localhost:61614/stomp` (the default `path` is `/stomp`).

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
  debug: function () {}
});
```

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

## Validating clients on connect
Middleware receives `(socket, args, next)`; return `next()` to continue or a falsy value to reject.
A rejected CONNECT is answered with an ERROR frame and the connection is closed. Middleware may return a Promise.
```javascript
stompServer.addMiddleware('connect', function (socket, args, next) {
  return checkToken(args.headers.passcode).then(function (ok) {
    return ok ? next() : false;
  });
});
```
Middleware is also available for `send`, `subscribe`, `unsubscribe` and `disconnect`.

## Events
* `connecting` (sessionId) — socket opened
* `connected` (sessionId, headers) — CONNECT accepted
* `subscribe` (subscription) — a client (or the server) subscribed, emitted without any message being sent
* `unsubscribe` (subscription)
* `send` ({dest, frame}) — message published
* `disconnected` (sessionId)
* `error` (err) — socket errors, emitted only when a listener is registered
# Documentation
<https://4ib3r.github.io/StompBrokerJS/>