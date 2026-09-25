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

/**
 * Call `onResult` with the handler result, waiting for it if it is a Promise.
 */
function whenDone(result, onResult, onError) {
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

  function onHandlerError(socket, message) {
    return function (err) {
      fail(socket, message, err && err.message ? err.message : err);
    };
  }

  this.CONNECT = function (socket, frame) {
    var version = negotiateVersion(frame.headers['accept-version']);
    if (version === null) {
      return fail(socket, 'Supported protocol versions are ' + SUPPORTED_VERSIONS.join(','),
        'Unsupported protocol version ' + frame.headers['accept-version']);
    }

    // setup heart-beat feature
    var rawHeartbeat = frame.headers['heart-beat'];
    var clientHeartbeat = [0, 0];
    if (rawHeartbeat) {
      clientHeartbeat = rawHeartbeat.split(',').map(function (x) {
        return parseInt(x, 10) || 0;
      });
    }
    var heartbeat = negotiateHeartbeat(clientHeartbeat, stompServer.conf.heartbeat);

    whenDone(stompServer.onClientConnected(socket, {
      heartbeat: clientHeartbeat,
      headers: frame.headers
    }), function (accepted) {
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
    var receipt = frame.headers.receipt;
    whenDone(stompServer.onDisconnect(socket, receipt), function (res) {
      if (res) {
        socket.stompDisconnected = true;
        if (receipt !== undefined) {
          ServerFrame.RECEIPT(socket, receipt);
        }
      } else {
        ServerFrame.ERROR(socket, 'DISCONNECT ERROR', receipt, receipt);
      }
    }, onHandlerError(socket, 'DISCONNECT ERROR'));
  };

  this.SUBSCRIBE = function (socket, frame) {
    var dest = frame.headers.destination;
    if (!dest) {
      return fail(socket, 'SUBSCRIBE ERROR', 'Missing destination header');
    }
    var ack = frame.headers.ack || 'auto';
    whenDone(stompServer.onSubscribe(socket, {
      dest: dest,
      ack: ack,
      id: frame.headers.id
    }), function (res) {
      if (!res) {
        ServerFrame.ERROR(socket, 'SUBSCRIBE ERROR', dest);
      } else if (frame.headers.receipt !== undefined) {
        ServerFrame.RECEIPT(socket, frame.headers.receipt);
      }
    }, onHandlerError(socket, 'SUBSCRIBE ERROR'));
  };

  this.UNSUBSCRIBE = function (socket, frame) {
    var id = frame.headers.id;
    whenDone(stompServer.onUnsubscribe(socket, id), function (res) {
      if (!res) {
        ServerFrame.ERROR(socket, 'UNSUBSCRIBE ERROR', id);
      } else if (frame.headers.receipt !== undefined) {
        ServerFrame.RECEIPT(socket, frame.headers.receipt);
      }
    }, onHandlerError(socket, 'UNSUBSCRIBE ERROR'));
  };

  this.SEND = function (socket, frame) {
    var dest = frame.headers.destination;
    var receipt = frame.headers.receipt;
    if (!dest) {
      return fail(socket, 'Send error', 'Missing destination header', receipt);
    }
    whenDone(stompServer.onSend(socket, {
      dest: dest,
      frame: frame
    }), function (res) {
      if (!res) {
        ServerFrame.ERROR(socket, 'Send error', dest, receipt);
      } else if (receipt !== undefined) {
        ServerFrame.RECEIPT(socket, receipt);
      }
    }, onHandlerError(socket, 'Send error'));
  };
}

module.exports = {
  StompUtils: stompUtils,
  ServerFrame: ServerFrame,
  FrameHandler: FrameHandler,
  genId: stompUtils.genId,
  fail: fail,
  negotiateHeartbeat: negotiateHeartbeat
};
