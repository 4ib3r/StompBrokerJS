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

/**
 * Command line and header lines (without the empty line ending the block).
 * Headers with undefined or null values are left out, as are headers that
 * can't be written safely with the given escaping.
 */
function headerBlock(command, headers, escape) {
  var block = command + '\n';
  for (var name in headers) {
    var value = headers[name];
    if (!Object.prototype.hasOwnProperty.call(headers, name) || value === undefined || value === null) {
      continue;
    }
    var line = headerLine(name, value, escape);
    if (line !== null) {
      block += line;
    }
  }
  return block;
}

/** Complete frame from a header block and a body */
function withBody(block, body) {
  if (Buffer.isBuffer(body)) {
    return Buffer.concat([Buffer.from(block + '\n'), body, Buffer.from(bytes.NULL)]);
  }
  return block + '\n' + (body ? body : '') + bytes.NULL;
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
  return withBody(headerBlock(this.command, this.headers, shouldEscape(this.command, version)), this.body);
};

/**
 * A MESSAGE serialized for many subscribers: only the subscription header
 * differs between them, so the rest of the header block is built once per
 * escaping mode instead of once per subscriber.
 *
 * @param {object} headers message headers, without `subscription`
 * @param {string|Buffer} body
 */
function MessageTemplate(headers, body) {
  this.headers = headers;
  this.body = body;
  this._blocks = {};
}

/**
 * @param {string} version negotiated STOMP version of the subscriber
 * @param {string} subscription subscription id
 * @return {string|Buffer} serialized MESSAGE frame
 */
MessageTemplate.prototype.render = function (version, subscription) {
  var escape = shouldEscape('MESSAGE', version);
  var key = escape ? 'escaped' : 'raw';
  var block = this._blocks[key];
  if (block === undefined) {
    block = this._blocks[key] = headerBlock('MESSAGE', this.headers, escape);
  }
  var line = subscription === undefined ? null : headerLine('subscription', subscription, escape);
  return withBody(line === null ? block : block + line, this.body);
};

Frame.shouldEscape = shouldEscape;
Frame.MessageTemplate = MessageTemplate;

module.exports = Frame;
