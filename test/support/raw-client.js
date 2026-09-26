/**
 * Test helpers: a minimal raw STOMP-over-WebSocket client and a broker
 * lifecycle harness for mocha suites.
 */
var http = require('http');
var WebSocket = require('ws');

var StompServer = require('../../stompServer');

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

var receiptCounter = 0;

/**
 * Send a frame with a unique receipt header and resolve once the broker has
 * answered it with RECEIPT (or rejected it with ERROR).
 */
RawClient.prototype.sendWithReceipt = function (command, headers, body) {
  var receipt = 'rcpt-' + (++receiptCounter);
  this.send(command, Object.assign({}, headers, {receipt: receipt}), body);
  return this.waitFor(function (f) {
    return (f.command === 'RECEIPT' || f.command === 'ERROR') && f.headers['receipt-id'] === receipt;
  }, 1000, 'RECEIPT ' + receipt);
};

/** Send SUBSCRIBE and wait until the broker has registered it */
RawClient.prototype.subscribe = function (destination, id, headers) {
  return this.sendWithReceipt('SUBSCRIBE', Object.assign({destination: destination, id: id}, headers))
    .then(function (reply) {
      if (reply.command === 'ERROR') {
        throw new Error('SUBSCRIBE ' + destination + ' rejected: ' + reply.headers.message);
      }
      return reply;
    });
};

/** Destination used by flush(), no test subscribes to it */
var FLUSH_DESTINATION = '/__flush__';

/**
 * Round-trip a frame through the broker on this connection. The broker
 * handles frames of one connection in order and writes to a socket in order,
 * so once this resolves every frame the broker sent to this client before
 * (e.g. MESSAGEs from a synchronous server-side send()) has been received.
 * Use it instead of waiting a fixed time before asserting that nothing arrived.
 */
RawClient.prototype.flush = function () {
  return this.sendWithReceipt('SEND', {destination: FLUSH_DESTINATION}, '');
};

/** All MESSAGE frames received so far */
RawClient.prototype.messages = function () {
  return this.frames.filter(function (f) {
    return f.command === 'MESSAGE';
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


/**
 * Registers mocha hooks that create clients per test and tear down the broker
 * and all clients afterwards. Returns a context with `start(config)` and
 * `client(path)`; `ctx.broker` and `ctx.port` are set after `start`.
 */
function useBroker() {
  var ctx = {broker: null, server: null, port: null, clients: []};

  ctx.start = function (config) {
    ctx.server = http.createServer();
    ctx.broker = new StompServer(Object.assign({server: ctx.server}, config));
    return new Promise(function (resolve) {
      ctx.server.listen(0, function () {
        ctx.port = ctx.server.address().port;
        resolve(ctx.broker);
      });
    });
  };

  ctx.client = function (path) {
    var client = new RawClient(ctx.port, path);
    ctx.clients.push(client);
    return client;
  };

  beforeEach(function () {
    ctx.clients = [];
    ctx.server = null;
    ctx.broker = null;
  });

  afterEach(function (done) {
    ctx.clients.forEach(function (c) {
      c.close();
    });
    if (ctx.server) {
      ctx.server.close(function () {
        done();
      });
    } else {
      done();
    }
  });

  return ctx;
}

module.exports = {
  NULL: NULL,
  buildFrame: buildFrame,
  parseFrame: parseFrame,
  RawClient: RawClient,
  delay: delay,
  useBroker: useBroker
};
