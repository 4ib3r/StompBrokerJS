/**
 * Broker behaviour tests over a raw WebSocket client: events, subscriptions,
 * middleware, message routing, heart-beats and the sockjs adapter.
 */
var assert = require('chai').assert;

var support = require('./support/raw-client');

var delay = support.delay;


describe('StompServer broker', function () {
  var ctx = support.useBroker();

  function connectedClient(headers, path) {
    var client = ctx.client(path);
    return client.connect(headers).then(function () {
      return client;
    });
  }

  describe('connection lifecycle', function () {
    it('emits connecting with a session id when a socket opens', function () {
      var sessionId;
      return ctx.start().then(function (broker) {
        broker.on('connecting', function (id) {
          sessionId = id;
        });
        return ctx.client().open();
      }).then(function () {
        return delay(20);
      }).then(function () {
        assert.isString(sessionId);
      });
    });

    it('emits connected with CONNECT headers and replies CONNECTED', function () {
      var event;
      return ctx.start().then(function (broker) {
        broker.on('connected', function (sessionId, headers) {
          event = {sessionId: sessionId, headers: headers};
        });
        return ctx.client().connect({login: 'me', passcode: 'pw'});
      }).then(function (connected) {
        assert.equal(connected.headers.version, '1.1');
        assert.equal(connected.headers.session, event.sessionId);
        assert.match(connected.headers.server, /^STOMP-JS\//);
        assert.equal(event.headers.login, 'me');
        assert.equal(event.headers.passcode, 'pw');
      });
    });

    it('uses the configured serverName', function () {
      return ctx.start({serverName: 'my-broker'}).then(function () {
        return ctx.client().connect();
      }).then(function (connected) {
        assert.equal(connected.headers.server, 'my-broker');
      });
    });

    it('accepts the STOMP command as an alias of CONNECT', function () {
      var client;
      return ctx.start().then(function () {
        client = ctx.client();
        return client.open();
      }).then(function () {
        client.send('STOMP', {'accept-version': '1.1', host: 'localhost'});
        return client.waitForCommand('CONNECTED');
      });
    });

    it('rejects frames sent before CONNECT', function () {
      var client;
      return ctx.start().then(function (broker) {
        client = ctx.client();
        return client.open().then(function () {
          client.send('SUBSCRIBE', {destination: '/a', id: 's1'});
          return client.waitForCommand('ERROR');
        }).then(function () {
          assert.lengthOf(broker.subscribes, 0);
          return client.waitForClose();
        });
      });
    });

    it('rejects a client without a common protocol version', function () {
      var client;
      return ctx.start().then(function () {
        client = ctx.client();
        return client.open();
      }).then(function () {
        client.send('CONNECT', {'accept-version': '9.9'});
        return client.waitForCommand('ERROR');
      }).then(function () {
        return client.waitForClose();
      });
    });

    it('negotiates the highest common protocol version', function () {
      return ctx.start().then(function () {
        return ctx.client().connect({'accept-version': '1.0,1.1,1.2'});
      }).then(function (connected) {
        assert.equal(connected.headers.version, '1.1');
      });
    });

    it('does not escape headers for STOMP 1.0 sessions', function () {
      var client;
      return ctx.start().then(function () {
        client = ctx.client();
        return client.connect({'accept-version': '1.0'});
      }).then(function (connected) {
        assert.equal(connected.headers.version, '1.0');
        return client.subscribe('/t', 's1');
      }).then(function () {
        ctx.broker.send('/t', {url: 'http://x:80/'}, 'x');
        return client.waitForCommand('MESSAGE');
      }).then(function (msg) {
        assert.equal(msg.headers.url, 'http://x:80/');
      });
    });

    it('emits disconnected when the socket closes', function () {
      var disconnected = null;
      var client;
      return ctx.start().then(function (broker) {
        broker.on('disconnected', function (id) {
          disconnected = id;
        });
        return connectedClient();
      }).then(function (c) {
        client = c;
        client.ws.close();
        return delay(100);
      }).then(function () {
        assert.equal(disconnected, client.frames[0].headers.session);
      });
    });

    it('removes the subscriptions of a closed connection', function () {
      var client;
      return ctx.start().then(function () {
        return connectedClient();
      }).then(function (c) {
        client = c;
        return client.subscribe('/a', 's1');
      }).then(function () {
        assert.lengthOf(ctx.broker.subscribes, 1);
        client.ws.close();
        return delay(100);
      }).then(function () {
        assert.lengthOf(ctx.broker.subscribes, 0);
      });
    });

    it('answers unknown commands without closing the connection', function () {
      var client;
      return ctx.start().then(function () {
        return connectedClient();
      }).then(function (c) {
        client = c;
        client.send('FOO', {});
        return delay(50);
      }).then(function () {
        assert.isFalse(client.closed);
      });
    });
  });


  describe('client subscriptions', function () {
    it('delivers messages between clients', function () {
      var sender;
      var receiver;
      return ctx.start().then(function () {
        return Promise.all([connectedClient(), connectedClient()]);
      }).then(function (clients) {
        sender = clients[0];
        receiver = clients[1];
        return receiver.subscribe('/chat', 'sub-9');
      }).then(function () {
        sender.send('SEND', {destination: '/chat', custom: 'yes'}, 'hi');
        return receiver.waitForCommand('MESSAGE');
      }).then(function (msg) {
        assert.equal(msg.body, 'hi');
        assert.equal(msg.headers.destination, '/chat');
        assert.equal(msg.headers.subscription, 'sub-9');
        assert.equal(msg.headers.custom, 'yes');
      });
    });

    it('does not echo a message back to its sender', function () {
      var client;
      return ctx.start().then(function () {
        return connectedClient();
      }).then(function (c) {
        client = c;
        return client.subscribe('/chat', 's1');
      }).then(function () {
        client.send('SEND', {destination: '/chat'}, 'hi');
        return client.collect(100);
      }).then(function () {
        assert.lengthOf(client.messages(), 0);
      });
    });

    it('delivers to every matching subscriber', function () {
      var a;
      var b;
      return ctx.start().then(function () {
        return Promise.all([connectedClient(), connectedClient()]);
      }).then(function (clients) {
        a = clients[0];
        b = clients[1];
        return Promise.all([a.subscribe('/t', 'a1'), b.subscribe('/t', 'b1')]);
      }).then(function () {
        ctx.broker.send('/t', {}, 'x');
        return Promise.all([a.waitForCommand('MESSAGE'), b.waitForCommand('MESSAGE')]);
      }).then(function (msgs) {
        assert.equal(msgs[0].headers.subscription, 'a1');
        assert.equal(msgs[1].headers.subscription, 'b1');
      });
    });

    it('delivers once per subscription when a client subscribes twice', function () {
      var client;
      return ctx.start().then(function () {
        return connectedClient();
      }).then(function (c) {
        client = c;
        return Promise.all([client.subscribe('/t', 's1'), client.subscribe('/t.*', 's2')]);
      }).then(function () {
        ctx.broker.send('/t', {}, 'x');
        return client.collect(100);
      }).then(function () {
        assert.deepEqual(client.messages().map(function (m) {
          return m.headers.subscription;
        }), ['s1']);
      });
    });

    it('stops delivery after UNSUBSCRIBE and emits unsubscribe', function () {
      var client;
      var unsubscribed;
      return ctx.start().then(function (broker) {
        broker.on('unsubscribe', function (sub) {
          unsubscribed = sub;
        });
        return connectedClient();
      }).then(function (c) {
        client = c;
        return client.subscribe('/t', 's1');
      }).then(function () {
        client.send('UNSUBSCRIBE', {id: 's1'});
        return delay(50);
      }).then(function () {
        assert.equal(unsubscribed.id, 's1');
        ctx.broker.send('/t', {}, 'x');
        return client.collect(100);
      }).then(function () {
        assert.lengthOf(client.messages(), 0);
      });
    });

    it('answers UNSUBSCRIBE of an unknown id with ERROR', function () {
      var client;
      return ctx.start().then(function () {
        return connectedClient();
      }).then(function (c) {
        client = c;
        client.send('UNSUBSCRIBE', {id: 'nope'});
        return client.waitForCommand('ERROR');
      });
    });

    it('cannot unsubscribe another session\'s subscription', function () {
      var a;
      var b;
      return ctx.start().then(function () {
        return Promise.all([connectedClient(), connectedClient()]);
      }).then(function (clients) {
        a = clients[0];
        b = clients[1];
        return a.subscribe('/t', 'shared-id');
      }).then(function () {
        b.send('UNSUBSCRIBE', {id: 'shared-id'});
        return delay(50);
      }).then(function () {
        ctx.broker.send('/t', {}, 'x');
        return a.waitForCommand('MESSAGE');
      });
    });

    it('does not forward the sender\'s receipt header to subscribers', function () {
      var sender;
      var receiver;
      return ctx.start().then(function () {
        return Promise.all([connectedClient(), connectedClient()]);
      }).then(function (clients) {
        sender = clients[0];
        receiver = clients[1];
        return receiver.subscribe('/t', 's1');
      }).then(function () {
        sender.send('SEND', {destination: '/t', receipt: 'secret-receipt'}, 'x');
        return receiver.waitForCommand('MESSAGE');
      }).then(function (msg) {
        assert.notProperty(msg.headers, 'receipt');
      });
    });

    it('does not let a sender spoof message-id or subscription headers', function () {
      var sender;
      var receiver;
      return ctx.start().then(function () {
        return Promise.all([connectedClient(), connectedClient()]);
      }).then(function (clients) {
        sender = clients[0];
        receiver = clients[1];
        return receiver.subscribe('/t', 's1');
      }).then(function () {
        sender.send('SEND', {destination: '/t', 'message-id': 'fake', subscription: 'fake'}, 'x');
        return receiver.waitForCommand('MESSAGE');
      }).then(function (msg) {
        assert.equal(msg.headers.subscription, 's1');
        assert.notEqual(msg.headers['message-id'], 'fake');
      });
    });

    it('a closing subscriber does not break delivery for the sender', function () {
      var sender;
      var closing;
      var other;
      return ctx.start().then(function () {
        return Promise.all([connectedClient(), connectedClient(), connectedClient()]);
      }).then(function (clients) {
        sender = clients[0];
        closing = clients[1];
        other = clients[2];
        return Promise.all([closing.subscribe('/t', 'c1'), other.subscribe('/t', 'o1')]);
      }).then(function () {
        // mark the broker side socket of `closing` as closing without removing its subscription
        ctx.broker.subscribes.forEach(function (sub) {
          if (sub.id === 'c1') {
            sub.socket.close();
          }
        });
        sender.send('SEND', {destination: '/t', receipt: 'r1'}, 'x');
        return Promise.all([sender.waitForCommand('RECEIPT'), other.waitForCommand('MESSAGE')]);
      }).then(function () {
        assert.isFalse(sender.closed);
      });
    });

    it('generates a unique message-id per message', function () {
      var client;
      return ctx.start().then(function () {
        return connectedClient();
      }).then(function (c) {
        client = c;
        return client.subscribe('/t', 's1');
      }).then(function () {
        ctx.broker.send('/t', {}, 'a');
        ctx.broker.send('/t', {}, 'b');
        return client.collect(100);
      }).then(function () {
        var ids = client.messages().map(function (m) {
          return m.headers['message-id'];
        });
        assert.lengthOf(ids, 2);
        assert.isString(ids[0]);
        assert.notEqual(ids[0], ids[1]);
      });
    });
  });


  describe('server-side API', function () {
    it('subscribe() callback receives client messages with headers', function () {
      var received;
      return ctx.start().then(function (broker) {
        broker.subscribe('/in', function (body, headers) {
          received = {body: body, headers: headers};
        });
        return connectedClient();
      }).then(function (client) {
        client.send('SEND', {destination: '/in', foo: 'bar'}, 'payload');
        return delay(50);
      }).then(function () {
        assert.equal(received.body, 'payload');
        assert.equal(received.headers.destination, '/in');
        assert.equal(received.headers.foo, 'bar');
      });
    });

    it('subscribe() returns the id and also emits it as an event', function () {
      var hits = 0;
      return ctx.start().then(function (broker) {
        var id = broker.subscribe('/in');
        assert.match(id, /^self_/);
        broker.on(id, function () {
          hits++;
        });
        return connectedClient();
      }).then(function (client) {
        client.send('SEND', {destination: '/in'}, 'x');
        return delay(50);
      }).then(function () {
        assert.equal(hits, 1);
      });
    });

    it('subscribe() and send() require a destination', function () {
      return ctx.start().then(function (broker) {
        assert.throws(function () {
          broker.subscribe(undefined, function () {});
        }, Error);
        assert.throws(function () {
          broker.send(undefined, {}, 'x');
        }, Error);
      });
    });

    it('subscribe() uses headers.id when provided', function () {
      return ctx.start().then(function (broker) {
        assert.equal(broker.subscribe('/in', null, {id: 'mine'}), 'mine');
      });
    });

    it('unsubscribe() returns false for an unknown id', function () {
      return ctx.start().then(function (broker) {
        assert.isFalse(broker.unsubscribe('nope'));
      });
    });

    it('emits send with destination, headers and body', function () {
      var event;
      return ctx.start().then(function (broker) {
        broker.on('send', function (e) {
          event = e;
        });
        broker.send('/out', {foo: 'bar'}, 'body');
        assert.equal(event.dest, '/out');
        assert.equal(event.frame.body, 'body');
        assert.equal(event.frame.headers.foo, 'bar');
      });
    });

    it('does not mutate the headers object passed to send()', function () {
      var headers = {foo: 'bar'};
      return ctx.start().then(function (broker) {
        return connectedClient().then(function (client) {
          return client.subscribe('/out', 's1').then(function () {
            broker.send('/out', headers, 'body');
            return client.waitForCommand('MESSAGE');
          });
        });
      }).then(function () {
        assert.deepEqual(headers, {foo: 'bar'});
      });
    });

    it('throws an Error (not a string) for a body that is neither string nor Buffer', function () {
      return ctx.start().then(function (broker) {
        assert.throws(function () {
          broker.send('/out', {}, 42);
        }, Error);
      });
    });

    it('sends a Buffer body with a byte content-length', function () {
      var body = Buffer.from([1, 2, 3, 0, 255]);
      return ctx.start().then(function (broker) {
        return connectedClient().then(function (client) {
          return client.subscribe('/bin', 's1').then(function () {
            broker.send('/bin', {'content-type': 'application/octet-stream'}, body);
            return client.waitForCommand('MESSAGE');
          });
        });
      }).then(function (msg) {
        assert.equal(msg.headers['content-length'], '5');
        assert.isTrue(Buffer.isBuffer(msg.raw));
        assert.isTrue(msg.raw.slice(msg.raw.length - 6, msg.raw.length - 1).equals(body));
      });
    });
  });


  describe('JSON bodies', function () {
    it('parses application/json bodies for server-side subscribers', function () {
      var received;
      return ctx.start().then(function (broker) {
        broker.subscribe('/json', function (body) {
          received = body;
        });
        return connectedClient();
      }).then(function (client) {
        client.send('SEND', {destination: '/json', 'content-type': 'application/json'}, '{"a":1}');
        return delay(50);
      }).then(function () {
        assert.deepEqual(received, {a: 1});
      });
    });

    it('forwards application/json bodies to clients as JSON text', function () {
      var sender;
      var receiver;
      return ctx.start().then(function () {
        return Promise.all([connectedClient(), connectedClient()]);
      }).then(function (clients) {
        sender = clients[0];
        receiver = clients[1];
        return receiver.subscribe('/json', 's1');
      }).then(function () {
        sender.send('SEND', {destination: '/json', 'content-type': 'application/json'}, '{"a":[1,2]}');
        return receiver.waitForCommand('MESSAGE');
      }).then(function (msg) {
        assert.deepEqual(JSON.parse(msg.body), {a: [1, 2]});
        assert.equal(msg.headers['content-type'], 'application/json');
      });
    });

    it('server send() of an object with application/json reaches clients as JSON', function () {
      return ctx.start().then(function (broker) {
        return connectedClient().then(function (client) {
          return client.subscribe('/json', 's1').then(function () {
            broker.send('/json', {'content-type': 'application/json'}, '{"b":2}');
            return client.waitForCommand('MESSAGE');
          });
        });
      }).then(function (msg) {
        assert.deepEqual(JSON.parse(msg.body), {b: 2});
      });
    });
  });


  describe('middleware', function () {
    it('runs handlers in registration order before the command', function () {
      var calls = [];
      return ctx.start().then(function (broker) {
        broker.addMiddleware('connect', function (socket, args, next) {
          calls.push(1);
          return next();
        });
        broker.addMiddleware('CONNECT', function (socket, args, next) {
          calls.push(2);
          return next();
        });
        return ctx.client().connect();
      }).then(function () {
        assert.deepEqual(calls, [1, 2]);
      });
    });

    it('setMiddleware replaces existing handlers', function () {
      var calls = [];
      return ctx.start().then(function (broker) {
        broker.addMiddleware('connect', function (socket, args, next) {
          calls.push('old');
          return next();
        });
        broker.setMiddleware('connect', function (socket, args, next) {
          calls.push('new');
          return next();
        });
        return ctx.client().connect();
      }).then(function () {
        assert.deepEqual(calls, ['new']);
      });
    });

    it('removeMiddleware removes a handler', function () {
      var calls = [];
      function handler(socket, args, next) {
        calls.push('x');
        return next();
      }
      return ctx.start().then(function (broker) {
        broker.addMiddleware('connect', handler);
        broker.removeMiddleware('connect', handler);
        return ctx.client().connect();
      }).then(function () {
        assert.deepEqual(calls, []);
      });
    });

    it('removeMiddleware for a command without handlers does not throw', function () {
      return ctx.start().then(function (broker) {
        broker.removeMiddleware('send', function () {});
      });
    });

    it('send middleware can block delivery', function () {
      var sender;
      var receiver;
      return ctx.start().then(function (broker) {
        broker.addMiddleware('send', function (socket, args, next) {
          return args.dest === '/blocked' ? false : next();
        });
        return Promise.all([connectedClient(), connectedClient()]);
      }).then(function (clients) {
        sender = clients[0];
        receiver = clients[1];
        return Promise.all([receiver.subscribe('/blocked', 's1'), receiver.subscribe('/open', 's2')]);
      }).then(function () {
        sender.send('SEND', {destination: '/blocked'}, 'x');
        sender.send('SEND', {destination: '/open'}, 'y');
        return receiver.collect(100);
      }).then(function () {
        assert.deepEqual(receiver.messages().map(function (m) {
          return m.body;
        }), ['y']);
      });
    });

    it('rejected SEND is answered with ERROR', function () {
      var client;
      return ctx.start().then(function (broker) {
        broker.addMiddleware('send', function () {
          return false;
        });
        return connectedClient();
      }).then(function (c) {
        client = c;
        client.send('SEND', {destination: '/x'}, 'x');
        return client.waitForCommand('ERROR');
      });
    });

    it('subscribe middleware can reject with ERROR and no subscription is stored', function () {
      var client;
      return ctx.start().then(function (broker) {
        broker.addMiddleware('subscribe', function (socket, args, next) {
          return args.dest.indexOf('/private') === 0 ? false : next();
        });
        return connectedClient();
      }).then(function (c) {
        client = c;
        client.send('SUBSCRIBE', {destination: '/private.x', id: 's1'});
        return client.waitForCommand('ERROR');
      }).then(function () {
        assert.lengthOf(ctx.broker.subscribes, 0);
      });
    });

    it('subscribe middleware can modify the destination', function () {
      return ctx.start().then(function (broker) {
        broker.addMiddleware('subscribe', function (socket, args, next) {
          args.dest = '/tenant.' + args.dest.substring(1);
          return next();
        });
        return connectedClient();
      }).then(function (client) {
        return client.subscribe('/news', 's1');
      }).then(function () {
        assert.equal(ctx.broker.subscribes[0].topic, '/tenant.news');
      });
    });

    it('supports asynchronous connect middleware', function () {
      return ctx.start().then(function (broker) {
        broker.addMiddleware('connect', function (socket, args, next) {
          return new Promise(function (resolve) {
            setTimeout(function () {
              resolve(next());
            }, 20);
          });
        });
        return ctx.client().connect();
      });
    });
  });


  describe('asynchronous middleware', function () {
    function later(ms, fn) {
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve(fn());
        }, ms);
      });
    }

    it('does not accept a connection that closed while connect middleware was pending', function () {
      var events = [];
      var brokerSocket;
      return ctx.start({heartbeat: [100, 0]}).then(function (broker) {
        broker.on('connected', function () {
          events.push('connected');
        });
        broker.on('disconnected', function () {
          events.push('disconnected');
        });
        broker.addMiddleware('connect', function (socket, args, next) {
          brokerSocket = socket;
          return later(100, next);
        });
        var client = ctx.client();
        return client.open().then(function () {
          client.send('CONNECT', {'accept-version': '1.1', 'heart-beat': '0,100'});
          return delay(20);
        }).then(function () {
          client.close();
          return delay(200);
        });
      }).then(function () {
        assert.notInclude(events, 'connected');
        assert.isUndefined(brokerSocket.heartbeatClock, 'heart-beat timer leaked');
        assert.isUndefined(brokerSocket.heartbeatCheckClock, 'heart-beat timer leaked');
      });
    });

    it('emits disconnected on close after async disconnect middleware rejected DISCONNECT', function () {
      var disconnected = 0;
      var client;
      return ctx.start().then(function (broker) {
        broker.on('disconnected', function () {
          disconnected++;
        });
        // refuse the DISCONNECT frame, allow the cleanup when the socket closes
        broker.addMiddleware('disconnect', function (socket, receipt, next) {
          return later(20, function () {
            return receipt === 'deny' ? false : next();
          });
        });
        return connectedClient();
      }).then(function (c) {
        client = c;
        client.send('DISCONNECT', {receipt: 'deny'});
        return client.waitForCommand('ERROR');
      }).then(function () {
        client.ws.close();
        return delay(200);
      }).then(function () {
        assert.equal(disconnected, 1);
      });
    });

    it('reports a rejected async disconnect middleware on socket close as error event', function () {
      var unhandled = [];
      var errors = [];
      function onUnhandled(reason) {
        unhandled.push(reason);
      }
      process.on('unhandledRejection', onUnhandled);
      return ctx.start().then(function (broker) {
        broker.on('error', function (err) {
          errors.push(err);
        });
        broker.addMiddleware('disconnect', function () {
          return Promise.reject(new Error('disconnect failed'));
        });
        return connectedClient();
      }).then(function (client) {
        client.ws.close();
        return delay(200);
      }).then(function () {
        process.removeListener('unhandledRejection', onUnhandled);
        assert.lengthOf(unhandled, 0, 'unhandled rejection: ' + unhandled[0]);
        assert.lengthOf(errors, 1);
        assert.equal(errors[0].message, 'disconnect failed');
      }, function (err) {
        process.removeListener('unhandledRejection', onUnhandled);
        throw err;
      });
    });
  });


  describe('heart-beats', function () {
    this.timeout(5000);

    it('answers 0,0 when heart-beats are disabled on the server', function () {
      return ctx.start({heartbeat: [0, 0]}).then(function () {
        return ctx.client().connect({'heart-beat': '1000,1000'});
      }).then(function (connected) {
        assert.equal(connected.headers['heart-beat'], '0,0');
      });
    });

    it('answers 0,0 when the client does not ask for heart-beats', function () {
      return ctx.start({heartbeat: [500, 500]}).then(function () {
        return ctx.client().connect();
      }).then(function (connected) {
        assert.equal(connected.headers['heart-beat'], '0,0');
      });
    });

    it('uses the larger of client and server intervals', function () {
      return ctx.start({heartbeat: [0, 300]}).then(function () {
        return ctx.client().connect({'heart-beat': '800,0'});
      }).then(function (connected) {
        assert.equal(connected.headers['heart-beat'], '0,800');
      });
    });

    it('closes a connection whose client stops beating', function () {
      var client;
      return ctx.start({heartbeat: [0, 200], heartbeatErrorMargin: 100}).then(function () {
        return connectedClient({'heart-beat': '200,0'});
      }).then(function (c) {
        client = c;
        return client.waitForClose(2000);
      });
    });

    it('any incoming frame counts as a heart-beat', function () {
      var client;
      var timer;
      return ctx.start({heartbeat: [0, 200], heartbeatErrorMargin: 100}).then(function () {
        return connectedClient({'heart-beat': '200,0'});
      }).then(function (c) {
        client = c;
        timer = setInterval(function () {
          client.send('SEND', {destination: '/keepalive'}, 'x');
        }, 150);
        return delay(1000);
      }).then(function () {
        clearInterval(timer);
        assert.isFalse(client.closed);
      });
    });

    it('stops heart-beat timers when the connection closes', function () {
      var socket;
      return ctx.start({heartbeat: [200, 0]}).then(function (broker) {
        broker.on('connected', function () {
          socket = broker.socket.clients.values().next().value;
        });
        return connectedClient({'heart-beat': '0,200'});
      }).then(function (client) {
        assert.isDefined(socket.heartbeatClock);
        client.ws.close();
        return delay(100);
      }).then(function () {
        assert.isUndefined(socket.heartbeatClock);
      });
    });
  });


  describe('sockjs adapter', function () {
    this.timeout(5000);

    // sockjs exposes a raw WebSocket endpoint at <prefix>/websocket
    var RAW_PATH = '/stomp/websocket';

    function sockjs(config) {
      return Object.assign({protocol: 'sockjs', protocolConfig: {log: function () {}}}, config);
    }

    it('connects over the raw sockjs websocket endpoint', function () {
      return ctx.start(sockjs()).then(function () {
        return ctx.client(RAW_PATH).connect();
      }).then(function (connected) {
        assert.equal(connected.command, 'CONNECTED');
      });
    });

    it('routes messages between sockjs clients', function () {
      var sender;
      var receiver;
      return ctx.start(sockjs()).then(function () {
        return Promise.all([connectedClient({}, RAW_PATH), connectedClient({}, RAW_PATH)]);
      }).then(function (clients) {
        sender = clients[0];
        receiver = clients[1];
        return receiver.subscribe('/t', 's1');
      }).then(function () {
        sender.send('SEND', {destination: '/t'}, 'over sockjs');
        return receiver.waitForCommand('MESSAGE');
      }).then(function (msg) {
        assert.equal(msg.body, 'over sockjs');
      });
    });

    it('sends server heart-beats to sockjs clients (#33)', function () {
      var client;
      return ctx.start(sockjs({heartbeat: [300, 0]})).then(function () {
        return connectedClient({'heart-beat': '0,300'}, RAW_PATH);
      }).then(function (c) {
        client = c;
        return client.waitForCommand('HEARTBEAT', 1500);
      });
    });

    it('emits disconnected when a sockjs client closes', function () {
      var disconnected = false;
      return ctx.start(sockjs()).then(function (broker) {
        broker.on('disconnected', function () {
          disconnected = true;
        });
        return connectedClient({}, RAW_PATH);
      }).then(function (client) {
        client.ws.close();
        return delay(200);
      }).then(function () {
        assert.isTrue(disconnected);
      });
    });
  });
});
