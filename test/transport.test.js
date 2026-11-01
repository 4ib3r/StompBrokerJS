/**
 * Transports: the in-memory transport, custom transports, server.close(),
 * handleUpgrade for noServer, the optional sockjs package.
 */
var assert = require('chai').assert;
var childProcess = require('child_process');
var http = require('http');
var path = require('path');

var StompServer = require('../stompServer');
var buildConfig = require('../lib/config');
var tracker = require('../lib/transport/tracker');
var SockjsTransport = require('../lib/transport/sockjs');
var support = require('./support/raw-client');



describe('Transports', function () {
  var ctx = support.useBroker();

  function connectedClient(headers, clientPath) {
    var client = ctx.client(clientPath);
    return client.connect(headers).then(function () {
      return client;
    });
  }

  function expectShutdown(client) {
    return client.waitForCommand('ERROR').then(function (error) {
      assert.equal(error.headers.message, 'server shutting down');
      return client.waitForClose();
    });
  }

  /** Custom transport with connections that have no readyState */
  function customTransport() {
    var transport = {
      connections: [],
      closed: false,
      onConnection: function (cb) {
        transport.accept = cb;
      },
      close: function () {
        transport.closed = true;
        return Promise.resolve();
      },
      open: function () {
        var conn = {
          sent: [],
          closeCalls: 0,
          bufferedAmount: 0,
          send: function (data) {
            conn.sent.push(String(data));
          },
          close: function () {
            conn.closeCalls++;
          },
          onMessage: function (cb) {
            conn.message = cb;
          },
          onClose: function (cb) {
            conn.closed = cb;
          },
          onError: function (cb) {
            conn.error = cb;
          }
        };
        transport.connections.push(conn);
        transport.accept(conn, {url: '/custom'});
        return conn;
      }
    };
    return transport;
  }


  describe('in-memory transport', function () {
    it('connects and routes messages without a port', function () {
      var sender;
      var receiver;
      return ctx.startMemory().then(function () {
        assert.isNull(ctx.port);
        return Promise.all([connectedClient(), connectedClient()]);
      }).then(function (clients) {
        sender = clients[0];
        receiver = clients[1];
        return receiver.subscribe('/t', 's1');
      }).then(function () {
        sender.send('SEND', {destination: '/t'}, 'in memory');
        return receiver.waitForCommand('MESSAGE');
      }).then(function (msg) {
        assert.equal(msg.body, 'in memory');
        assert.equal(msg.headers.subscription, 's1');
      });
    });

    it('relays binary bodies as binary messages', function () {
      var receiver;
      var body = Buffer.from([0, 1, 2, 255]);
      return ctx.startMemory().then(function () {
        return connectedClient();
      }).then(function (client) {
        receiver = client;
        return receiver.subscribe('/bin', 's1');
      }).then(function () {
        ctx.broker.send('/bin', {}, body);
        return receiver.waitForCommand('MESSAGE');
      }).then(function (msg) {
        assert.isTrue(Buffer.isBuffer(msg.raw));
        assert.deepEqual(support.bodyBytes(msg), body);
      });
    });

    it('closes the connection after an ERROR and emits disconnected', function () {
      var disconnected = false;
      return ctx.startMemory().then(function (broker) {
        broker.on('disconnected', function () {
          disconnected = true;
        });
        return connectedClient();
      }).then(function (client) {
        client.send('FOO', {});
        return client.waitForCommand('ERROR').then(function () {
          return client.waitForClose();
        });
      }).then(function () {
        assert.isTrue(disconnected);
        assert.equal(ctx.broker._sessions.size, 0);
      });
    });

    it('passes the connection request to the session', function () {
      return ctx.startMemory().then(function (broker) {
        var request = {url: '/stomp', headers: {}};
        ctx.transport.connect(request);
        var session = Array.from(broker._sessions.values())[0];
        assert.strictEqual(session.request, request);
      });
    });

    it('emits connection errors as error events', function () {
      var errors = [];
      return ctx.startMemory().then(function (broker) {
        broker.on('error', function (err) {
          errors.push(err);
        });
        var client = ctx.client();
        client.memory.peer.emitError(new Error('boom'));
        assert.deepEqual(errors.map(function (e) {
          return e.message;
        }), ['boom']);
      });
    });

    it('drops data sent on a closed end and refuses connections once closed', function () {
      var transport = new StompServer.MemoryTransport();
      var accepted = 0;
      transport.onConnection(function () {
        accepted++;
      });
      var end = transport.connect();
      end.close(4000, 'bye');
      end.send('ignored');
      end.close();
      return transport.close().then(function () {
        assert.equal(end.readyState, StompServer.MemoryTransport.CLOSED);
        assert.equal(end.closeCode, 4000);
        var late = transport.connect();
        assert.equal(accepted, 1);
        return new Promise(function (resolve) {
          late.onClose(resolve);
        });
      });
    });
  });


  describe('custom transport', function () {
    it('is accepted as the transport option, no http server needed', function () {
      var transport = customTransport();
      var broker = new StompServer({transport: transport});
      assert.equal(broker.conf.protocol, 'custom');
      assert.strictEqual(broker.socket, transport);
      var conn = transport.open();
      conn.message(Buffer.from('CONNECT\naccept-version:1.1\n\n\0'), false);
      assert.match(conn.sent[0], /^CONNECTED\n/);
      var session = Array.from(broker._sessions.values())[0];
      assert.deepEqual(session.request, {url: '/custom'});
      return broker.close().then(function () {
        assert.isTrue(transport.closed);
        assert.match(conn.sent[1], /^ERROR\nmessage:server shutting down\n/);
        assert.equal(conn.closeCalls, 1);
      });
    });

    it('counts a connection without readyState as closed once the server closed it', function () {
      var transport = customTransport();
      var broker = new StompServer({transport: transport});
      var conn = transport.open();
      conn.message('FOO\n\n\0', false);
      assert.match(conn.sent[0], /^ERROR\n/);
      assert.equal(conn.closeCalls, 1);
      var session = Array.from(broker._sessions.values())[0];
      assert.isFalse(session.isOpen());
      assert.isFalse(session.isActive());
      session.send('dropped');
      session.close();
      assert.lengthOf(conn.sent, 1);
      assert.equal(conn.closeCalls, 1);
      conn.closed();
      assert.equal(broker._sessions.size, 0);
    });

    it('is validated', function () {
      assert.throws(function () {
        new StompServer({transport: {onConnection: function () {}}});
      }, Error, /missing: close/);
      assert.throws(function () {
        new StompServer({transport: customTransport(), protocol: 'ws'});
      }, Error, /either protocol or a custom transport/);
      assert.throws(function () {
        buildConfig({server: {}, transport: 'ws', protocol: 'sockjs'});
      }, Error, /Conflicting/);
      assert.throws(function () {
        buildConfig({server: {}, transport: 'tcp'});
      }, Error, /Unknown protocol "tcp"/);
    });

    it('accepts a built-in transport name as the transport option', function () {
      assert.equal(buildConfig({server: {}, transport: 'sockjs'}).protocol, 'sockjs');
      assert.equal(buildConfig({server: {}, transport: 'ws', protocol: 'ws'}).protocol, 'ws');
      assert.isUndefined(buildConfig({server: {}}).transport);
    });
  });


  describe('server.close()', function () {
    it('sends ERROR to open sessions, closes them and emits disconnected', function () {
      var disconnected = [];
      var connected;
      var opened;
      return ctx.startMemory().then(function (broker) {
        broker.on('disconnected', function (id) {
          disconnected.push(id);
        });
        opened = ctx.client();
        return connectedClient();
      }).then(function (client) {
        connected = client;
        return Promise.all([ctx.broker.close(), expectShutdown(connected), expectShutdown(opened)]);
      }).then(function () {
        assert.lengthOf(disconnected, 2);
        assert.equal(ctx.broker._sessions.size, 0);
        assert.equal(connected.closeCode, 1001);
      });
    });

    it('stops heart-beat and CONNECT timers', function () {
      var sessions;
      return ctx.startMemory({heartbeat: [100, 100], limits: {connectTimeout: 60000}}).then(function () {
        ctx.client();
        return connectedClient({'heart-beat': '100,100'});
      }).then(function () {
        sessions = Array.from(ctx.broker._sessions.values());
        assert.lengthOf(sessions, 2);
        var waiting = sessions.filter(function (s) {
          return s.state === 'OPEN';
        })[0];
        var connected = sessions.filter(function (s) {
          return s.state === 'CONNECTED';
        })[0];
        assert.lengthOf(connected.heartbeatTimers, 2);
        assert.isFalse(waiting.connectTimer._destroyed);
        var closing = ctx.broker.close();
        // right away, not only once the connections closed
        assert.lengthOf(connected.heartbeatTimers, 0);
        assert.isTrue(waiting.connectTimer._destroyed);
        return closing;
      });
    });

    it('returns the same Promise when called again', function () {
      return ctx.startMemory().then(function (broker) {
        var first = broker.close();
        assert.strictEqual(broker.close(), first);
        return first;
      }).then(function (result) {
        assert.isUndefined(result);
      });
    });

    it('closes connections that arrive after close()', function () {
      var transport = customTransport();
      var broker = new StompServer({transport: transport});
      broker.close();
      var conn = transport.open();
      assert.equal(conn.closeCalls, 1);
      assert.equal(broker._sessions.size, 0);
    });

    it('does not answer a CONNECT accepted by middleware after close()', function () {
      var release;
      var client;
      return ctx.startMemory({heartbeat: [100, 100]}).then(function (broker) {
        return new Promise(function (pending) {
          broker.addMiddleware('connect', function (socket, args, next) {
            return new Promise(function (resolve) {
              release = function () {
                resolve(next());
              };
              pending();
            });
          });
          client = ctx.client();
          client.send('CONNECT', {'accept-version': '1.1', 'heart-beat': '100,100'});
        });
      }).then(function () {
        var session = Array.from(ctx.broker._sessions.values())[0];
        var closing = ctx.broker.close();
        release();
        return closing.then(function () {
          assert.lengthOf(session.heartbeatTimers, 0);
          assert.notInclude(client.frames.map(function (f) {
            return f.command;
          }), 'CONNECTED');
        });
      });
    });

    it('closes the ws transport but not the http server passed in', function () {
      var client;
      return ctx.start().then(function () {
        return connectedClient();
      }).then(function (c) {
        client = c;
        return Promise.all([ctx.broker.close(), expectShutdown(client)]);
      }).then(function () {
        assert.isTrue(ctx.server.listening);
        assert.equal(ctx.broker._sessions.size, 0);
        // no longer upgraded to WebSocket
        assert.equal(ctx.server.listenerCount('upgrade'), 0);
      });
    });

    it('drops ws connections that do not finish the close handshake', function () {
      var grace = tracker.CLOSE_GRACE;
      tracker.CLOSE_GRACE = 20;
      return ctx.start().then(function () {
        return connectedClient();
      }).then(function (client) {
        // the client stops reading: the close frame is never answered
        client.ws._socket.pause();
        return ctx.broker.close();
      }).then(function () {
        assert.equal(ctx.broker._sessions.size, 0);
      }).finally(function () {
        tracker.CLOSE_GRACE = grace;
      });
    });

    it('closes sockjs connections and refuses new ones', function () {
      var rawPath = '/stomp/websocket';
      return ctx.start({protocol: 'sockjs', protocolConfig: {log: function () {}}}).then(function () {
        return connectedClient({}, rawPath);
      }).then(function (client) {
        return Promise.all([ctx.broker.close(), expectShutdown(client)]);
      }).then(function () {
        assert.equal(ctx.broker._sessions.size, 0);
        var late = ctx.client(rawPath);
        return late.open().then(function () {
          return late.waitForClose();
        });
      }).then(function () {
        assert.equal(ctx.broker._sessions.size, 0);
      });
    });
  });


  describe('handleUpgrade (noServer)', function () {
    it('accepts connections upgraded on a shared http server and closes them on close()', function () {
      var broker = new StompServer({protocolConfig: {noServer: true}});
      var client;
      ctx.broker = broker;
      ctx.server = http.createServer();
      ctx.server.on('upgrade', function (request, socket, head) {
        broker.handleUpgrade(request, socket, head);
      });
      return new Promise(function (resolve) {
        ctx.server.listen(0, function () {
          ctx.port = ctx.server.address().port;
          resolve();
        });
      }).then(function () {
        return connectedClient();
      }).then(function (c) {
        client = c;
        var session = Array.from(broker._sessions.values())[0];
        assert.equal(session.request.url, '/stomp');
        return Promise.all([broker.close(), expectShutdown(client)]);
      }).then(function () {
        assert.isTrue(ctx.server.listening);
      });
    });

    it('throws for transports without upgrades', function () {
      return ctx.startMemory().then(function (broker) {
        assert.throws(function () {
          broker.handleUpgrade({}, {}, Buffer.alloc(0));
        }, Error, /ws transport only/);
      });
    });
  });


  describe('connection tracker', function () {
    it('resolves right away without connections and when the last one closes', function () {
      var t = tracker(1000);
      var a = {};
      return t.closed().then(function () {
        t.add(a);
        var closed = t.closed(function () {
          throw new Error('not expected');
        });
        t.remove(a);
        return closed;
      });
    });

    it('gives up on connections still open after the grace time', function () {
      var t = tracker(5);
      var a = {};
      var timedOut = [];
      t.add(a);
      return t.closed(function (conn) {
        timedOut.push(conn);
      }).then(function () {
        assert.deepEqual(timedOut, [a]);
      });
    });
  });


  describe('sockjs (optional peer dependency)', function () {
    it('is not loaded by requiring the package', function () {
      var script = 'require(' + JSON.stringify(path.join(__dirname, '..', 'stompServer.js')) + ');' +
        'process.stdout.write(String(Object.keys(require.cache).some(function (k) {' +
        'return k.indexOf("node_modules" + require("path").sep + "sockjs") >= 0; })));';
      var out = childProcess.execFileSync(process.execPath, ['-e', script]).toString();
      assert.equal(out, 'false');
    });

    it('explains how to install it when it is missing', function () {
      function missing() {
        var err = new Error("Cannot find module 'sockjs'");
        err.code = 'MODULE_NOT_FOUND';
        throw err;
      }
      assert.throws(function () {
        new SockjsTransport({server: http.createServer(), path: '/stomp'}, missing);
      }, Error, /npm install sockjs/);
    });

    it('passes on other errors loading it', function () {
      assert.throws(function () {
        SockjsTransport.loadSockjs(function () {
          throw new SyntaxError('broken');
        });
      }, SyntaxError, /broken/);
    });

    it('keeps sockjs_url and prefix from protocolConfig', function () {
      return ctx.start({
        protocol: 'sockjs',
        protocolConfig: {log: function () {}, sockjs_url: '/js/sockjs.min.js', prefix: '/custom'}
      }).then(function (broker) {
        assert.equal(broker.socket.options.sockjs_url, '/js/sockjs.min.js');
        assert.equal(broker.socket.options.prefix, '/custom');
        return connectedClient({}, '/custom/websocket');
      });
    });

    it('uses the path as prefix and the sockjs default sockjs_url', function () {
      return ctx.start({protocol: 'sockjs', path: '/s', protocolConfig: {log: function () {}}}).then(function (broker) {
        assert.equal(broker.socket.options.prefix, '/s');
        assert.match(broker.socket.options.sockjs_url, /sockjs/);
        assert.isUndefined(broker.socket.options.server);
      });
    });
  });
});
