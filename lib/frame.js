var bytes = require('./bytes');

/** Commands whose header values are not escaped (STOMP 1.1 spec) */
var RAW_HEADER_COMMANDS = ['CONNECT', 'CONNECTED'];

/**
 * Header escaping applies to STOMP 1.1+ frames, except CONNECT and CONNECTED
 *
 * @param {string} command Frame command
 * @param {string} [version] Negotiated STOMP version
 */
function shouldEscape(command, version) {
  return version !== '1.0' && RAW_HEADER_COMMANDS.indexOf(command) < 0;
}

/** Escape a header value according to STOMP 1.1 */
function escapeHeaderValue(value) {
  value = String(value);
  if (!/[\\\n:]/.test(value)) {
    return value;
  }
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/:/g, '\\c');
}

function Frame(args) {
  this.command = null;
  this.headers = null;
  this.body = null;

  this.buildFrame = function (frameArgs, want_receipt) {
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

  if (args) {
    this.buildFrame(args);
  }

  /**
   * @param {string} [version] negotiated STOMP version, 1.0 disables header escaping
   */
  this.toStringOrBuffer = function (version) {
    var header_strs = [],
      frame = '',
      escape = shouldEscape(this.command, version);

    for (var header in this.headers) {
      var value = this.headers[header];
      header_strs.push(header + ':' + (escape ? escapeHeaderValue(value) : value));
    }

    frame += this.command + "\n";
    frame += header_strs.join("\n");
    frame += "\n\n";

    if (Buffer.isBuffer(this.body)) {
      return Buffer.concat([Buffer.from(frame), this.body, Buffer.from(bytes.NULL)]);
    }

    if (this.body) {
      frame += this.body;
    }

    frame += bytes.NULL;

    return frame;
  };
}

Frame.shouldEscape = shouldEscape;

module.exports = Frame;
