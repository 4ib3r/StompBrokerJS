var crypto = require('crypto');
var Frame = require('./frame');

var LF = 0x0a;
var CR = 0x0d;
var NULL = 0x00;

/** Unique id generator */
function genId(type) {
  return (type ? type : 'id') + crypto.randomBytes(12).toString('hex');
}

/** Send frame with socket */
function sendFrame(socket, _frame) {
  var frame = _frame;

  // skip sockets that are closing or closed, `ws` throws on send
  if (socket.readyState !== undefined && socket.readyState !== 1) {
    return false;
  }

  if (!(_frame instanceof Frame)) {
    frame = new Frame({
      'command': _frame.command,
      'headers': _frame.headers,
      'body': _frame.body
    });
  }

  // STOMP 1.0 has no header escaping
  socket.send(frame.toStringOrBuffer(socket.stompVersion !== '1.0'));
  return true;
}

/** Unescape a header value according to STOMP 1.1 */
function unescapeHeaderValue(value) {
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

/** Parse headers, the first occurrence of a repeated header wins */
function parseHeaders(raw_headers, unescape) {
  var headers = {},
      headers_split = raw_headers.split('\n');

  for (var i = 0; i < headers_split.length; i++) {
    var line = headers_split[i].replace(/\r$/, '');
    var idx = line.indexOf(':');
    if (idx < 1) {
      continue;
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
  return headers;
}

/** Index of the end of line starting search at `from`, or -1 */
function indexOfLF(buf, from) {
  return buf.indexOf(LF, from);
}

/** Check if data contains only EOLs, i.e. is a heart-beat */
function isHeartbeat(data) {
  if (data === undefined || data === null || data.length === 0) {
    return false;
  }
  return /^(\r?\n)+$/.test(data.toString());
}

var stompUtils = {
  genId: genId,

  isHeartbeat: isHeartbeat,

  tokenizeDestination: function (dest) {
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

    var buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');

    var start = 0;
    while (start < buf.length && (buf[start] === LF || buf[start] === CR)) {
      start++;
    }
    if (start >= buf.length) {
      return null;
    }

    var commandEnd = indexOfLF(buf, start);
    if (commandEnd < 0) {
      commandEnd = buf.length;
    }
    var command = buf.toString('utf8', start, commandEnd).replace(/\r$/, '');

    // headers end at the first empty line
    var headersStart = commandEnd + 1;
    var headersEnd = headersStart;
    var bodyStart;
    if (buf[headersStart] === LF) {
      bodyStart = headersStart + 1;
    } else if (buf[headersStart] === CR && buf[headersStart + 1] === LF) {
      bodyStart = headersStart + 2;
    } else {
      var lfLf = buf.indexOf('\n\n', headersStart);
      var crLf = buf.indexOf('\n\r\n', headersStart);
      if (lfLf < 0 && crLf < 0) {
        headersEnd = buf.length;
        bodyStart = buf.length;
      } else if (crLf >= 0 && (lfLf < 0 || crLf < lfLf)) {
        headersEnd = crLf;
        bodyStart = crLf + 3;
      } else {
        headersEnd = lfLf;
        bodyStart = lfLf + 2;
      }
    }

    var unescape = version !== '1.0' && Frame.RAW_HEADER_COMMANDS.indexOf(command) < 0;
    var headers = parseHeaders(buf.toString('utf8', headersStart, headersEnd), unescape);

    var bodyEnd;
    var contentLength = parseInt(headers['content-length'], 10);
    if ('content-length' in headers) {
      headers.bytes_message = true;
    }
    if (!isNaN(contentLength) && contentLength >= 0 && bodyStart + contentLength <= buf.length) {
      bodyEnd = bodyStart + contentLength;
    } else {
      bodyEnd = buf.indexOf(NULL, bodyStart);
      if (bodyEnd < 0) {
        bodyEnd = buf.length;
      }
    }

    return new Frame({
      command: command,
      headers: headers,
      body: buf.toString('utf8', Math.min(bodyStart, buf.length), bodyEnd)
    });
  }
};

module.exports = stompUtils;
