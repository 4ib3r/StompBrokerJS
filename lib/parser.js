var Frame = require('./frame');
var ProtocolError = require('./errors').ProtocolError;

var LF = 0x0a;
var CR = 0x0d;
var NUL = 0x00;

/** Same bound as the `ws` default maxPayload, configurable per decoder */
var DEFAULT_MAX_FRAME_SIZE = 100 * 1024 * 1024;

var COMMAND_RE = /^[A-Z]+$/;
var CONTENT_LENGTH_RE = /^\d+$/;

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Unescape a STOMP 1.1 header name or value. Unknown escape sequences are
 * kept verbatim: STOMP 1.0-style clients (e.g. stompjs 2.x) send backslashes
 * unescaped, and rejecting them would break those clients.
 */
function unescapeHeader(text) {
  if (text.indexOf('\\') < 0) {
    return text;
  }
  return text.replace(/\\(.?)/g, function (match, chr) {
    switch (chr) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 'c': return ':';
      case '\\': return '\\';
      default: return match;
    }
  });
}

/**
 * Find the empty line ending the command and header block: an LF followed by
 * LF or CRLF, after the command line. Returns the end of the block (it is
 * buf[0, end)) and the start of the body, or null when it is incomplete.
 */
function findHeaderEnd(buf) {
  for (var pos = buf.indexOf(LF); pos >= 0; pos = buf.indexOf(LF, pos + 1)) {
    if (buf[pos + 1] === LF) {
      return {end: pos, bodyStart: pos + 2};
    }
    if (buf[pos + 1] === CR && buf[pos + 2] === LF) {
      return {end: pos, bodyStart: pos + 3};
    }
  }
  return null;
}

/** Line without the CR of a CRLF line ending */
function stripCR(line) {
  return line.charCodeAt(line.length - 1) === CR ? line.substring(0, line.length - 1) : line;
}

/** Add header line to headers, the first occurrence of a repeated header wins */
function addHeader(headers, line, unescape) {
  var idx = line.indexOf(':');
  if (idx < 1) {
    throw new ProtocolError('Malformed header line');
  }
  var name = line.substring(0, idx);
  var value = line.substring(idx + 1);
  if (unescape && line.indexOf('\\') >= 0) {
    name = unescapeHeader(name);
    value = unescapeHeader(value);
  }
  // CR can't be escaped in STOMP 1.1: relaying it would let a sender
  // corrupt the header lines of subscribers (NUL is checked per block)
  if (name.indexOf('\r') >= 0 || value.indexOf('\r') >= 0) {
    throw new ProtocolError('Header contains a forbidden character');
  }
  // a `__proto__` key would set the prototype instead of a header; values are
  // strings, so undefined means "not set yet" unless the name is inherited
  if (name !== '__proto__' && (headers[name] === undefined || !hasOwn(headers, name))) {
    headers[name] = value;
  }
}

/**
 * Incremental STOMP frame decoder for one connection.
 *
 * Data is fed with push() as it arrives from the transport, in chunks of any
 * size: a chunk may hold several frames, and a frame may span several chunks.
 * shift() returns the next complete frame, or null until more data arrives.
 *
 * The body of a frame is a string when it arrived in text messages and a
 * Buffer when any part of it arrived in a binary message.
 *
 * @param {object} [options]
 * @param {number} [options.maxFrameSize] bytes buffered for one frame before it is rejected
 */
function FrameDecoder(options) {
  this.maxFrameSize = (options && options.maxFrameSize) || DEFAULT_MAX_FRAME_SIZE;
  this._chunks = [];
  this._length = 0;
  // bytes needed before parsing is worth retrying
  this._need = 1;
  this._binary = false;
  // command and headers of the frame being received
  this._head = null;
}

/** Number of buffered bytes not yet returned as a frame */
Object.defineProperty(FrameDecoder.prototype, 'pending', {
  get: function () {
    return this._length;
  }
});

/**
 * Append received data.
 *
 * @param {string|Buffer} chunk text or binary transport message
 */
FrameDecoder.prototype.push = function (chunk) {
  var isBinary = Buffer.isBuffer(chunk);
  var buf = isBinary ? chunk : Buffer.from(String(chunk), 'utf8');
  if (this._length === 0) {
    this._binary = false;
  }
  this._binary = this._binary || isBinary;
  if (buf.length > 0) {
    this._chunks.push(buf);
    this._length += buf.length;
  }
};

