var crypto = require('crypto');
var Frame = require('./frame');
var FrameDecoder = require('./parser').FrameDecoder;
var StompError = require('./errors').StompError;

// random per-process prefix + counter: unique, and cheap on the message hot path
var ID_PREFIX = crypto.randomBytes(6).toString('hex');
var idCounter = 0;

/** Unique id generator */
function genId(type) {
  return (type ? type : 'id') + ID_PREFIX + (++idCounter).toString(36);
}

/** Check if socket can be written, sockets without readyState are assumed open */
function isOpen(socket) {
  return socket.readyState === undefined || socket.readyState === 1;
}

/** Send frame with socket */
function sendFrame(socket, _frame) {
  var frame = _frame;

  // skip sockets that are closing or closed, `ws` throws on send
  if (!isOpen(socket)) {
    return false;
  }

  if (!(_frame instanceof Frame)) {
    frame = new Frame({
      'command': _frame.command,
      'headers': _frame.headers,
      'body': _frame.body
    });
  }

  socket.send(frame.toStringOrBuffer(socket.stompVersion));
  return true;
}

var stompUtils = {
  genId: genId,

  isOpen: isOpen,

  tokenizeDestination: function (dest) {
    if (typeof dest !== 'string' || dest === '') {
      throw new StompError('Destination is required');
    }
    return dest.substr(dest.indexOf('/') + 1).split('.');
  },

  sendCommand: function (socket, command, headers, body, want_receipt) {
    if (headers === undefined) {
      headers = {};
    }

    if (want_receipt === true) {
      headers.receipt = genId('r');
    }

    var frame = new Frame({
      'command': command,
      'headers': headers,
      'body': body
    });

    sendFrame(socket, frame);
    return frame;
  },

  sendFrame: sendFrame,

  /**
   * Parse the first STOMP frame in `chunk`.
   *
   * @deprecated use FrameDecoder (lib/parser), it handles several frames per
   *   chunk and frames split across chunks
   * @param {string|Buffer} chunk Raw data
   * @param {string} [version] negotiated STOMP version, 1.0 disables header unescaping
   * @return {Frame|null} parsed frame or null if there is no complete frame in chunk
   */
  parseFrame: function (chunk, version) {
    if (chunk === undefined || chunk === null) {
      return null;
    }
    var decoder = new FrameDecoder();
    decoder.push(chunk);
    return decoder.shift(version);
  }
};

module.exports = stompUtils;
