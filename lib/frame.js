var bytes = require('./bytes');

function mkBuffer(headers, body) {
  var hBuf = new Buffer.from(headers);
  var buf = new Buffer(hBuf.length + body.length + 1);
  hBuf.copy(buf);
  body.copy(buf, hBuf.length);
  buf[buf.length - 1] = Bytes.NULL;
  return buf;
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

  this.toStringOrBuffer = function () {
    var header_strs = [],
      frame = '';

    for (var header in this.headers) {
      header_strs.push(header + ':' + this.headers[header]);
    }

    frame += this.command + "\n";
    frame += header_strs.join("\n");
    frame += "\n\n";

    if (Buffer.isBuffer(this.body)) {
      return mkBuffer(frame, this.body);
    }

    if (this.body) {
      frame += this.body;
    }

    frame += bytes.NULL;

    return frame;
  };
}

module.exports = Frame;
