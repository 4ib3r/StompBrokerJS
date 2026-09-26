var crypto = require('crypto');
var Frame = require('./frame');
var BYTES = require('./bytes');

var LF_CODE = BYTES.LF.charCodeAt(0);
var CR_CODE = BYTES.CR.charCodeAt(0);

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

/** Unescape a header value according to STOMP 1.1 */
function unescapeHeaderValue(value) {
  if (value.indexOf('\\') < 0) {
    return value;
  }
  return value.replace(/\\(.)/g, function (match, chr) {
    switch (chr) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 'c': return ':';
      case '\\': return '\\';
      default: return match;
    }
  });
}

/** Add header line to headers, the first occurrence of a repeated header wins */
function addHeader(headers, line, unescape) {
  var idx = line.indexOf(':');
  if (idx < 1) {
    return;
  }
  var key = line.substring(0, idx).trim();
  var value = line.substring(idx + 1).trim();
  if (unescape) {
    key = unescapeHeaderValue(key);
    value = unescapeHeaderValue(value);
  }
  if (!(key in headers)) {
    headers[key] = value;
  }
}

/*
 * The parser works on strings (text WebSocket frames) and Buffers (binary
 * frames) alike: both support indexOf(string, from); these helpers cover the rest.
 */
function codeAt(src, i) {
  return typeof src === 'string' ? src.charCodeAt(i) : src[i];
}

function textOf(src, start, end) {
  return typeof src === 'string' ? src.substring(start, end) : src.toString('utf8', start, end);
}

/** Read line from `start` without trailing CR, returns {line, next} or null at end of input */
function readLine(src, start) {
  if (start >= src.length) {
    return null;
  }
  var end = src.indexOf(BYTES.LF, start);
  var next = end < 0 ? src.length : end + 1;
  if (end < 0) {
    end = src.length;
  }
  if (end > start && codeAt(src, end - 1) === CR_CODE) {
    end--;
  }
  return {line: textOf(src, start, end), next: next};
}

/**
 * Read body starting at `start`: `contentLength` UTF-8 bytes when it is valid
 * and available, otherwise up to the first NULL octet.
 */
function readBody(src, start, contentLength) {
  if (!isNaN(contentLength) && contentLength >= 0) {
    if (typeof src !== 'string') {
      if (start + contentLength <= src.length) {
        return src.toString('utf8', start, start + contentLength);
      }
    } else {
      // common case: as many characters as bytes (ASCII), no need to encode
      var candidate = src.substr(start, contentLength);
      if (candidate.length === contentLength && Buffer.byteLength(candidate) === contentLength) {
        return candidate;
      }
      var bytes = Buffer.from(src.substring(start), 'utf8');
      if (contentLength <= bytes.length) {
        return bytes.toString('utf8', 0, contentLength);
      }
    }
  }
  var end = src.indexOf(BYTES.NULL, start);
  return textOf(src, start, end < 0 ? src.length : end);
}

var stompUtils = {
  genId: genId,

  isOpen: isOpen,

  tokenizeDestination: function (dest) {
    if (typeof dest !== 'string' || dest === '') {
      throw new Error('Destination is required');
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
   * Parse single STOMP frame.
   * Leading EOLs (heart-beats) are skipped, body is read up to content-length
   * bytes if the header is present, otherwise up to the first NULL octet.
   *
   * @param {string|Buffer} chunk Raw frame
   * @param {string} [version] negotiated STOMP version, 1.0 disables header unescaping
   * @return {Frame|null} parsed frame or null if there is no frame in chunk
   */
  parseFrame: function (chunk, version) {
    if (chunk === undefined || chunk === null) {
      return null;
    }

    var src = Buffer.isBuffer(chunk) ? chunk : String(chunk);

    var pos = 0;
    while (pos < src.length && (codeAt(src, pos) === LF_CODE || codeAt(src, pos) === CR_CODE)) {
      pos++;
    }
    var commandLine = readLine(src, pos);
    if (commandLine === null) {
      return null;
    }
    var command = commandLine.line;
    var unescape = Frame.shouldEscape(command, version);

    // headers end at the first empty line
    var headers = {};
    var line;
    pos = commandLine.next;
    while ((line = readLine(src, pos)) !== null) {
      pos = line.next;
      if (line.line === '') {
        break;
      }
      addHeader(headers, line.line, unescape);
    }
    if ('content-length' in headers) {
      headers.bytes_message = true;
    }

    return new Frame({
      command: command,
      headers: headers,
      body: readBody(src, Math.min(pos, src.length), parseInt(headers['content-length'], 10))
    });
  }
};

module.exports = stompUtils;
