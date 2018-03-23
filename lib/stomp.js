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
    var rawHeartbeat = frame.headers['heart-beat'];
    var parts = ['0', '0'];
    if (rawHeartbeat) {
      parts = rawHeartbeat.split(',');
    }

    if (stompServer.onClientConnected(socket, {
      heartbeat: parts,
      headers: frame.headers
    })) {
      rawHeartbeat = stompServer.heartBeatConfig.server + ',' + stompServer.heartBeatConfig.client;
      ServerFrame.CONNECTED(socket, rawHeartbeat, stompServer.conf.serverName);
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
