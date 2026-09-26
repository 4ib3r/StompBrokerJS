var stompUtils = require('./stomp-utils');
var StompError = require('./errors').StompError;

var SUPPORTED_VERSIONS = ['1.0', '1.1'];

var ACK_MODES = ['auto', 'client', 'client-individual'];

/** Largest delay Node timers support; longer intervals fire after 1 ms */
var MAX_TIMER_DELAY = 2147483647;

var HEART_BEAT_RE = /^(\d+),(\d+)$/;

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

/** Error message text */
function errorText(err) {
  return err && err.message ? err.message : String(err);
}

/**
 * Error text that may be sent to the client: the message of a StompError
 * (raised deliberately, e.g. by middleware), a generic text for anything else
 * so that internal details (hosts, queries, stack traces) don't leak.
 */
function clientErrorText(err) {
  return err instanceof StompError ? err.message : 'Internal error';
}

/**
 * Run handler and call `onResult` with its result, waiting for it if it is a
 * Promise. Synchronous throws, rejections and errors thrown by an
 * asynchronous `onResult` go to `onError`.
 */
function whenDone(handler, onResult, onError) {
  var result;
  try {
    result = handler();
  } catch (err) {
    return onError(err);
  }
  if (result && typeof result.then === 'function') {
    result.then(onResult).catch(onError);
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
  // never shorter than the server's own interval; bounded above so that a
  // huge client value can't overflow the timer into a 1 ms interval
  return [
    sx > 0 && cy > 0 ? Math.min(Math.max(sx, cy), MAX_TIMER_DELAY) : 0,
    cx > 0 && sy > 0 ? Math.min(Math.max(cx, sy), MAX_TIMER_DELAY) : 0
  ];
}

/**
 * Parse the heart-beat header of a CONNECT frame.
 *
 * @return {number[]|null} [cx, cy], or null when the header is malformed
 */
function parseHeartbeat(value) {
  if (value === undefined) {
    return [0, 0];
  }
  var match = HEART_BEAT_RE.exec(value);
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2])];
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

  /**
   * ERROR for a failed command. Only the text of a StompError reaches the
   * client; other errors are reported through debug and the error event.
   */
  function onHandlerError(socket, message, receipt) {
    return function (err) {
      stompServer.conf.debug(message, socket.sessionId, err);
      if (!(err instanceof StompError)) {
        stompServer._emitError(err);
      }
      fail(socket, message, clientErrorText(err), receipt);
    };
  }

  /**
   * Run command handler; answer RECEIPT on success (when requested), or ERROR
   * and close the connection when the handler (middle-ware) rejects the command.
   */
  function reply(socket, frame, handler, errorMessage, rejectedText, onSuccess) {
    var receipt = frame.headers.receipt;
    whenDone(handler, function (res) {
      if (!res) {
        fail(socket, errorMessage, rejectedText, receipt);
        return;
      }
      if (receipt !== undefined) {
        ServerFrame.RECEIPT(socket, receipt);
      }
      if (onSuccess) {
        onSuccess();
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
    var clientHeartbeat = parseHeartbeat(frame.headers['heart-beat']);
    if (clientHeartbeat === null) {
      return fail(socket, 'CONNECTION ERROR', 'Invalid heart-beat header');
    }
    var heartbeat = negotiateHeartbeat(clientHeartbeat, stompServer.conf.heartbeat);

    whenDone(function () {
      return stompServer.onClientConnected(socket, {
        heartbeat: clientHeartbeat,
        headers: frame.headers
      });
    }, function (accepted) {
      // socket closed while (async) middle-ware was deciding
      if (socket.stompClosed) {
        return;
      }
      if (!accepted) {
        return fail(socket, 'CONNECTION ERROR', 'Connection rejected');
      }
      clearTimeout(socket.connectTimer);
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
    // frames after DISCONNECT are ignored, the connection is closed once the
    // RECEIPT (if requested) has been sent
    socket.stompDisconnecting = true;
    reply(socket, frame, function () {
      return stompServer.onDisconnect(socket, frame.headers.receipt);
    }, 'DISCONNECT ERROR', 'DISCONNECT rejected', function () {
      socket.close();
    });
  };

  this.SUBSCRIBE = function (socket, frame) {
    var dest = frame.headers.destination;
    var id = frame.headers.id;
    var ack = frame.headers.ack || 'auto';
    if (id === undefined) {
      if (socket.stompVersion !== '1.0') {
        return fail(socket, 'SUBSCRIBE ERROR', 'SUBSCRIBE requires an id header', frame.headers.receipt);
      }
      // STOMP 1.0: the id is optional, UNSUBSCRIBE may name the destination instead
      id = dest;
    }
    if (ACK_MODES.indexOf(ack) < 0) {
      return fail(socket, 'SUBSCRIBE ERROR', 'Unsupported ack mode ' + ack, frame.headers.receipt);
    }
    reply(socket, frame, function () {
      return stompServer.onSubscribe(socket, {
        dest: dest,
        ack: ack,
        id: id
      });
    }, 'SUBSCRIBE ERROR', 'SUBSCRIBE to ' + dest + ' rejected');
  };

  this.UNSUBSCRIBE = function (socket, frame) {
    var id = frame.headers.id;
    if (id === undefined && socket.stompVersion === '1.0') {
      id = frame.headers.destination;
    }
    reply(socket, frame, function () {
      return stompServer.onUnsubscribe(socket, id);
    }, 'UNSUBSCRIBE ERROR', 'No subscription ' + id);
  };

  this.SEND = function (socket, frame) {
    var dest = frame.headers.destination;
    reply(socket, frame, function () {
      return stompServer.onSend(socket, {
        dest: dest,
        frame: frame
      });
    }, 'Send error', 'SEND to ' + dest + ' rejected');
  };
}

module.exports = {
  StompUtils: stompUtils,
  ServerFrame: ServerFrame,
  FrameHandler: FrameHandler,
  genId: stompUtils.genId,
  fail: fail,
  errorText: errorText,
  clientErrorText: clientErrorText,
  whenDone: whenDone,
  negotiateHeartbeat: negotiateHeartbeat,
  parseHeartbeat: parseHeartbeat
};
