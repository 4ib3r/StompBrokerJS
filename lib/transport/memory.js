/**
 * In-process transport without sockets, e.g. for tests of middleware and
 * hooks: `transport.connect()` opens a connection to the broker and returns
 * the client end of it.
 *
 * Data is delivered asynchronously (in a microtask), in the order it was
 * sent; a string is a text message, a Buffer a binary message.
 */

var CONNECTING = 0;
var OPEN = 1;
var CLOSING = 2;
var CLOSED = 3;

/**
 * One end of an in-memory connection.
 *
 * @implements {Connection}
 */
function MemoryEnd() {
  this.readyState = OPEN;
  /** bytes queued, settable to simulate a slow consumer */
  this.bufferedAmount = 0;
  /** close code and reason given by the side that closed the connection */
  this.closeCode = undefined;
  this.closeReason = undefined;
  this.peer = null;
  this._onMessage = [];
  this._onClose = [];
  this._onError = [];
}

MemoryEnd.prototype.send = function (data) {
  if (this.readyState !== OPEN) {
    return;
  }
  var peer = this.peer;
  var isBinary = Buffer.isBuffer(data);
  var payload = isBinary ? Buffer.from(data) : Buffer.from(String(data), 'utf8');
  queueMicrotask(function () {
    // data sent before close() is still delivered
    if (peer.readyState !== CLOSED) {
      peer._onMessage.forEach(function (cb) {
        cb(payload, isBinary);
      });
    }
  });
};

MemoryEnd.prototype.close = function (code, reason) {
  if (this.readyState !== OPEN) {
    return;
  }
  var self = this;
  var peer = this.peer;
  this.readyState = peer.readyState = CLOSING;
  this.closeCode = peer.closeCode = code;
  this.closeReason = peer.closeReason = reason;
  // after the data sent before
  queueMicrotask(function () {
    peer._closed();
    self._closed();
  });
};

MemoryEnd.prototype._closed = function () {
  if (this.readyState === CLOSED) {
    return;
  }
  this.readyState = CLOSED;
  this._onClose.forEach(function (cb) {
    cb();
  });
};

MemoryEnd.prototype.onMessage = function (cb) {
  this._onMessage.push(cb);
};

MemoryEnd.prototype.onClose = function (cb) {
  this._onClose.push(cb);
};

MemoryEnd.prototype.onError = function (cb) {
  this._onError.push(cb);
};

/** Emit an error on this end (tests of error handling) */
MemoryEnd.prototype.emitError = function (err) {
  this._onError.forEach(function (cb) {
    cb(err);
  });
};

/**
 * @implements {Transport}
 */
function MemoryTransport() {
  this._onConnection = [];
  this._open = new Set();
  this.closed = false;
}

MemoryTransport.prototype.onConnection = function (cb) {
  this._onConnection.push(cb);
};

/**
 * Open a connection to the broker.
 *
 * @param {object} [request] passed to the broker as the connection request
 * @return {MemoryEnd} the client end: send(), close(), onMessage(), onClose()
 */
MemoryTransport.prototype.connect = function (request) {
  var client = new MemoryEnd();
  var server = new MemoryEnd();
  client.peer = server;
  server.peer = client;
  if (this.closed) {
    client.readyState = server.readyState = CLOSING;
    queueMicrotask(function () {
      client._closed();
    });
    return client;
  }
  var open = this._open;
  open.add(server);
  server.onClose(function () {
    open.delete(server);
  });
  this._onConnection.forEach(function (cb) {
    cb(server, request);
  });
  return client;
};

/** Close the open connections, resolves once they are closed */
MemoryTransport.prototype.close = function () {
  this.closed = true;
  var ends = Array.from(this._open);
  return Promise.all(ends.map(function (end) {
    return new Promise(function (resolve) {
      end.onClose(resolve);
      end.close(1001, 'server shutting down');
    });
  })).then(function () {});
};

MemoryTransport.CONNECTING = CONNECTING;
MemoryTransport.OPEN = OPEN;
MemoryTransport.CLOSING = CLOSING;
MemoryTransport.CLOSED = CLOSED;

module.exports = MemoryTransport;
