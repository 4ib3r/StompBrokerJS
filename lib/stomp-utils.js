var Frame = require('./frame');

/** Unique id generator */
function genId(type) {
  return (type ? type : 'id') + Math.floor(Math.random() * 999999999999999999999);
}

/** Send frame with socket */
function sendFrame(socket, _frame) {
  var frame = _frame;

  if (!_frame.hasOwnProperty('toString')) {
    frame = new Frame({
      'command': _frame.command,
      'headers': _frame.headers,
      'body': _frame.body
    });
  }

  socket.send(frame.toStringOrBuffer());
  return true;
}

/** Parse single command  */
function parseCommand(data) {
  var command,
      str = data.toString('utf8', 0, data.length);

  command = str.split('\n');
  return command[0];
}

/** Parse headers */
function parseHeaders(raw_headers) {
  var headers = {},
      headers_split = raw_headers.split('\n');

  for (var i = 0; i < headers_split.length; i++) {
    var header = headers_split[i].split(':');

    if (header.length > 1) {
      var key = header.shift().trim();
      headers[key] = header.join(':').trim();
      continue;
    }

    if (header[1]) {
      headers[header[0].trim()] = header[1].trim();
    }
  }
  return headers;
}

function trimNull(a) {
  var c = a.indexOf('\0');
  if (c > -1) {
    return a.substr(0, c);
  }
  return a;
}

var StompUtils = {
  genId: genId,

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

  parseFrame: function (chunk) {
    if (chunk === undefined) {
      return null;
    }

    var command = parseCommand(chunk);
    var data = chunk.slice(command.length + 1, chunk.length);
    data = data.toString('utf8', 0, data.length);

    var the_rest = data.split('\n\n');
    var headers = parseHeaders(the_rest[0]);
    var body = the_rest.slice(1, the_rest.length);

    if ('content-length' in headers) {
      headers.bytes_message = true;
    }

    return new Frame({
      command: command,
      headers: headers,
      body: trimNull(body.toString())
    });
  }
};

module.exports = StompUtils;