/** Buffered data as one Buffer, concatenated only when needed */
FrameDecoder.prototype._buffer = function () {
  if (this._chunks.length > 1) {
    this._chunks = [Buffer.concat(this._chunks, this._length)];
  }
  return this._chunks.length ? this._chunks[0] : Buffer.alloc(0);
};

FrameDecoder.prototype._consume = function (count) {
  var rest = this._buffer().subarray(count);
  this._chunks = rest.length ? [rest] : [];
  this._length = rest.length;
};

/** Remember that `need` bytes are required, reject frames over the size limit */
FrameDecoder.prototype._wait = function (need) {
  if (need > this.maxFrameSize + 1) {
    throw new ProtocolError('Frame too large');
  }
  this._need = need;
  return null;
};

/** Parse command and headers; null when the header block is incomplete */
FrameDecoder.prototype._parseHead = function (buf, version) {
  var block = findHeaderEnd(buf);
  if (block === null) {
    return null;
  }
  var text = buf.toString('utf8', 0, block.end);
  // NUL would end the frame for the receiver: a sender could forge frames
  if (text.indexOf('\0') >= 0) {
    throw new ProtocolError('Header contains a forbidden character');
  }
  var lines = text.split('\n');
  var hasCR = text.indexOf('\r') >= 0;

  var command = hasCR ? stripCR(lines[0]) : lines[0];
  if (!COMMAND_RE.test(command)) {
    throw new ProtocolError('Invalid command');
  }
  var unescape = Frame.shouldEscape(command, version);
  var headers = {};
  for (var i = 1; i < lines.length; i++) {
    addHeader(headers, hasCR ? stripCR(lines[i]) : lines[i], unescape);
  }
  var pos = block.bodyStart;

  var contentLength = null;
  if (hasOwn(headers, 'content-length')) {
    if (!CONTENT_LENGTH_RE.test(headers['content-length'])) {
      throw new ProtocolError('Invalid content-length header');
    }
    contentLength = parseInt(headers['content-length'], 10);
  }
  return {command: command, headers: headers, contentLength: contentLength, bodyStart: pos, scanFrom: pos};
};

/**
 * Next complete frame.
 *
 * @param {string} [version] negotiated STOMP version, 1.0 disables header unescaping
 * @return {Frame|null} frame, or null when more data is needed
 * @throws {ProtocolError} on malformed data; the decoder must not be used afterwards
 */
FrameDecoder.prototype.shift = function (version) {
  if (this._length < this._need) {
    return null;
  }
  var buf = this._buffer();

  if (this._head === null) {
    // EOLs between frames are heart-beats
    var pos = 0;
    while (pos < buf.length && (buf[pos] === LF || buf[pos] === CR)) {
      pos++;
    }
    if (pos > 0) {
      this._consume(pos);
      buf = this._buffer();
    }
    if (buf.length === 0) {
      this._need = 1;
      return null;
    }
    this._head = this._parseHead(buf, version);
    if (this._head === null) {
      return this._wait(buf.length + 1);
    }
  }

  var head = this._head;
  var end;
  if (head.contentLength !== null) {
    end = head.bodyStart + head.contentLength;
    if (buf.length <= end) {
      return this._wait(end + 1);
    }
    if (buf[end] !== NUL) {
      throw new ProtocolError('Frame body is not followed by NUL after content-length octets');
    }
  } else {
    end = buf.indexOf(NUL, head.scanFrom);
    if (end < 0) {
      head.scanFrom = buf.length;
      return this._wait(buf.length + 1);
    }
  }

  var bodyBytes = buf.subarray(head.bodyStart, end);
  var frame = new Frame({
    command: head.command,
    headers: head.headers,
    // copy, a view would keep the whole receive buffer alive
    body: this._binary ? Buffer.from(bodyBytes) : bodyBytes.toString('utf8')
  });
  this._head = null;
  this._need = 1;
  this._consume(end + 1);
  return frame;
};

module.exports = {
  FrameDecoder: FrameDecoder,
  DEFAULT_MAX_FRAME_SIZE: DEFAULT_MAX_FRAME_SIZE
};
