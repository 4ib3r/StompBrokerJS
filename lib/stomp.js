var stompUtils = require('./stomp-utils');

var SUPPORTED_VERSIONS = ['1.0', '1.1'];

var ServerFrame = {
  CONNECTED: function (socket, heartbeat, serverName, version) {
    stompUtils.sendCommand(socket, 'CONNECTED', {
      session: socket.sessionId,
      server: serverName,
      'heart-beat': heartbeat,
      version: version || '1.1'
    });
  },

  MESSAGE: function (socket, frame) {
    stompUtils.sendCommand(socket, 'MESSAGE', frame.headers, frame.body);
  },

  RECEIPT: function (socket, receipt) {
    stompUtils.sendCommand(socket, 'RECEIPT', {
      'receipt-id': receipt
    });
  },

  ERROR: function (socket, message, description, receipt) {
    var body = description !== undefined ? String(description) : '';
    var headers = {
      message: message,
      'content-type': 'text/plain',
      'content-length': Buffer.byteLength(body)
    };
    if (receipt !== undefined) {
      headers['receipt-id'] = receipt;
    }
    stompUtils.sendCommand(socket, 'ERROR', headers, body);
  }
};

/** Error message text for ERROR frames */
function errorText(err) {
  return err && err.message ? err.message : String(err);
}

/**
 * Run handler and call `onResult` with its result, waiting for it if it is a
 * Promise. Synchronous throws and rejections both go to `onError`.
 */
function whenDone(handler, onResult, onError) {
  var result;
  try {
    result = handler();
  } catch (err) {
    return onError(err);
  }
  if (result && typeof result.then === 'function') {
    result.then(onResult, onError);
  } else {
    onResult(result);
  }
}

/** Pick the highest protocol version supported by both sides */
function negotiateVersion(acceptVersion) {
  if (!acceptVersion) {
    return '1.0';
  }
  var accepted = acceptVersion.split(',').map(function (v) {
    return v.trim();
  });
  for (var i = SUPPORTED_VERSIONS.length - 1; i >= 0; i--) {
    if (accepted.indexOf(SUPPORTED_VERSIONS[i]) >= 0) {
      return SUPPORTED_VERSIONS[i];
    }
  }
  return null;
}

/**
 * Negotiate heart-beats.
 *
 * @param {number[]} clientHeartbeat [cx, cy] from client CONNECT frame
 * @param {number[]} serverHeartbeat [sx, sy] from server configuration
 * @return {number[]} [outgoing, incoming] intervals, 0 means disabled
 */
function negotiateHeartbeat(clientHeartbeat, serverHeartbeat) {
  var cx = clientHeartbeat[0] || 0;
  var cy = clientHeartbeat[1] || 0;
  var sx = serverHeartbeat[0] || 0;
  var sy = serverHeartbeat[1] || 0;
  return [
    sx > 0 && cy > 0 ? Math.max(sx, cy) : 0,
    cx > 0 && sy > 0 ? Math.max(cx, sy) : 0
  ];
}

/** Send ERROR frame and close the connection */
function fail(socket, message, description, receipt) {
  try {
    ServerFrame.ERROR(socket, message, description, receipt);
  } finally {
    socket.close();
  }
}

function FrameHandler(stompServer) {

  function onHandlerError(socket, message, receipt) {
    return function (err) {
      stompServer.conf.debug(message, socket.sessionId, err);
      fail(socket, message, errorText(err), receipt);
    };
  }

  /**
   * Run command handler; answer RECEIPT on success (when requested) or ERROR
   * when the handler (middle-ware) rejects the command.
   */
  function reply(socket, frame, handler, errorMessage, errorDescription) {
    var receipt = frame.headers.receipt;
    whenDone(handler, function (res) {
      if (!res) {
        ServerFrame.ERROR(socket, errorMessage, errorDescription, receipt);
      } else if (receipt !== undefined) {
        ServerFrame.RECEIPT(socket, receipt);
      }
    }, onHandlerError(socket, errorMessage, receipt));
  }

  this.CONNECT = function (socket, frame) {
    var version = negotiateVersion(frame.headers['accept-version']);
    if (version === null) {
      return fail(socket, 'Supported protocol versions are ' + SUPPORTED_VERSIONS.join(','),
        'Unsupported protocol version ' + frame.headers['accept-version']);
    }

    // setup heart-beat feature
    var rawHeartbeat = frame.headers['heart-beat'];
    var clientHeartbeat = rawHeartbeat ? rawHeartbeat.split(',').map(Number) : [0, 0];
    var heartbeat = negotiateHeartbeat(clientHeartbeat, stompServer.conf.heartbeat);

    whenDone(function () {
      return stompServer.onClientConnected(socket, {
        heartbeat: clientHeartbeat,
        headers: frame.headers
      });
    }, function (accepted) {
      if (!accepted) {
        return fail(socket, 'CONNECTION ERROR', 'CONNECTION ERROR');
      }
      socket.stompConnected = true;
      socket.stompVersion = version;
      ServerFrame.CONNECTED(socket, heartbeat.join(','), stompServer.conf.serverName, version);
      if (heartbeat[0] > 0) {
        stompServer.heartbeatOn(socket, heartbeat[0], true);
      }
      if (heartbeat[1] > 0) {
        stompServer.heartbeatOn(socket, heartbeat[1], false);
      }
    }, onHandlerError(socket, 'CONNECTION ERROR'));
  };

  this.STOMP = this.CONNECT;

  this.DISCONNECT = function (socket, frame) {
    reply(socket, frame, function () {
      var res = stompServer.onDisconnect(socket, frame.headers.receipt);
      if (res) {
        socket.stompDisconnected = true;
      }
      return res;
    }, 'DISCONNECT ERROR', frame.headers.receipt);
  };

  this.SUBSCRIBE = function (socket, frame) {
    var dest = frame.headers.destination;
    reply(socket, frame, function () {
      return stompServer.onSubscribe(socket, {
        dest: dest,
        ack: frame.headers.ack || 'auto',
        id: frame.headers.id
      });
    }, 'SUBSCRIBE ERROR', dest);
  };

  this.UNSUBSCRIBE = function (socket, frame) {
    var id = frame.headers.id;
    reply(socket, frame, function () {
      return stompServer.onUnsubscribe(socket, id);
    }, 'UNSUBSCRIBE ERROR', id);
  };

  this.SEND = function (socket, frame) {
    var dest = frame.headers.destination;
    reply(socket, frame, function () {
      return stompServer.onSend(socket, {
        dest: dest,
        frame: frame
      });
    }, 'Send error', dest);
  };
}

module.exports = {
  StompUtils: stompUtils,
  ServerFrame: ServerFrame,
  FrameHandler: FrameHandler,
  genId: stompUtils.genId,
  fail: fail,
  errorText: errorText
};
