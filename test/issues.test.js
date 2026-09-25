/**
 * Regression tests for reported GitHub issues and review findings.
 *
 * These tests talk to the broker with a raw WebSocket client so that the
 * exact frames on the wire can be asserted, independently of any STOMP
 * client library quirks.
 */
var http = require('http');
var WebSocket = require('ws');
var assert = require('chai').assert;

var StompServer = require('../stompServer');

var NULL = '\0';

function buildFrame(command, headers, body) {
  var lines = [command];
  Object.keys(headers || {}).forEach(function (key) {
    lines.push(key + ':' + headers[key]);
  });
  return lines.join('\n') + '\n\n' + (body || '') + NULL;
}

function parseFrame(raw) {
  var text = raw.toString();
  if (text === '\n') {
    return {command: 'HEARTBEAT', headers: {}, body: ''};
  }
  var headerEnd = text.indexOf('\n\n');
  var head = text.substring(0, headerEnd).split('\n');
  var headers = {};
  head.slice(1).forEach(function (line) {
    var idx = line.indexOf(':');
    headers[line.substring(0, idx)] = line.substring(idx + 1);
  });
  var body = text.substring(headerEnd + 2);
  if (body.charAt(body.length - 1) === NULL) {
    body = body.substring(0, body.length - 1);
  }
  return {command: head[0], headers: headers, body: body, raw: raw};
}

/**
 * Minimal STOMP client on top of `ws` that records every received frame.
 */
function RawClient(port, path) {
  var self = this;
  this.frames = [];
  this.waiters = [];
  this.closed = false;
  this.ws = new WebSocket('ws://localhost:' + port + (path || '/stomp'));
  this.ws.on('message', function (data) {
    var frame = parseFrame(data);
    self.frames.push(frame);
    self._notify();
  });
  this.ws.on('close', function () {
    self.closed = true;
    self._notify();
  });
  this.ws.on('error', function () {});
}

RawClient.prototype._notify = function () {
  this.waiters.slice().forEach(function (waiter) {
    waiter();
  });
};

