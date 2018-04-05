var StompUtils = require('./stomp-utils');

var ServerFrame = {
  CONNECTED: function (socket, heartbeat, serverName) {
    StompUtils.sendCommand(socket, 'CONNECTED', {
      session: socket.sessionId,
      server: serverName,
      'heart-beat': heartbeat,
      version: '1.1'
    });
  },
  
  MESSAGE: function (socket, frame) {
    StompUtils.sendCommand(socket, 'MESSAGE', frame.header, frame.body);
  },
  
  RECEIPT: function (socket, receipt) {
    StompUtils.sendCommand(socket, 'RECEIPT', {
      'receipt-id': receipt
    });
  },
  
  ERROR: function (socket, message, description) {
    var len = description !== undefined ? description.length : 0;
    var headers = {
      message: message,
      'content-type': 'text/plain',
      'content-length': len
    };

    if (receipt) {
      headers['receipt-id'] = receipt;
    }
    StompUtils.sendCommand(socket, 'ERROR', headers, description);
  }
};

function FrameHandler(stompServer) {
  this.CONNECT = function (socket, frame) {
    // setup heart-beat feature
    var rawHeartbeat = frame.headers['heart-beat'];
    var clientHeartbeat = [0, 0];
    if (rawHeartbeat) {
      clientHeartbeat = rawHeartbeat.split(',').map(function(x) { return parseInt(x); });
    }

    // default server heart-beat answer
    serverHeartbeat = [0, 0];

    // check preferred heart-beat direction: client → server
    if (clientHeartbeat[0] > 0 && stompServer.conf.heartbeat[1] > 0) {
      serverHeartbeat[1] = Math.max(clientHeartbeat[0], stompServer.conf.heartbeat[1]);
      stompServer.heartbeatOn(socket, serverHeartbeat[1], false);
    }
    // check non-preferred heart-beat direction: server → client
    else if (clientHeartbeat[1] > 0 && stompServer.conf.heartbeat[0] > 0) {
      serverHeartbeat[0] = Math.max(clientHeartbeat[1], stompServer.conf.heartbeat[0]);
      stompServer.heartbeatOn(socket, serverHeartbeat[0], true);
    }

    if (stompServer.onClientConnected(socket, {
      heartbeat: clientHeartbeat,
      headers: frame.headers
    })) {
      ServerFrame.CONNECTED(socket, serverHeartbeat.join(','), stompServer.conf.serverName);
    } else {
      ServerFrame.ERROR(socket, 'CONNECTION ERROR', 'CONNECTION ERROR');
    }
  };
  
  this.DISCONNECT = function (socket, frame) {
    var receipt = frame.headers.receipt;
    if (stompServer.onDisconnect(socket, receipt)) {
      ServerFrame.RECEIPT(socket, receipt);
    } else {
      ServerFrame.ERROR(socket, 'DISCONNECT ERROR', receipt);
    }
  };
  
  this.SUBSCRIBE = function (socket, frame) {
    var dest = frame.headers.destination;
    var ack = 'auto' || frame.headers.ack;
    if (!stompServer.onSubscribe(socket, {
      dest: dest,
      ack: ack,
      id: frame.headers.id
    })) {
      ServerFrame.ERROR(socket, 'SUBSCRIBE ERROR', dest);
    }
  };
  
  this.UNSUBSCRIBE = function (socket, frame) {
    var id = frame.headers.id;
    if (!stompServer.onUnsubscribe(socket, id)) {
      ServerFrame.ERROR(socket, 'UNSUBSCRIBE ERROR', id);
    }
  };
  
  this.SEND = function (socket, frame) {
    var dest = frame.headers.destination;
    var receipt = frame.headers.receipt;
    stompServer.onSend(socket, {
      dest: dest,
      frame: frame
    }, function (res) {
      if (res && receipt) {
        ServerFrame.RECEIPT(socket, receipt);
      } else if (!res) {
        ServerFrame.ERROR(socket, 'Send error', frame);
      }
    });
  };
}

module.exports = {
  StompUtils: StompUtils,
  ServerFrame: ServerFrame,
  FrameHandler: FrameHandler,
  genId: StompUtils.genId
};
