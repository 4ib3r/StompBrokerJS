
function Frame(args) {
  this.command = null;
  this.headers = null;
  this.body = null;
  this.buildFrame = function(args, want_receipt) {
    var receipt_stamp = null;
    this.command = args.command;
    this.headers = args.headers;
    this.body = args.body;

    if (want_receipt) {
      var _receipt = '';
      receipt_stamp = Math.floor(Math.random() * 99999999999).toString();
      if (this.headers['session'] != undefined) {
        _receipt = receipt_stamp + "-" + this.headers['session'];
      }
      else {
        _receipt = receipt_stamp;
      }
      this.headers['receipt'] = _receipt;
    }
    return this;
  };
  if (args) {
    this.buildFrame(args);
  }
  this.toString = function() {
    var header_strs = [],
      frame = "";

    for (var header in this.headers) {
      header_strs.push(header + ':' + this.headers[header]);
    }

    frame += this.command + "\n";
    frame += header_strs.join("\n");
    frame += "\n\n";

    if(this.body) {
      frame += this.body;
    }

    frame += '\x00';

    return frame;
  }
};


module.exports = Frame;
