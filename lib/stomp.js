var Frame = require("./frame");

/** Unique id generator */
function genId(type) {
  return (type ? type : 'id') + Math.floor(Math.random() * 999999999999999999999);
}

/** Send frame with socket */
function sendFrame(socket, _frame) {
  if (socket.rawFrame) {
    socket.send(_frame);
    return true;
  }
  var frame_str = _frame.toString();
  socket.send(frame_str);
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
    headers[header[0].trim()] = header[1].trim();
  }
  return headers;
}
var StompUtils = {
  genId: genId,
  sendCommand: function (socket, command, headers, body, want_receipt) {
    var want_receipt = want_receipt || false;
    if (headers == undefined) {
      headers = {};
    }
    var frame = new Frame({
      'command': command,
      'headers': headers,
      'body': body
    });
    sendFrame(socket, frame, want_receipt);
    return frame;
  },
  parseFrame: function (chunk) {
    if (chunk == undefined) {
      return null;
    }

    var command = parseCommand(chunk);
    var data = chunk.slice(command.length + 1, chunk.length);
    data = data.toString('utf8', 0, data.length);

    var the_rest = data.split('\n\n');
    var headers = parseHeaders(the_rest[0]);
    var body = the_rest.slice(1, the_rest.length);

    if ('content-length' in headers) {
      headers['bytes_message'] = true;
    }

    return new Frame({
      command: command,
      headers: headers,
      body: body
    });
  }
};

var ServerFrame = {
  CONNECTED: function (socket, heartbeat) {
    StompUtils.sendCommand(socket, "CONNECTED", {
      session: socket.sessionId,
      server: "STOMP-JS/0.0.1",
      'heart-beat': heartbeat,
      version: '1.1'
    });
  },
  MESSAGE: function (socket, frame) {
    StompUtils.sendCommand(socket, "MESSAGE", frame.header, frame.body);
  },
  RECEIPT: function (socket, receipt) {
    StompUtils.sendCommand(socket, "RECEIPT", {'receipt-id': receipt});
  },
  ERROR: function (socket, message, description) {
    var len = description != undefined ? description.length : 0;
    var headers = {
      message: message,
      "content-type": "text/plain",
      "content-length": len
    };
    if (receipt) {
      headers['receipt-id'] = receipt;
    }
    StompUtils.sendCommand(socket, 'ERROR', headers, description);
  }
};

function FrameHandler(stompServer) {
  this.CONNECT = function (socket, frame) {
    var rawHeartBeat = frame.headers['heart-beat'];
    var parts = ['0', '0'];
    if (rawHeartBeat) {
      parts = rawHeartBeat.split(",");
    }

    if (stompServer.onClientConnected(socket, {hearBeat: parts, headers: frame.headers})) {
      rawHeartBeat = stompServer.heartBeatConfig.server + "," + stompServer.heartBeatConfig.client;
      ServerFrame.CONNECTED(socket, rawHeartBeat);
    } else {
      ServerFrame.ERROR(socket, "CONNECTION ERROR", "CONNECTION ERROR");
    }
  };
  this.DISCONNECT = function (socket, frame) {
    var receipt = frame.headers.receipt;
    if (stompServer.onDisconnect(socket, receipt)) {
      ServerFrame.RECEIPT(socket, receipt);
    } else {
      ServerFrame.ERROR(socket, "DISCONNECT ERROR", receipt);
    }
  };
  this.SUBSCRIBE = function (socket, frame) {
    var dest = frame.headers.destination;
    var ack = "auto" || frame.headers.ack;
    if (!stompServer.onSubscribe(socket, {dest: dest, ack: ack, id: frame.headers.id})) {
      ServerFrame.ERROR(socket, "SUBSCRIBE ERROR", dest);
    }
  };
  this.UNSUBSCRIBE = function (socket, frame) {
    var id = frame.headers.id;
    if (!stompServer.onUnsubscribe(socket, id)) {
      ServerFrame.ERROR(socket, "SUBSCRIBE ERROR", id);
    }
  };
  this.SEND = function (socket, frame) {
    var dest = frame.headers.destination;
    var receipt = frame.headers.receipt;
    stompServer.onSend(socket, {dest: dest, frame: frame}, function (res) {
      if (res && receipt) {
        ServerFrame.RECEIPT(socket, receipt);
      } else if (!res) {
        ServerFrame.ERROR(socket, "Send error", frame);
      }
    });
  };
}

module.exports = {
  StompUtils: StompUtils,
  ServerFrame: ServerFrame,
  FrameHandler: FrameHandler,
  genId: genId
};