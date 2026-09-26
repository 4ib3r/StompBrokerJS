/**
 * STOMP specification compliance, one describe per spec section or finding of
 * plan/stomp-1.1-compliance.md and plan/stomp-1.2-compliance.md.
 */
var assert = require('chai').assert;

var support = require('./support/raw-client');

var buildFrame = support.buildFrame;


describe('STOMP specification compliance', function () {
  var ctx = support.useBroker();

  function connectedClient(headers) {
    var client = ctx.client();
    return client.connect(headers).then(function () {
      return client;
    });
  }

  /** Sender and a receiver subscribed to `dest` */
  function senderAndReceiver(dest) {
    var clients;
    return Promise.all([connectedClient(), connectedClient()]).then(function (c) {
      clients = {sender: c[0], receiver: c[1]};
      return clients.receiver.subscribe(dest, 'sub-1');
    }).then(function () {
      return clients;
    });
  }

  /**
   * Async `send` middleware that holds the SENDs for which `shouldHold(args)`
   * is true until the test calls `held[body]()`. Other SENDs pass through
   * (asynchronously, but without waiting for the test).
   */
  function holdSends(broker, shouldHold) {
    var held = {};
    broker.addMiddleware('send', function (socket, args, next) {
      if (shouldHold(args)) {
        return new Promise(function (resolve) {
          held[String(args.frame.body)] = function () {
            resolve(next());
          };
        });
      }
      return Promise.resolve().then(next);
    });
    return held;
  }

  /** Resolve once `condition()` is true, polling on the event loop */
  function waitUntil(condition) {
    return new Promise(function check(resolve) {
      if (condition()) {
        return resolve();
      }
      setImmediate(check, resolve);
    });
  }

  /**
   * WebSocket ping round trip on the client's connection: once it resolves,
   * every frame the broker wrote to this connection before it answered the
   * ping has been received. Resolves on close as well (a closing connection
   * doesn't answer pings).
   */
  function roundTrip(client) {
    return new Promise(function (resolve) {
      if (client.closed || client.ws.readyState !== 1) {
        return resolve();
      }
      client.ws.once('pong', resolve);
      client.ws.once('close', resolve);
      client.ws.ping();
    });
  }

  function bodies(client) {
    return client.messages().map(function (m) {
      return m.body;
    });
  }

  function onDestination(dest) {
    return function (args) {
      return args.dest === dest;
    };
  }

  function waitForDisconnected() {
    return new Promise(function (resolve) {
      ctx.broker.once('disconnected', resolve);
    });
  }


  describe('RECEIPT: previously received frames are processed after a disconnect (B1)', function () {
    it('delivers a SEND whose send middleware is still pending when DISCONNECT arrives', function () {
      var held;
      var clients;
      return ctx.start().then(function (broker) {
        held = holdSends(broker, onDestination('/a'));
        return senderAndReceiver('/a');
      }).then(function (c) {
        clients = c;
        // one WebSocket message: both frames reached the broker once the
        // middleware has been called
        clients.sender.sendRaw(buildFrame('SEND', {destination: '/a'}, 'before-disconnect') +
          buildFrame('DISCONNECT', {receipt: 'bye'}));
        return waitUntil(function () {
          return held['before-disconnect'];
        });
      }).then(function () {
        held['before-disconnect']();
        return clients.receiver.waitForCommand('MESSAGE');
      }).then(function (message) {
        assert.equal(message.body, 'before-disconnect');
        assert.equal(message.headers.destination, '/a');
      });
    });

    it('sends the DISCONNECT RECEIPT only after the pending SEND was processed', function () {
      var held;
      var clients;
      return ctx.start().then(function (broker) {
        held = holdSends(broker, onDestination('/a'));
        return senderAndReceiver('/a');
      }).then(function (c) {
        clients = c;
        clients.sender.sendRaw(buildFrame('SEND', {destination: '/a'}, 'before-disconnect') +
          buildFrame('DISCONNECT', {receipt: 'bye'}));
        // the frames of one WebSocket message are decoded in one go, so the
        // DISCONNECT has reached the broker once the SEND is in the middleware
        return waitUntil(function () {
          return held['before-disconnect'];
        });
      }).then(function () {
        // anything the broker already wrote to the sender arrives before the pong
        return roundTrip(clients.sender);
      }).then(function () {
        assert.notInclude(clients.sender.frames.map(function (f) {
          return f.command;
        }), 'RECEIPT', 'DISCONNECT RECEIPT sent while a previously received SEND was still being processed');
        assert.isFalse(clients.sender.closed, 'connection closed before the pending SEND was processed');
        held['before-disconnect']();
        return clients.sender.waitForCommand('RECEIPT');
      }).then(function (receipt) {
        assert.equal(receipt.headers['receipt-id'], 'bye');
        return clients.receiver.waitForCommand('MESSAGE');
      }).then(function (message) {
        assert.equal(message.body, 'before-disconnect');
        return clients.sender.waitForClose();
      });
    });

    it('delivers a SEND whose send middleware is still pending when the connection closes', function () {
      var held;
      var clients;
      return ctx.start().then(function (broker) {
        held = holdSends(broker, onDestination('/a'));
        return senderAndReceiver('/a');
      }).then(function (c) {
        clients = c;
        clients.sender.send('SEND', {destination: '/a'}, 'before-close');
        return waitUntil(function () {
          return held['before-close'];
        });
      }).then(function () {
        var disconnected = waitForDisconnected();
        clients.sender.close();
        return disconnected;
      }).then(function () {
        held['before-close']();
        return clients.receiver.waitForCommand('MESSAGE');
      }).then(function (message) {
        assert.equal(message.body, 'before-close');
      });
    });

    it('delivers SENDs of one client in the order they were received, even if the first middleware is slower', function () {
      var held;
      var clients;
      return ctx.start().then(function (broker) {
        // only the first SEND waits for the test, the second one passes through
        held = holdSends(broker, function (args) {
          return args.dest === '/a' && String(args.frame.body) === 'first';
        });
        return senderAndReceiver('/a');
      }).then(function (c) {
        clients = c;
        clients.sender.sendRaw(buildFrame('SEND', {destination: '/a'}, 'first') +
          buildFrame('SEND', {destination: '/a'}, 'second'));
        return waitUntil(function () {
          return held.first;
        });
      }).then(function () {
        held.first();
        return clients.receiver.waitFor(function () {
          return clients.receiver.messages().length >= 2;
        }, 1000, 'two MESSAGEs');
      }).then(function () {
        assert.deepEqual(bodies(clients.receiver), ['first', 'second']);
      });
    });

    describe('guards that stay in place', function () {
      it('does not store a SUBSCRIBE whose middleware finishes after the connection closed', function () {
        var release;
        var client;
        return ctx.start().then(function (broker) {
          broker.addMiddleware('subscribe', function (socket, args, next) {
            return new Promise(function (resolve) {
              release = function () {
                resolve(next());
              };
            });
          });
          return connectedClient();
        }).then(function (c) {
          client = c;
          client.send('SUBSCRIBE', {destination: '/a', id: 's1'});
          return waitUntil(function () {
            return release;
          });
        }).then(function () {
          var disconnected = waitForDisconnected();
          client.close();
          return disconnected;
        }).then(function () {
          // the subscription is registered synchronously by next()
          release();
          assert.lengthOf(ctx.broker.subscribes, 0);
        });
      });

      it('does not deliver a transactional SEND pending when the connection closes (transaction aborted)', function () {
        var held;
        var clients;
        return ctx.start().then(function (broker) {
          held = holdSends(broker, onDestination('/a'));
          return senderAndReceiver('/a');
        }).then(function (c) {
          clients = c;
          return clients.sender.sendWithReceipt('BEGIN', {transaction: 'tx1'});
        }).then(function (reply) {
          assert.equal(reply.command, 'RECEIPT');
          clients.sender.send('SEND', {destination: '/a', transaction: 'tx1'}, 'in-tx');
          return waitUntil(function () {
            return held['in-tx'];
          });
        }).then(function () {
          var disconnected = waitForDisconnected();
          clients.sender.close();
          return disconnected;
        }).then(function () {
          held['in-tx']();
          // the receiver's own SEND round trip passes the send middleware too
          return clients.receiver.flush();
        }).then(function () {
          assert.lengthOf(clients.receiver.messages(), 0);
        });
      });

      it('ignores frames after DISCONNECT in the same WebSocket message', function () {
        var clients;
        return ctx.start().then(function () {
          return senderAndReceiver('/a');
        }).then(function (c) {
          clients = c;
          clients.sender.sendRaw(buildFrame('DISCONNECT', {receipt: 'bye'}) +
            buildFrame('SEND', {destination: '/a'}, 'late') +
            buildFrame('SUBSCRIBE', {destination: '/**', id: 'spy'}));
          return clients.sender.waitForCommand('RECEIPT');
        }).then(function () {
          return clients.sender.waitForClose();
        }).then(function () {
          return clients.receiver.flush();
        }).then(function () {
          assert.lengthOf(clients.receiver.messages(), 0);
          assert.lengthOf(ctx.broker.subscribes, 1);
        });
      });
    });
  });


  describe('Protocol Negotiation (S1 / G5)', function () {
    it('lists the supported versions in the version header and body when no version is shared', function () {
      var client;
      return ctx.start().then(function () {
        client = ctx.client();
        return client.open();
      }).then(function () {
        client.send('CONNECT', {'accept-version': '2.0'});
        return client.waitForCommand('ERROR');
      }).then(function (error) {
        assert.equal(error.headers.version, '1.0,1.1');
        assert.equal(error.headers['content-type'], 'text/plain');
        assert.equal(error.body, 'Supported protocol versions are 1.0 1.1');
        return client.waitForClose();
      });
    });
  });


  describe('Value Encoding (N1)', function () {
    it('treats the undefined escape \\r in a STOMP 1.1 header as a fatal error naming it', function () {
      var client;
      return ctx.start().then(function () {
        return connectedClient({'accept-version': '1.1'});
      }).then(function (c) {
        client = c;
        client.send('SEND', {destination: '/a', x: 'a\\rb'});
        return client.waitForCommand('ERROR');
      }).then(function (error) {
        assert.include(error.body, 'Undefined escape sequence \\r');
        return client.waitForClose();
      });
    });

    it('keeps the undefined escape \\t in a STOMP 1.1 header verbatim (deliberate leniency)', function () {
      var client;
      var seen;
      return ctx.start().then(function (broker) {
        broker.addMiddleware('send', function (socket, args, next) {
          if (args.dest === '/a') {
            seen = args.frame.headers.x;
          }
          return next();
        });
        return connectedClient({'accept-version': '1.1'});
      }).then(function (c) {
        client = c;
        return client.sendWithReceipt('SEND', {destination: '/a', x: 'a\\tb'});
      }).then(function (reply) {
        assert.equal(reply.command, 'RECEIPT');
        assert.equal(seen, 'a\\tb');
        assert.isFalse(client.closed);
      });
    });
  });
});
