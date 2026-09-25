var bytes = require('./bytes');

/** Commands whose header values are not escaped (STOMP 1.1 spec) */
var RAW_HEADER_COMMANDS = ['CONNECT', 'CONNECTED'];

/** Escape a header value according to STOMP 1.1 */
function escapeHeaderValue(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/:/g, '\\c');
}

function Frame(args) {
  this.command = null;
  this.headers = null;
  this.body = null;

  this.buildFrame = function (args, want_receipt) {
    var receipt_stamp = null;
    this.command = args.command;
    this.headers = args.headers;
    this.body = args.body;

    if (want_receipt) {
      var _receipt = '';
      receipt_stamp = Math.floor(Math.random() * 99999999999).toString();
      if (this.headers.session !== undefined) {
        _receipt = receipt_stamp + '-' + this.headers.session;
      }
      else {
        _receipt = receipt_stamp;
      }
      this.headers.receipt = _receipt;
    }
    return this;
  };

  if (args) {
    this.buildFrame(args);
  }

  /**
   * @param {boolean} [escapeHeaders=true] escape header values (STOMP 1.1+)
   */
  this.toStringOrBuffer = function (escapeHeaders) {
    var header_strs = [],
      frame = '',
      escape = escapeHeaders !== false && RAW_HEADER_COMMANDS.indexOf(this.command) < 0;

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

Frame.escapeHeaderValue = escapeHeaderValue;
Frame.RAW_HEADER_COMMANDS = RAW_HEADER_COMMANDS;

module.exports = Frame;
