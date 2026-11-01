var WebSocketServer = require('ws').WebSocketServer;
var tracker = require('./tracker');

/**
 * Transport connection over a `ws` WebSocket.
 *
 * @param {WebSocket} ws
 * @implements {Connection}
 */
function WsConnection(ws) {
  this.ws = ws;
}

Object.defineProperty(WsConnection.prototype, 'readyState', {
  get: function () {
    return this.ws.readyState;
  }
});

Object.defineProperty(WsConnection.prototype, 'bufferedAmount', {
  get: function () {
    return this.ws.bufferedAmount;
  }
});

WsConnection.prototype.send = function (data) {
  this.ws.send(data);
};

WsConnection.prototype.close = function (code, reason) {
  this.ws.close(code, reason);
};

/** Drop the connection without a close handshake */
WsConnection.prototype.terminate = function () {
  this.ws.terminate();
};

WsConnection.prototype.onMessage = function (cb) {
  // ws 8 delivers text messages as Buffers too, with isBinary false
  this.ws.on('message', function (data, isBinary) {
    cb(data, isBinary);
  });
};

WsConnection.prototype.onClose = function (cb) {
  this.ws.on('close', function () {
    cb();
  });
};

WsConnection.prototype.onError = function (cb) {
  this.ws.on('error', cb);
};

/**
 * Transport on a `ws` WebSocketServer.
 *
 * @param {object} options WebSocketServer options (server, path, noServer, ...)
 * @implements {Transport}
 */
function WsTransport(options) {
  /** the WebSocketServer, `StompServer#socket` */
  this.server = new WebSocketServer(options);
  this._connections = tracker();
}

WsTransport.prototype.onConnection = function (cb) {
  var connections = this._connections;
  this.server.on('connection', function (ws, request) {
    var connection = new WsConnection(ws);
    connections.add(connection);
    ws.on('close', function () {
      connections.remove(connection);
    });
    cb(connection, request);
  });
};

/** Upgrade a request of a `noServer` server and accept the connection */
WsTransport.prototype.handleUpgrade = function (request, socket, head) {
  var server = this.server;
  server.handleUpgrade(request, socket, head, function (ws) {
    server.emit('connection', ws, request);
  });
};

/**
 * Stop accepting connections; resolves when the open connections are closed.
 * Connections that don't complete the close handshake in time are dropped.
 * An http server passed in `server` is not closed.
 */
WsTransport.prototype.close = function () {
  var server = this.server;
  var closed = new Promise(function (resolve) {
    server.close(function () {
      resolve();
    });
  });
  return Promise.all([closed, this._connections.closed(function (connection) {
    connection.terminate();
  })]).then(function () {});
};

module.exports = WsTransport;
module.exports.WsConnection = WsConnection;
