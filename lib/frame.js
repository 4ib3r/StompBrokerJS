var bytes = require('./bytes');

/** Commands whose headers are not escaped: CONNECT and its alias STOMP, and CONNECTED */
var RAW_HEADER_COMMANDS = ['CONNECT', 'STOMP', 'CONNECTED'];

/**
 * Header escaping applies to STOMP 1.1+ frames, except CONNECT and CONNECTED
 *
 * @param {string} command Frame command
 * @param {string} [version] Negotiated STOMP version
 */
function shouldEscape(command, version) {
  return version !== '1.0' && RAW_HEADER_COMMANDS.indexOf(command) < 0;
}

/** Escape a header name or value according to STOMP 1.1 */
function escapeHeader(text) {
  if (!/[\\\n:]/.test(text)) {
    return text;
  }
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/:/g, '\\c');
}

/** Characters that can't be written in a header, escaped or not */
var UNWRITABLE_ESCAPED_RE = /[\r\0]/;
var UNWRITABLE_RAW_RE = /[\n\r\0]/;

/**
 * Header line for `name` and `value`, or null when the header can't be
 * written safely (it would corrupt the frame or inject headers or frames).
 */
function headerLine(name, value, escape) {
  name = String(name);
  value = String(value);
  if (escape) {
    if (UNWRITABLE_ESCAPED_RE.test(name) || UNWRITABLE_ESCAPED_RE.test(value)) {
      return null;
    }
    return escapeHeader(name) + ':' + escapeHeader(value) + '\n';
  }
  if (UNWRITABLE_RAW_RE.test(name) || UNWRITABLE_RAW_RE.test(value) || name.indexOf(':') >= 0) {
    return null;
  }
  return name + ':' + value + '\n';
}

function Frame(args) {
  this.command = null;
  this.headers = null;
  this.body = null;

  if (args) {
    this.buildFrame(args);
  }
}

Frame.prototype.buildFrame = function (frameArgs, want_receipt) {
  this.command = frameArgs.command;
  this.headers = frameArgs.headers;
  this.body = frameArgs.body;

  if (want_receipt) {
    var receipt_stamp = Math.floor(Math.random() * 99999999999).toString();
    this.headers.receipt = this.headers.session !== undefined ?
      receipt_stamp + '-' + this.headers.session : receipt_stamp;
  }
  return this;
};

/**
 * Serialize the frame. Headers with undefined or null values are left out, as
 * are headers that can't be written safely for the negotiated version.
 *
 * @param {string} [version] negotiated STOMP version, 1.0 disables header escaping
 * @return {string|Buffer} Buffer when the body is a Buffer, string otherwise
 */
Frame.prototype.toStringOrBuffer = function (version) {
  var escape = shouldEscape(this.command, version);
  var frame = this.command + '\n';

  for (var name in this.headers) {
    var value = this.headers[name];
    if (!Object.prototype.hasOwnProperty.call(this.headers, name) || value === undefined || value === null) {
      continue;
    }
    var line = headerLine(name, value, escape);
    if (line !== null) {
      frame += line;
    }
  }
  frame += '\n';

  if (Buffer.isBuffer(this.body)) {
    return Buffer.concat([Buffer.from(frame), this.body, Buffer.from(bytes.NULL)]);
  }

  if (this.body) {
    frame += this.body;
  }

  return frame + bytes.NULL;
};

Frame.shouldEscape = shouldEscape;

module.exports = Frame;