RawClient.prototype.open = function () {
  var ws = this.ws;
  return new Promise(function (resolve, reject) {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
};

RawClient.prototype.send = function (command, headers, body) {
  this.ws.send(buildFrame(command, headers, body));
};

/** Resolve with the first received frame matching `predicate`. */
RawClient.prototype.waitFor = function (predicate, timeout, description) {
  var self = this;
  return new Promise(function (resolve, reject) {
    function check() {
      for (var i = 0; i < self.frames.length; i++) {
        if (predicate(self.frames[i])) {
          cleanup();
          resolve(self.frames[i]);
          return;
        }
      }
    }
    function cleanup() {
      clearTimeout(timer);
      var idx = self.waiters.indexOf(check);
      if (idx >= 0) {
        self.waiters.splice(idx, 1);
      }
    }
    var timer = setTimeout(function () {
      cleanup();
      reject(new Error('Timed out waiting for ' + (description || 'frame') +
        '; received: ' + JSON.stringify(self.frames.map(function (f) {
          return f.command;
        }))));
    }, timeout || 1000);
    self.waiters.push(check);
    check();
  });
};

RawClient.prototype.waitForCommand = function (command, timeout) {
  return this.waitFor(function (f) {
    return f.command === command;
  }, timeout, command);
};

RawClient.prototype.waitForClose = function (timeout) {
  var self = this;
  return new Promise(function (resolve, reject) {
    if (self.closed) {
      return resolve();
    }
    var timer = setTimeout(function () {
      reject(new Error('Timed out waiting for socket close'));
    }, timeout || 1000);
    self.ws.once('close', function () {
      clearTimeout(timer);
      resolve();
    });
  });
};

/** Collect frames for `ms` milliseconds and return them. */
RawClient.prototype.collect = function (ms) {
  var self = this;
  var start = this.frames.length;
  return new Promise(function (resolve) {
    setTimeout(function () {
      resolve(self.frames.slice(start));
    }, ms);
  });
};

RawClient.prototype.connect = function (headers) {
  var self = this;
  return this.open().then(function () {
    self.send('CONNECT', Object.assign({'accept-version': '1.1'}, headers));
    return self.waitForCommand('CONNECTED');
  });
};

RawClient.prototype.close = function () {
  this.ws.terminate();
};

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}


describe('Reported issues', function () {
  var server;
  var stompServer;
  var clients;
  var port;

  function startBroker(config) {
    server = http.createServer();
    stompServer = new StompServer(Object.assign({server: server}, config));
    return new Promise(function (resolve) {
      server.listen(0, function () {
        port = server.address().port;
        resolve(stompServer);
      });
    });
  }

  function newClient(path) {
    var client = new RawClient(port, path);
    clients.push(client);
    return client;
  }

  beforeEach(function () {
    clients = [];
    server = null;
  });

  afterEach(function (done) {
    clients.forEach(function (c) {
      c.close();
    });
    if (server) {
      server.close(function () {
        done();
      });
    } else {
      done();
    }
  });


  describe('#33 heartbeat', function () {
    this.timeout(5000);

    it('negotiates both heart-beat directions when client and server support them', function () {
      return startBroker({heartbeat: [500, 500]}).then(function () {
        return newClient().connect({'heart-beat': '500,500'});
      }).then(function (connected) {
        assert.equal(connected.headers['heart-beat'], '500,500');
      });
    });

    it('server sends heart-beats when client asks for them', function () {
      var client;
      return startBroker({heartbeat: [500, 500]}).then(function () {
        client = newClient();
        return client.connect({'heart-beat': '500,500'});
      }).then(function () {
        return client.waitForCommand('HEARTBEAT', 1500);
      });
    });

    it('server sends heart-beats when only server→client direction is possible', function () {
      var client;
      return startBroker({heartbeat: [500, 0]}).then(function () {
        client = newClient();
        return client.connect({'heart-beat': '0,500'});
      }).then(function (connected) {
        assert.equal(connected.headers['heart-beat'], '500,0');
        return client.waitForCommand('HEARTBEAT', 1500);
      });
    });

    it('does not close a connection whose client beats on time', function () {
      var client;
      var beat;
      return startBroker({heartbeat: [0, 300], heartbeatErrorMargin: 200}).then(function () {
        client = newClient();
        return client.connect({'heart-beat': '300,0'});
      }).then(function () {
        beat = setInterval(function () {
          client.ws.send('\n');
        }, 300);
        return delay(1500);
      }).then(function () {
        clearInterval(beat);
        assert.isFalse(client.closed, 'healthy connection was closed');
      });
    });
  });


  describe('#32 MESSAGE headers', function () {
    it('MESSAGE sent by server contains destination header', function () {
      var client;
      return startBroker().then(function () {
        client = newClient();
        return client.connect();
      }).then(function () {
        client.send('SUBSCRIBE', {destination: '/topic.a', id: 'sub-1'});
        return delay(50);
      }).then(function () {
        stompServer.send('/topic.a', {}, 'hello');
        return client.waitForCommand('MESSAGE');
      }).then(function (msg) {
        assert.equal(msg.headers.destination, '/topic.a');
        assert.equal(msg.headers.subscription, 'sub-1');
        assert.equal(msg.body, 'hello');
      });
    });

    it('MESSAGE contains a message-id header', function () {
      var client;
      return startBroker().then(function () {
        client = newClient();
        return client.connect();
      }).then(function () {
        client.send('SUBSCRIBE', {destination: '/topic.a', id: 'sub-1'});
        return delay(50);
      }).then(function () {
        stompServer.send('/topic.a', {}, 'hello');
        return client.waitForCommand('MESSAGE');
      }).then(function (msg) {
        assert.isString(msg.headers['message-id']);
        assert.isNotEmpty(msg.headers['message-id']);
      });
    });

    it('each server-side subscriber receives its own subscription id', function () {
      var received = [];
      return startBroker().then(function () {
        stompServer.subscribe('/t', function (msg, headers) {
          received.push(headers);
        }, {id: 'first'});
        stompServer.subscribe('/t', function (msg, headers) {
          received.push(headers);
        }, {id: 'second'});
        var client = newClient();
        return client.connect().then(function () {
          client.send('SEND', {destination: '/t'}, 'x');
          return delay(100);
        });
      }).then(function () {
        assert.lengthOf(received, 2);
        assert.deepEqual(received.map(function (h) {
          return h.subscription;
        }), ['first', 'second']);
      });
    });
  });


  describe('#29 noServer', function () {
    it('can be created with protocolConfig.noServer and no http server', function () {
      var broker = new StompServer({protocolConfig: {noServer: true}});
      assert.isFunction(broker.socket.handleUpgrade);
    });
  });


  describe('#28 subscriptions iteration', function () {
    afterEach(function () {
      delete Array.prototype.indexOfKey;
    });

    it('delivers messages when Array.prototype is extended', function () {
      var client;
      // eslint-disable-next-line no-extend-native
      Array.prototype.indexOfKey = function () {};
      return startBroker().then(function () {
        client = newClient();
        return client.connect();
      }).then(function () {
        client.send('SUBSCRIBE', {destination: '/echo', id: 's1'});
        return delay(50);
      }).then(function () {
        stompServer.send('/echo', {}, 'Bonjour');
        return client.waitForCommand('MESSAGE');
      }).then(function (msg) {
        assert.equal(msg.body, 'Bonjour');
      });
    });
  });


  describe('#27 message body integrity', function () {
    function roundTrip(body, headers) {
      var sender;
      var receiver;
      return startBroker().then(function () {
        sender = newClient();
        receiver = newClient();
        return Promise.all([sender.connect(), receiver.connect()]);
      }).then(function () {
        receiver.send('SUBSCRIBE', {destination: '/data', id: 's1'});
        return delay(50);
      }).then(function () {
        sender.send('SEND', Object.assign({destination: '/data'}, headers), body);
        return receiver.waitForCommand('MESSAGE');
      });
    }

    it('keeps the whole body of a server-sent message', function () {
      var client;
      var body = JSON.stringify({topic: 'xxx', data: {a: 5}}) + '0123456789';
      return startBroker().then(function () {
        client = newClient();
        return client.connect();
      }).then(function () {
        client.send('SUBSCRIBE', {destination: 'xxx', id: 's1'});
        return delay(50);
      }).then(function () {
        stompServer.send('xxx', {}, body);
        return client.waitForCommand('MESSAGE');
      }).then(function (msg) {
        assert.equal(msg.body, body);
        assert.equal(msg.headers['content-length'], String(Buffer.byteLength(body)));
      });
    });

    it('keeps a body that contains blank lines', function () {
      return roundTrip('line1\n\nline2').then(function (msg) {
        assert.equal(msg.body, 'line1\n\nline2');
      });
    });

    it('content-length is the UTF-8 byte length of the body', function () {
      var body = 'zażółć gęślą jaźń';
      return roundTrip(body).then(function (msg) {
        assert.equal(msg.body, body);
        assert.equal(msg.headers['content-length'], String(Buffer.byteLength(body)));
      });
    });
  });


  describe('#24 subscribe event', function () {
    it('emits subscribe when a client subscribes, without any message sent', function (done) {
      startBroker().then(function () {
        stompServer.on('subscribe', function (sub) {
          try {
            assert.equal(sub.topic, '/one.two');
            assert.equal(sub.id, 'sub-1');
            assert.isDefined(sub.sessionId);
            done();
          } catch (e) {
            done(e);
          }
        });
        var client = newClient();
        return client.connect().then(function () {
          client.send('SUBSCRIBE', {destination: '/one.two', id: 'sub-1'});
        });
      }).catch(done);
    });
  });


  describe('#19 connect validation', function () {
    it('rejecting connect middleware sends ERROR and closes the socket', function () {
      var client;
      return startBroker().then(function () {
        stompServer.addMiddleware('connect', function (socket, args, next) {
          if (args.headers.passcode !== 'secret') {
            return false;
          }
          return next();
        });
        client = newClient();
        return client.open();
      }).then(function () {
        client.send('CONNECT', {'accept-version': '1.1', passcode: 'wrong'});
        return client.waitForCommand('ERROR');
      }).then(function () {
        return client.waitForClose(1000);
      });
    });

    it('accepting connect middleware sends CONNECTED', function () {
      return startBroker().then(function () {
        stompServer.addMiddleware('connect', function (socket, args, next) {
          return args.headers.passcode === 'secret' ? next() : false;
        });
        return newClient().connect({passcode: 'secret'});
      });
    });
  });
});


describe('Review findings', function () {
  var server;
  var stompServer;
  var clients;
  var port;

  function startBroker(config) {
    server = http.createServer();
    stompServer = new StompServer(Object.assign({server: server}, config));
    return new Promise(function (resolve) {
      server.listen(0, function () {
        port = server.address().port;
        resolve(stompServer);
      });
    });
  }

  function newClient() {
    var client = new RawClient(port);
    clients.push(client);
    return client;
  }

  /**
   * Fails the test when the broker throws out of a socket event handler,
   * instead of letting mocha attribute the crash to whichever test runs next.
   */
  function expectNoUncaught(fn) {
    var listeners = process.listeners('uncaughtException');
    var uncaught = null;
    process.removeAllListeners('uncaughtException');
    process.on('uncaughtException', function (err) {
      uncaught = err;
    });
    function restore() {
      process.removeAllListeners('uncaughtException');
      listeners.forEach(function (l) {
        process.on('uncaughtException', l);
      });
    }
    return fn().then(function (result) {
      restore();
      if (uncaught) {
        throw new Error('Broker threw an uncaught exception: ' + uncaught);
      }
      return result;
    }, function (err) {
      restore();
      throw uncaught ? new Error('Broker threw an uncaught exception: ' + uncaught) : err;
    });
  }

  beforeEach(function () {
    clients = [];
  });

  afterEach(function (done) {
    clients.forEach(function (c) {
      c.close();
    });
    server.close(function () {
      done();
    });
  });


  describe('robustness', function () {
    it('invalid JSON body does not crash the broker', function () {
      var client;
      return expectNoUncaught(function () {
        return startBroker().then(function () {
          client = newClient();
          return client.connect();
        }).then(function () {
          client.send('SEND', {destination: '/a', 'content-type': 'application/json'}, '{bad');
          return client.waitForCommand('ERROR');
        });
      });
    });

    it('SEND without destination does not crash the broker', function () {
      var client;
      return expectNoUncaught(function () {
        return startBroker().then(function () {
          stompServer.subscribe('/a', function () {});
          client = newClient();
          return client.connect();
        }).then(function () {
          client.send('SEND', {}, 'x');
          return client.waitForCommand('ERROR');
        });
      });
    });

    it('SUBSCRIBE without destination does not crash the broker', function () {
      var client;
      return expectNoUncaught(function () {
        return startBroker().then(function () {
          client = newClient();
          return client.connect();
        }).then(function () {
          client.send('SUBSCRIBE', {id: 's1'});
          return client.waitForCommand('ERROR');
        });
      });
    });

    it('socket error without an error listener does not crash the broker', function () {
      return expectNoUncaught(function () {
        return startBroker().then(function () {
          var client = newClient();
          return client.connect().then(function () {
            // invalid WebSocket frame (reserved opcode) makes `ws` emit 'error'
            client.ws._socket.write(Buffer.from([0x83, 0x00]));
            return delay(200);
          });
        });
      });
    });

    it('accepts frames preceded by heart-beat EOLs', function () {
      var client;
      return startBroker().then(function () {
        client = newClient();
        return client.open();
      }).then(function () {
        client.ws.send('\n' + buildFrame('CONNECT', {'accept-version': '1.1'}));
        return client.waitForCommand('CONNECTED');
      });
    });
  });


  describe('receipts', function () {
    it('SEND with receipt header gets a RECEIPT', function () {
      var client;
      return startBroker().then(function () {
        client = newClient();
        return client.connect();
      }).then(function () {
        client.send('SEND', {destination: '/a', receipt: 'r-1'}, 'x');
        return client.waitForCommand('RECEIPT');
      }).then(function (receipt) {
        assert.equal(receipt.headers['receipt-id'], 'r-1');
      });
    });

    it('DISCONNECT without receipt header does not send receipt-id:undefined', function () {
      var client;
      return startBroker().then(function () {
        client = newClient();
        return client.connect();
      }).then(function () {
        client.send('DISCONNECT', {});
        return client.collect(200);
      }).then(function (frames) {
        frames.forEach(function (f) {
          assert.notEqual(f.headers['receipt-id'], 'undefined');
        });
      });
    });

    it('emits disconnected only once per connection', function () {
      var count = 0;
      var client;
      return startBroker().then(function () {
        stompServer.on('disconnected', function () {
          count++;
        });
        client = newClient();
        return client.connect();
      }).then(function () {
        client.send('DISCONNECT', {receipt: 'bye'});
        return client.waitForCommand('RECEIPT');
      }).then(function () {
        client.ws.close();
        return delay(200);
      }).then(function () {
        assert.equal(count, 1);
      });
    });
  });


  describe('destination matching', function () {
    function delivered(subscription, destination) {
      var client;
      return startBroker().then(function () {
        client = newClient();
        return client.connect();
      }).then(function () {
        client.send('SUBSCRIBE', {destination: subscription, id: 's1'});
        return delay(50);
      }).then(function () {
        stompServer.send(destination, {}, 'x');
        return client.collect(100);
      }).then(function (frames) {
        return frames.some(function (f) {
          return f.command === 'MESSAGE';
        });
      });
    }

    it('/a.b.c does not receive messages for /a.b', function () {
      return delivered('/a.b.c', '/a.b').then(function (hit) {
        assert.isFalse(hit);
      });
    });

    it('/a.* does not receive messages for /a', function () {
      return delivered('/a.*', '/a').then(function (hit) {
        assert.isFalse(hit);
      });
    });

    it('/a.* receives messages for /a.b', function () {
      return delivered('/a.*', '/a.b').then(function (hit) {
        assert.isTrue(hit);
      });
    });

    it('/a.** receives messages for /a.b.c', function () {
      return delivered('/a.**', '/a.b.c').then(function (hit) {
        assert.isTrue(hit);
      });
    });
  });
});
