/**
 * Resource limits and session lifecycle: heart-beat bounds, CONNECT timeout,
 * frame and subscription limits, DISCONNECT, slow consumers, error texts.
 */
var assert = require('chai').assert;

var StompServer = require('../stompServer');
var support = require('./support/raw-client');

var buildFrame = support.buildFrame;


describe('Limits and lifecycle', function () {
  var ctx = support.useBroker();

  function connectedClient(headers) {
    var client = ctx.client();
    return client.connect(headers).then(function () {
      return client;
    });
  }

  function expectError(client, text) {
    return client.waitForCommand('ERROR').then(function (error) {
      if (text !== undefined) {
        assert.equal(error.body, text);
      }
      return client.waitForClose();
    });
  }


  describe('heart-beats', function () {
    ['abc', '1,2,3', '-1,5', 'Infinity,1', '1.5,2', ''].forEach(function (value) {
      it('rejects the heart-beat header "' + value + '"', function () {
        var client;
        return ctx.start({heartbeat: [100, 100]}).then(function () {
          client = ctx.client();
          return client.open();
        }).then(function () {
          client.send('CONNECT', {'accept-version': '1.1', 'heart-beat': value});
          return expectError(client, 'Invalid heart-beat header');
        });
      });
    });

    it('bounds a huge client interval instead of overflowing the timer', function () {
      var client;
      return ctx.start({heartbeat: [100, 100]}).then(function () {
        client = ctx.client();
        return client.connect({'heart-beat': '99999999999,99999999999'});
      }).then(function (connected) {
        assert.equal(connected.headers['heart-beat'], '2147483647,2147483647');
        // an overflowed interval would have sent pings every millisecond
        return client.flush();
      }).then(function () {
        assert.lengthOf(client.frames.filter(function (f) {
          return f.command === 'HEARTBEAT';
        }), 0);
      });
    });
  });


  describe('CONNECT timeout', function () {
    it('closes a connection that does not send CONNECT in time', function () {
      var client;
      return ctx.start({limits: {connectTimeout: 100}}).then(function () {
        client = ctx.client();
        return client.open();
      }).then(function () {
        return expectError(client, 'CONNECT frame not received in time');
      });
    });

    it('does not close a connected client', function () {
      var connected;
      return ctx.start({limits: {connectTimeout: 100}}).then(function () {
        return connectedClient();
      }).then(function (c) {
        connected = c;
        // opened later, its timeout fires after the connected client's would have
        var idle = ctx.client();
        return idle.open().then(function () {
          return idle.waitForClose();
        });
      }).then(function () {
        assert.isFalse(connected.closed);
        return connected.flush();
      });
    });
  });


  describe('frame limits', function () {
    it('rejects a frame with too many headers', function () {
      var client;
      return ctx.start({limits: {maxHeaders: 3}}).then(function () {
        return connectedClient();
      }).then(function (c) {
        client = c;
        return client.sendWithReceipt('SEND', {destination: '/a', a: '1'});
      }).then(function (reply) {
        assert.equal(reply.command, 'RECEIPT', 'three headers are allowed');
        client.send('SEND', {destination: '/a', a: '1', b: '2', c: '3'});
        return expectError(client, 'Too many headers');
      });
    });

    it('rejects a header line that is too long', function () {
      var client;
      return ctx.start({limits: {maxHeaderLength: 20}}).then(function () {
        return connectedClient();
      }).then(function (c) {
        client = c;
        client.send('SEND', {destination: '/a', x: new Array(20).join('x')});
        return expectError(client, 'Header too long');
      });
    });

    it('rejects a frame larger than maxFrameSize sent in several messages', function () {
      var client;
      return ctx.start({limits: {maxFrameSize: 256}}).then(function () {
        return connectedClient();
      }).then(function (c) {
        client = c;
        var raw = buildFrame('SEND', {destination: '/a'}, new Array(300).join('x'));
        client.sendRaw(raw.substring(0, 200));
        client.sendRaw(raw.substring(200));
        return expectError(client, 'Frame too large');
      });
    });

    it('limits WebSocket messages to maxFrameSize', function () {
      var client;
      return ctx.start({limits: {maxFrameSize: 256}}).then(function () {
        return connectedClient();
      }).then(function (c) {
        client = c;
        return new Promise(function (resolve) {
          client.ws.on('close', resolve);
          client.sendRaw(buildFrame('SEND', {destination: '/a'}, new Array(300).join('x')));
        });
      }).then(function (code) {
        // ws closes with 1009 (message too big) or drops the connection (1006)
        assert.include([1006, 1009], code);
        assert.notInclude(client.frames.map(function (f) {
          return f.command;
        }), 'ERROR');
      });
    });

    it('lets protocolConfig override the transport defaults', function () {
      return ctx.start({limits: {maxFrameSize: 256}, protocolConfig: {maxPayload: 1024, perMessageDeflate: true}})
        .then(function (broker) {
          assert.equal(broker.socket.options.maxPayload, 1024);
          assert.isOk(broker.socket.options.perMessageDeflate);
        });
    });
  });


  describe('subscriptions', function () {
    it('requires an id header from STOMP 1.1 clients', function () {
      return ctx.start().then(function () {
        return connectedClient();
      }).then(function (client) {
        client.send('SUBSCRIBE', {destination: '/a'});
        return expectError(client, 'SUBSCRIBE requires an id header');
      });
    });

    it('accepts SUBSCRIBE and UNSUBSCRIBE by destination from STOMP 1.0 clients', function () {
      var client;
      return ctx.start().then(function () {
        return connectedClient({'accept-version': '1.0'});
      }).then(function (c) {
        client = c;
        return Promise.all([
          client.sendWithReceipt('SUBSCRIBE', {destination: '/a'}),
          client.sendWithReceipt('SUBSCRIBE', {destination: '/b'})
        ]);
      }).then(function (replies) {
        assert.deepEqual(replies.map(function (r) {
          return r.command;
        }), ['RECEIPT', 'RECEIPT']);
        ctx.broker.send('/a', {}, 'x');
        return client.waitForCommand('MESSAGE');
      }).then(function (msg) {
        assert.equal(msg.body, 'x');
        return client.sendWithReceipt('UNSUBSCRIBE', {destination: '/a'});
      }).then(function (reply) {
        assert.equal(reply.command, 'RECEIPT');
        assert.deepEqual(ctx.broker.subscribes.map(function (sub) {
          return sub.topic;
        }), ['/b']);
      });
    });

    it('rejects an unsupported ack mode', function () {
      return ctx.start().then(function () {
        return connectedClient();
      }).then(function (client) {
        client.send('SUBSCRIBE', {destination: '/a', id: 's1', ack: 'sometimes'});
        return expectError(client, 'Unsupported ack mode sometimes');
      });
    });

    it('rejects a subscription id already used by the session', function () {
      var client;
      return ctx.start().then(function () {
        return connectedClient();
      }).then(function (c) {
        client = c;
        return client.subscribe('/a', 's1');
      }).then(function () {
        client.send('SUBSCRIBE', {destination: '/b', id: 's1'});
        return expectError(client, 'Subscription id s1 is already in use');
      });
    });

    it('allows the same subscription id in different sessions', function () {
      return ctx.start().then(function () {
        return Promise.all([connectedClient(), connectedClient()]);
      }).then(function (clients) {
        return Promise.all([clients[0].subscribe('/a', 's1'), clients[1].subscribe('/a', 's1')]);
      }).then(function () {
        assert.lengthOf(ctx.broker.subscribes, 2);
      });
    });

    it('limits the subscriptions of a session', function () {
      var client;
      return ctx.start({limits: {maxSubscriptions: 2}}).then(function () {
        return connectedClient();
      }).then(function (c) {
        client = c;
        return Promise.all([client.subscribe('/a', 's1'), client.subscribe('/b', 's2')]);
      }).then(function () {
        client.send('SUBSCRIBE', {destination: '/c', id: 's3'});
        return expectError(client, 'Too many subscriptions');
      });
    });

    it('does not store a subscription whose middleware finishes after the connection closed', function () {
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
        return new Promise(function (resolve) {
          ctx.broker.once('disconnected', resolve);
          client.close();
        });
      }).then(function () {
        // the middleware may only run once the SUBSCRIBE arrived
        return new Promise(function check(resolve) {
          if (release) {
            return resolve();
          }
          setImmediate(check, resolve);
        });
      }).then(function () {
        release();
        assert.lengthOf(ctx.broker.subscribes, 0);
      });
    });

    it('removes the subscriptions of a closed session in linear time', function () {
      return ctx.start({limits: {maxSubscriptions: Infinity}}).then(function (broker) {
        var closing = {sessionId: 'closing'};
        var other = {sessionId: 'other'};
        for (var i = 0; i < 50000; i++) {
          broker.onSubscribe(closing, {dest: '/a', id: 'c' + i});
          broker.onSubscribe(other, {dest: '/a', id: 'o' + i});
        }
        var start = process.hrtime.bigint();
        broker.afterConnectionClose(closing);
        var ms = Number(process.hrtime.bigint() - start) / 1e6;
        assert.lengthOf(broker.subscribes, 50000);
        assert.isTrue(broker.subscribes.every(function (sub) {
          return sub.sessionId === 'other';
        }));
        assert.isBelow(ms, 500);
      });
    });
  });


  describe('DISCONNECT', function () {
    it('answers the receipt and closes the connection', function () {
      var client;
      return ctx.start().then(function () {
        return connectedClient();
      }).then(function (c) {
        client = c;
        client.send('DISCONNECT', {receipt: 'bye'});
        return client.waitForCommand('RECEIPT');
      }).then(function (receipt) {
        assert.equal(receipt.headers['receipt-id'], 'bye');
        return client.waitForClose();
      });
    });

    it('ignores frames after DISCONNECT', function () {
      var sender;
      var receiver;
      return ctx.start().then(function () {
        return Promise.all([connectedClient(), connectedClient()]);
      }).then(function (clients) {
        sender = clients[0];
        receiver = clients[1];
        return receiver.subscribe('/a', 's1');
      }).then(function () {
        sender.sendRaw(buildFrame('DISCONNECT', {}) + buildFrame('SEND', {destination: '/a'}, 'late') +
          buildFrame('SUBSCRIBE', {destination: '/**', id: 'spy'}));
        return sender.waitForClose();
      }).then(function () {
        return receiver.flush();
      }).then(function () {
        assert.lengthOf(receiver.messages(), 0);
        assert.lengthOf(ctx.broker.subscribes, 1);
      });
    });

    it('ignores frames after DISCONNECT while disconnect middleware is pending', function () {
      var sender;
      var receiver;
      var release;
      return ctx.start().then(function (broker) {
        broker.addMiddleware('disconnect', function (socket, args, next) {
          return new Promise(function (resolve) {
            release = function () {
              resolve(next());
            };
          });
        });
        return Promise.all([connectedClient(), connectedClient()]);
      }).then(function (clients) {
        sender = clients[0];
        receiver = clients[1];
        return receiver.subscribe('/a', 's1');
      }).then(function () {
        sender.sendRaw(buildFrame('DISCONNECT', {receipt: 'bye'}) + buildFrame('SEND', {destination: '/a'}, 'late'));
        // the SEND after DISCONNECT has been handled once a later frame of the
        // receiver made the round trip; release the middleware afterwards
        return receiver.flush();
      }).then(function () {
        return new Promise(function check(resolve) {
          if (release) {
            return resolve();
          }
          setImmediate(check, resolve);
        });
      }).then(function () {
        release();
        return sender.waitForCommand('RECEIPT');
      }).then(function () {
        return sender.waitForClose();
      }).then(function () {
        return receiver.flush();
      }).then(function () {
        assert.lengthOf(receiver.messages(), 0);
      });
    });
  });


  describe('ERROR', function () {
    it('closes the connection after answering an unknown subscription id', function () {
      return ctx.start().then(function () {
        return connectedClient();
      }).then(function (client) {
        client.send('UNSUBSCRIBE', {id: 'nope'});
        return expectError(client, 'No subscription nope');
      });
    });

    it('does not send internal error details to the client', function () {
      var reported;
      return ctx.start().then(function (broker) {
        broker.on('error', function (err) {
          reported = err;
        });
        broker.addMiddleware('send', function () {
          throw new Error('db down at 10.0.0.5');
        });
        return connectedClient();
      }).then(function (client) {
        client.send('SEND', {destination: '/a'}, 'x');
        return expectError(client, 'Internal error');
      }).then(function () {
        assert.equal(reported.message, 'db down at 10.0.0.5');
      });
    });

    it('sends the message of a StompError to the client', function () {
      var reported = null;
      return ctx.start().then(function (broker) {
        broker.on('error', function (err) {
          reported = err;
        });
        broker.addMiddleware('subscribe', function () {
          return Promise.reject(new StompServer.StompError('Access denied'));
        });
        return connectedClient();
      }).then(function (client) {
        client.send('SUBSCRIBE', {destination: '/a', id: 's1'});
        return expectError(client, 'Access denied');
      }).then(function () {
        assert.isNull(reported);
      });
    });
  });


  describe('slow consumers', function () {
    function slowSubscriber(policy) {
      var client;
      var events = [];
      return ctx.start({slowConsumerPolicy: policy, limits: {maxBufferedAmount: 1000}}).then(function (broker) {
        broker.on('slowConsumer', function (e) {
          events.push(e);
        });
        return connectedClient();
      }).then(function (c) {
        client = c;
        return client.subscribe('/a', 's1');
      }).then(function () {
        Object.defineProperty(ctx.broker.subscribes[0].socket, 'bufferedAmount', {value: 1001});
        ctx.broker.send('/a', {}, 'x');
        return {client: client, events: events};
      });
    }

    it('drops messages for a subscriber with too much data queued', function () {
      var result;
      return slowSubscriber('drop').then(function (r) {
        result = r;
        return r.client.flush();
      }).then(function () {
        assert.lengthOf(result.client.messages(), 0);
        assert.lengthOf(result.events, 1);
        assert.equal(result.events[0].subscription, 's1');
        assert.equal(result.events[0].destination, '/a');
        assert.isString(result.events[0].messageId);
      });
    });

    it('closes the connection of a slow subscriber with the close policy', function () {
      return slowSubscriber('close').then(function (r) {
        return expectError(r.client, 'Too much data queued for this connection');
      });
    });
  });


  describe('logging', function () {
    it('does not pass the passcode to debug', function () {
      var logged = [];
      return ctx.start({
        debug: function () {
          logged.push(Array.prototype.slice.call(arguments));
        }
      }).then(function () {
        return connectedClient({login: 'user', passcode: 'secret'});
      }).then(function () {
        var text = JSON.stringify(logged);
        assert.include(text, 'user');
        assert.notInclude(text, 'secret');
      });
    });
  });
});
