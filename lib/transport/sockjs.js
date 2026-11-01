var tracker = require('./tracker');

/**
 * Load the optional `sockjs` package (a peer dependency), with an error that
 * says how to install it when it's missing.
 *
 * @param {function} [load] module loader, `require` by default (tests)
 */
function loadSockjs(load) {
  try {
    return (load || require)('sockjs');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).indexOf('sockjs') >= 0) {
      var error = new Error('The sockjs transport needs the "sockjs" package, install it with: npm install sockjs');
      error.code = 'ERR_SOCKJS_NOT_INSTALLED';
      error.cause = err;
      throw error;
    }
    throw err;
  }
}

/**
 * Transport connection over a SockJS connection. SockJS has text messages
 * only and doesn't report queued data.
 *
 * @param {object} conn SockJS connection
 * @implements {Connection}
 */
function SockjsConnection(conn) {
  this.conn = conn;
}

Object.defineProperty(SockjsConnection.prototype, 'readyState', {
  get: function () {
    return this.conn.readyState;
  }
});

Object.defineProperty(SockjsConnection.prototype, 'bufferedAmount', {
  get: function () {
    return 0;
  }
});

SockjsConnection.prototype.send = function (data) {
  this.conn.write(data);
};

/** SockJS (the WebSocket API) allows close codes 1000 and 3000–4999 only */
function sockjsCloseCode(code) {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : undefined;
}

SockjsConnection.prototype.close = function (code, reason) {
  code = sockjsCloseCode(code);
  this.conn.close(code, code === undefined ? undefined : reason);
};

SockjsConnection.prototype.onMessage = function (cb) {
  this.conn.on('data', function (data) {
    cb(data, false);
  });
};

SockjsConnection.prototype.onClose = function (cb) {
  this.conn.on('close', function () {
    cb();
  });
};

SockjsConnection.prototype.onError = function (cb) {
  this.conn.on('error', cb);
};

/**
 * Transport on a SockJS server installed on an http server.
 *
 * @param {object} options SockJS server options; `prefix` defaults to `path`.
 *   `sockjs_url` (the sockjs-client used by iframe-based fallbacks) is passed
 *   on as given; SockJS has its own default.
 * @param {http.Server} options.server http server to install the handlers on
 * @param {string} options.path
 * @param {function} [load] module loader (tests)
 * @implements {Transport}
 */
function SockjsTransport(options, load) {
  var sockjs = loadSockjs(load);
  var opts = Object.assign({}, options);
  var httpServer = opts.server;
  if (opts.prefix === undefined) {
    opts.prefix = opts.path;
  }
  delete opts.server;
  delete opts.path;
  /** the SockJS server, `StompServer#socket` */
  this.server = sockjs.createServer(opts);
  this.server.installHandlers(httpServer, {prefix: opts.prefix});
  this._connections = tracker();
  this._closed = false;
}

SockjsTransport.prototype.onConnection = function (cb) {
  var self = this;
  this.server.on('connection', function (conn) {
    // SockJS handlers can't be removed from the http server
    if (self._closed) {
      conn.close();
      return;
    }
    var connection = new SockjsConnection(conn);
    self._connections.add(connection);
    conn.on('close', function () {
      self._connections.remove(connection);
    });
    cb(connection);
  });
};

/**
 * Stop accepting connections (new ones are closed right away, the handlers
 * stay installed on the http server); resolves when the open connections
 * are closed, or after a grace time.
 */
SockjsTransport.prototype.close = function () {
  this._closed = true;
  this._connections.forEach(function (connection) {
    connection.close();
  });
  return this._connections.closed(function () {});
};

module.exports = SockjsTransport;
module.exports.loadSockjs = loadSockjs;
