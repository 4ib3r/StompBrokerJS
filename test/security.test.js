/**
 * Security hooks: authenticate, authorize, allowWildcardSubscriptions.
 * Runs on the in-memory transport (no ports).
 */
var assert = require('chai').assert;
var util = require('util');

var StompServer = require('../stompServer');
var buildConfig = require('../lib/config');
var support = require('./support/raw-client');


describe('Security hooks', function () {
  var ctx = support.useBroker();

  function connectedClient(headers) {
    var client = ctx.client();
    return client.connect(headers).then(function () {
      return client;
    });
  }

  function expectError(client, text) {
    return client.waitForCommand('ERROR').then(function (error) {
      assert.equal(error.body, text);
      return client.waitForClose().then(function () {
        return error;
      });
    });
  }

  /** Promise and its resolve function, to finish an async hook when the test says so */
  function deferred() {
    var d = {};
    d.promise = new Promise(function (resolve, reject) {
      d.resolve = resolve;
      d.reject = reject;
    });
    return d;
  }

  /** Resolves after the pending in-memory deliveries (microtasks) */
  function nextTick() {
    return new Promise(function (resolve) {
      setImmediate(resolve);
    });
  }

  it('rejects frames sent after a CONNECT that is then rejected', function () {
    var auth = deferred();
    var subscribed = false;
    var client;
    return ctx.startMemory({
      authenticate: function () {
        return auth.promise;
      }
    }).then(function (broker) {
      broker.on('subscribe', function () {
        subscribed = true;
      });
      client = ctx.client();
      client.send('CONNECT', {'accept-version': '1.1'});
      client.send('SUBSCRIBE', {destination: '/a', id: 's1'});
      return nextTick();
    }).then(function () {
      auth.resolve(null);
      return expectError(client, 'Authentication failed');
    }).then(function () {
      assert.deepEqual(commands(client), ['ERROR']);
      assert.isFalse(subscribed);
    });
  });

  it('drops frames queued behind a pending CONNECT when the client closes', function () {
    var auth = deferred();
    var subscribed = false;
    var client;
    return ctx.startMemory({
      authenticate: function () {
        return auth.promise;
      }
    }).then(function (broker) {
      broker.on('subscribe', function () {
        subscribed = true;
      });
      client = ctx.client();
      client.send('CONNECT', {'accept-version': '1.1'});
      client.send('SUBSCRIBE', {destination: '/a', id: 's1'});
      return nextTick();
    }).then(function () {
      client.close();
      return client.waitForClose();
    }).then(function () {
      auth.resolve('late');
      return auth.promise;
    }).then(function () {
      return nextTick();
    }).then(function () {
      assert.isFalse(subscribed);
      assert.lengthOf(ctx.broker.subscribes, 0);
    });
  });

  function commands(client) {
    return client.frames.map(function (f) {
      return f.command;
    });
  }


  describe('authenticate', function () {
    it('gets the credentials and stores the principal on the session', function () {
      var calls = [];
      var event;
      var request = {url: '/stomp', headers: {cookie: 'sid=1'}};
      return ctx.startMemory({
        authenticate: function (credentials) {
          calls.push(credentials);
          return {name: credentials.login};
        }
      }).then(function (broker) {
        broker.on('connected', function (sessionId, headers, principal) {
          event = {sessionId: sessionId, principal: principal};
        });
        var end = ctx.transport.connect(request);
        end.send(support.buildFrame('CONNECT', {'accept-version': '1.1', login: 'ann', passcode: 'pw', x: 'y'}));
        return new Promise(function (resolve) {
          end.onMessage(function (data) {
            resolve(support.parseFrame(data.toString()));
          });
        });
      }).then(function (connected) {
        assert.equal(connected.command, 'CONNECTED');
        assert.lengthOf(calls, 1);
        assert.equal(calls[0].login, 'ann');
        assert.equal(calls[0].passcode, 'pw');
        assert.equal(calls[0].headers.x, 'y');
        assert.equal(calls[0].sessionId, connected.headers.session);
        assert.strictEqual(calls[0].request, request);
        assert.deepEqual(event, {sessionId: connected.headers.session, principal: {name: 'ann'}});
        var session = ctx.broker._sessions.get(connected.headers.session);
        assert.deepEqual(session.principal, {name: 'ann'});
      });
    });

    it('waits for an asynchronous authenticate, frames sent meanwhile follow in order', function () {
      var auth = deferred();
      var client;
      var seen = [];
      return ctx.startMemory({
        authenticate: function () {
          return auth.promise;
        }
      }).then(function (broker) {
        broker.addMiddleware('subscribe', function (socket, args, next) {
          seen.push(socket.principal);
          return next();
        });
        client = ctx.client();
        client.send('CONNECT', {'accept-version': '1.1', login: 'bob'});
        var subscribed = client.sendWithReceipt('SUBSCRIBE', {destination: '/a', id: 's1'});
        var sent = client.sendWithReceipt('SEND', {destination: '/a'}, 'x');
        // in-memory data arrives in microtasks: the broker has all three frames
        return nextTick().then(function () {
          return {subscribed: subscribed, sent: sent};
        });
      }).then(function (pending) {
        assert.deepEqual(commands(client), [], 'nothing answered before authenticate resolved');
        auth.resolve('bob');
        return Promise.all([pending.subscribed, pending.sent]);
      }).then(function () {
        assert.deepEqual(commands(client), ['CONNECTED', 'RECEIPT', 'RECEIPT']);
        assert.deepEqual(seen, ['bob']);
      });
    });

    it('makes the principal visible to middleware, read-only', function () {
      var principals = [];
      return ctx.startMemory({
        authenticate: function () {
          return Promise.resolve({id: 7});
        }
      }).then(function (broker) {
        broker.addMiddleware('connect', function (socket, args, next) {
          principals.push(socket.principal);
          assert.throws(function () {
            'use strict';
            socket.principal = {id: 0};
          }, TypeError);
          return next();
        });
        return connectedClient();
      }).then(function () {
        assert.deepEqual(principals, [{id: 7}]);
      });
    });

    [
      ['null', function () { return null; }],
      ['false', function () { return false; }],
      ['undefined', function () {}],
      ['a rejected Promise of null', function () { return Promise.resolve(null); }]
    ].forEach(function (testCase) {
      it('rejects the CONNECT when it returns ' + testCase[0], function () {
        var connected = false;
        var middleware = false;
        return ctx.startMemory({authenticate: testCase[1]}).then(function (broker) {
          broker.on('connected', function () {
            connected = true;
          });
          broker.addMiddleware('connect', function (socket, args, next) {
            middleware = true;
            return next();
          });
          var client = ctx.client();
          client.send('CONNECT', {'accept-version': '1.1', login: 'eve', passcode: 'nope'});
          return expectError(client, 'Authentication failed');
        }).then(function (error) {
          assert.equal(error.headers.message, 'CONNECTION ERROR');
          assert.isFalse(connected);
          assert.isFalse(middleware);
        });
      });
    });

    it('sends the message of a StompError thrown by authenticate', function () {
      return ctx.startMemory({
        authenticate: function () {
          return Promise.reject(new StompServer.StompError('Token expired'));
        }
      }).then(function () {
        var client = ctx.client();
        client.send('CONNECT', {'accept-version': '1.1'});
        return expectError(client, 'Token expired');
      });
    });

    it('hides other errors of authenticate and emits them', function () {
      var errors = [];
      return ctx.startMemory({
        authenticate: function () {
          throw new Error('db at 10.0.0.1 down');
        }
      }).then(function (broker) {
        broker.on('error', function (err) {
          errors.push(err.message);
        });
        var client = ctx.client();
        client.send('CONNECT', {'accept-version': '1.1'});
        return expectError(client, 'Internal error');
      }).then(function () {
        assert.deepEqual(errors, ['db at 10.0.0.1 down']);
      });
    });

    it('never passes the passcode to debug or the ERROR frame', function () {
      var logged = [];
      var client;
      return ctx.startMemory({
        debug: function () {
          logged.push(util.inspect(Array.prototype.slice.call(arguments), {depth: 4}));
        },
        authenticate: function (credentials) {
          return credentials.login === 'ok' ? 'ok' : null;
        }
      }).then(function () {
        return connectedClient({login: 'ok', passcode: 'secret-pw-1'});
      }).then(function () {
        client = ctx.client();
        client.send('CONNECT', {'accept-version': '1.1', login: 'bad', passcode: 'secret-pw-2'});
        return expectError(client, 'Authentication failed');
      }).then(function (error) {
        assert.notInclude(error.raw.toString(), 'secret-pw');
        assert.isAbove(logged.length, 0);
        logged.forEach(function (line) {
          assert.notInclude(line, 'secret-pw');
        });
      });
    });

    it('does not connect a client that closed while authenticate was pending', function () {
      var auth = deferred();
      var connected = false;
      var client;
      return ctx.startMemory({
        authenticate: function () {
          return auth.promise;
        }
      }).then(function (broker) {
        broker.on('connected', function () {
          connected = true;
        });
        client = ctx.client();
        client.send('CONNECT', {'accept-version': '1.1'});
        // the CONNECT reached the broker once the session waits for the hook
        return nextTick();
      }).then(function () {
        var session = Array.from(ctx.broker._sessions.values())[0];
        client.close();
        return client.waitForClose().then(function () {
          auth.resolve('late');
          return auth.promise;
        }).then(function () {
          assert.isFalse(connected);
          assert.lengthOf(session.heartbeatTimers, 0);
          assert.isUndefined(session.principal);
        });
      });
    });

    it('does not authenticate a repeated CONNECT again', function () {
      var calls = 0;
      return ctx.startMemory({
        authenticate: function (credentials) {
          calls++;
          return credentials.login;
        }
      }).then(function () {
        return connectedClient({login: 'first'});
      }).then(function (client) {
        client.send('CONNECT', {'accept-version': '1.1', login: 'second'});
        return client.flush();
      }).then(function () {
        assert.equal(calls, 1);
        var session = Array.from(ctx.broker._sessions.values())[0];
        assert.equal(session.principal, 'first');
      });
    });
  });


  describe('authorize', function () {
    function readOnlyPublic(principal, action, destination) {
      if (action === 'subscribe') {
        return destination.indexOf('/public') === 0 || principal === 'admin';
      }
      return principal === 'admin';
    }

    function start(authorize, config) {
      return ctx.startMemory(Object.assign({
        authenticate: function (credentials) {
          return credentials.login || 'guest';
        },
        authorize: authorize
      }, config));
    }

    it('gets principal, action, destination and session for SUBSCRIBE', function () {
      var calls = [];
      return start(function (principal, action, destination, session) {
        calls.push([principal, action, destination, session.sessionId]);
        return true;
      }).then(function () {
        return connectedClient({login: 'ann'});
      }).then(function (client) {
        return client.subscribe('/public.news', 's1');
      }).then(function () {
        var session = Array.from(ctx.broker._sessions.values())[0];
        assert.deepEqual(calls, [['ann', 'subscribe', '/public.news', session.sessionId]]);
        assert.lengthOf(ctx.broker.subscribes, 1);
      });
    });

    it('rejects a denied SUBSCRIBE with Access denied and stores nothing', function () {
      var middleware = false;
      return start(readOnlyPublic).then(function (broker) {
        broker.addMiddleware('subscribe', function (socket, args, next) {
          middleware = true;
          return next();
        });
        return connectedClient();
      }).then(function (client) {
        client.send('SUBSCRIBE', {destination: '/private.data', id: 's1'});
        return expectError(client, 'Access denied');
      }).then(function (error) {
        assert.equal(error.headers.message, 'SUBSCRIBE ERROR');
        assert.lengthOf(ctx.broker.subscribes, 0);
        assert.isFalse(middleware, 'middleware runs only for authorized commands');
      });
    });

    it('allows only true, also from a Promise', function () {
      return start(function () {
        return Promise.resolve('yes');
      }).then(function () {
        return connectedClient();
      }).then(function (client) {
        client.send('SUBSCRIBE', {destination: '/a', id: 's1'});
        return expectError(client, 'Access denied');
      });
    });

    it('rejects a denied SEND and delivers nothing', function () {
      var receiver;
      return start(readOnlyPublic).then(function () {
        return Promise.all([connectedClient({login: 'admin'}), connectedClient()]);
      }).then(function (clients) {
        receiver = clients[0];
        return receiver.subscribe('/public.news', 's1');
      }).then(function () {
        var sender = ctx.clients[1];
        sender.send('SEND', {destination: '/public.news'}, 'forged');
        return expectError(sender, 'Access denied');
      }).then(function (error) {
        assert.equal(error.headers.message, 'Send error');
        return receiver.flush();
      }).then(function () {
        assert.lengthOf(receiver.messages(), 0);
      });
    });

    it('checks a transactional SEND when it arrives', function () {
      var actions = [];
      var receiver;
      var sender;
      return start(function (principal, action, destination) {
        actions.push(action + ' ' + destination);
        return destination !== '/denied';
      }).then(function () {
        return Promise.all([connectedClient(), connectedClient()]);
      }).then(function (clients) {
        receiver = clients[0];
        sender = clients[1];
        return receiver.subscribe('/ok', 's1');
      }).then(function () {
        return sender.sendWithReceipt('BEGIN', {transaction: 'tx'});
      }).then(function () {
        return sender.sendWithReceipt('SEND', {destination: '/ok', transaction: 'tx'}, 'one');
      }).then(function (reply) {
        assert.equal(reply.command, 'RECEIPT');
        sender.send('SEND', {destination: '/denied', transaction: 'tx'}, 'two');
        return expectError(sender, 'Access denied');
      }).then(function () {
        assert.deepEqual(actions, ['subscribe /ok', 'send /ok', 'send /denied']);
        return receiver.flush();
      }).then(function () {
        // the transaction was dropped with the connection
        assert.lengthOf(receiver.messages(), 0);
      });
    });

    it('delivers authorized messages in the order sent, also when authorize is asynchronous', function () {
      var receiver;
      var sender;
      var slow = deferred();
      return start(function (principal, action, destination) {
        if (action === 'send' && destination === '/q.slow') {
          return slow.promise;
        }
        return true;
      }).then(function () {
        return Promise.all([connectedClient(), connectedClient()]);
      }).then(function (clients) {
        receiver = clients[0];
        sender = clients[1];
        return receiver.subscribe('/q.*', 's1');
      }).then(function () {
        sender.send('SEND', {destination: '/q.slow'}, '1');
        sender.send('SEND', {destination: '/q.fast'}, '2');
        var done = sender.flush();
        slow.resolve(true);
        return done;
      }).then(function () {
        return receiver.waitFor(function () {
          return receiver.messages().length === 2;
        }, 1000, 'two messages');
      }).then(function () {
        assert.deepEqual(receiver.messages().map(function (m) {
          return m.body;
        }), ['1', '2']);
      });
    });

    it('hides errors thrown by authorize and emits them', function () {
      var errors = [];
      return start(function () {
        throw new Error('policy store unavailable');
      }).then(function (broker) {
        broker.on('error', function (err) {
          errors.push(err.message);
        });
        return connectedClient();
      }).then(function (client) {
        client.send('SEND', {destination: '/a'}, 'x');
        return expectError(client, 'Internal error');
      }).then(function () {
        assert.deepEqual(errors, ['policy store unavailable']);
      });
    });

    it('requires a destination before asking authorize', function () {
      var called = false;
      return start(function () {
        called = true;
        return true;
      }).then(function () {
        return connectedClient();
      }).then(function (client) {
        client.send('SEND', {}, 'x');
        return expectError(client, 'Destination is required');
      }).then(function () {
        assert.isFalse(called);
      });
    });

    it('does not check server-side send() and subscribe()', function () {
      var called = 0;
      var received = [];
      var client;
      return start(function () {
        called++;
        return false;
      }).then(function (broker) {
        broker.subscribe('/**', function (body) {
          received.push(body);
        });
        return connectedClient();
      }).then(function (c) {
        client = c;
        ctx.broker.send('/anything', {}, 'from server');
        assert.equal(called, 0);
        client.send('SEND', {destination: '/x'}, 'from client');
        return expectError(client, 'Access denied');
      }).then(function () {
        assert.equal(called, 1);
        assert.deepEqual(received, []);
      });
    });

    it('gets an undefined principal without authenticate', function () {
      var principals = [];
      return ctx.startMemory({
        authorize: function (principal) {
          principals.push(principal);
          return true;
        }
      }).then(function () {
        return connectedClient();
      }).then(function (client) {
        return client.subscribe('/a', 's1');
      }).then(function () {
        assert.deepEqual(principals, [undefined]);
      });
    });
  });


  describe('allowWildcardSubscriptions', function () {
    ['/**', '/a.*', '/a.**.b', '/*'].forEach(function (destination) {
      it('false rejects a client subscription to ' + destination, function () {
        return ctx.startMemory({allowWildcardSubscriptions: false}).then(function () {
          return connectedClient();
        }).then(function (client) {
          client.send('SUBSCRIBE', {destination: destination, id: 's1'});
          return expectError(client, 'Wildcard subscriptions are not allowed');
        }).then(function () {
          assert.lengthOf(ctx.broker.subscribes, 0);
        });
      });
    });

    it('false still allows exact destinations, names containing * and server-side wildcards', function () {
      return ctx.startMemory({allowWildcardSubscriptions: false}).then(function (broker) {
        broker.subscribe('/**', function () {});
        return connectedClient();
      }).then(function (client) {
        return client.subscribe('/a.b', 's1').then(function () {
          return client.subscribe('/a.b*', 's2');
        });
      }).then(function () {
        assert.lengthOf(ctx.broker.subscribes, 3);
      });
    });

    it('is checked before authorize', function () {
      var called = false;
      return ctx.startMemory({
        allowWildcardSubscriptions: false,
        authorize: function () {
          called = true;
          return true;
        }
      }).then(function () {
        return connectedClient();
      }).then(function (client) {
        client.send('SUBSCRIBE', {destination: '/**', id: 's1'});
        return expectError(client, 'Wildcard subscriptions are not allowed');
      }).then(function () {
        assert.isFalse(called);
      });
    });

    it('defaults to true', function () {
      return ctx.startMemory().then(function () {
        return connectedClient();
      }).then(function (client) {
        return client.subscribe('/**', 's1');
      });
    });
  });


  describe('configuration', function () {
    it('validates the hooks', function () {
      assert.throws(function () {
        buildConfig({server: {}, authenticate: 'yes'});
      }, Error, /authenticate must be a function/);
      assert.throws(function () {
        buildConfig({server: {}, authorize: {}});
      }, Error, /authorize must be a function/);
      assert.throws(function () {
        buildConfig({server: {}, allowWildcardSubscriptions: 'no'});
      }, Error, /allowWildcardSubscriptions must be a boolean/);
      var conf = buildConfig({server: {}});
      assert.isUndefined(conf.authenticate);
      assert.isUndefined(conf.authorize);
      assert.isTrue(conf.allowWildcardSubscriptions);
    });
  });
});
