var stomp = require('./lib/stomp');
var http = require("http");
var WebSocketServer = require('websocket').server;
var EventEmitter = require('events');
var util = require('util');

var StompServer = function (config) {
  EventEmitter.call(this);
  this.conf = {
    server: config.server || http.createServer(),
    debug: config.debug || function(args) {}
  };
  this.connections = {};
  this.subscribes = {};
  this.frameHandler = new stomp.FrameHandler(this);
  this.heartBeatConfig = {client: 0, server: 0};

  this.updateHeartBeatConfig = function (parts) {
    this.heartBeatConfig.client = parseInt(parts[0]);
    this.heartBeatConfig.server = parseInt(parts[1]);
  };

  this.socket = new WebSocketServer({
    httpServer: this.conf.server,
    autoAcceptConnections: true
  });

  this.socket.on('error', function (err) {
    this.conf.debug(err);
    this.emit('error', err);
  }.bind(this));

  this.socket.on('connect', function (webSocket) {
    webSocket.sessionId = stomp.StompUtils.genId();
    this.conf.debug("Connect", webSocket.sessionId);
    this.connections[webSocket.sessionId] = {
      socket: webSocket
    };
    webSocket.on('message', parseRequest.bind(this, webSocket));
    webSocket.on('close', connectionClose.bind(this, webSocket));
    webSocket.on('error', function (err) {
      this.conf.debug(err);
      this.emit('error', err);
    }.bind(this));
  }.bind(this));

  /**############# EVENTS ###################### */
  this.onClientConnected = function(socket, args) {
    socket.clientHeartBeat = {client: args.hearBeat[0], server: args.hearBeat[1]};
    this.conf.debug("CONNECT", socket.sessionId, socket.clientHeartBeat, args.headers);
    this.emit('connect', socket.sessionId, args.headers);
    return true;
  };

  this.onDisconnect = function (socket, receiptId) {
    this.emit('disconnect', socket.sessionId);
    this.conf.debug("DISCONNECT", socket.sessionId, receiptId);
    return true;
  };

  this.onSend = function (socket, args, callback) {
    var sub = this.subscribes[args.dest];
    if (sub) {
      for (var id in sub) {
        var idParts = id.split("|");
        var sock = sub[id];
        if (socket.sessionId == sock.sessionId) {
          continue;
        }
        stomp.StompUtils.sendCommand(sock, "MESSAGE", {
          subscription: idParts[0],
          'message-id': stomp.genId("msg"),
          destination: args.dest,
          'content-type': 'text/plain',
          'content-length': args.frame.headers['content-length']
        }, args.frame.body);
      }
    }
    callback(true);
  };

  this.onSubscribe = function(socket, args) {
    if (this.subscribes[args.dest] == undefined) {
      this.subscribes[args.dest] = {};
    }
    var id = args.id + "|" + socket.sessionId;
    this.subscribes[args.dest][id] = socket;
    this.conf.debug("Server subscribe", id, args.dest);
    return true;
  };

  this.onUnsubscribe = function (socket, subId) {
    var id = subId + "|" + socket.sessionId;
    for (var t in this.subscribes) {
      if (this.subscribes[t][id]) {
        delete this.subscribes[t][id];
        return true;
      }
    }
    return false;
  };
  /**############# END EVENTS ###################### */

  /** ################ FUNCTIONS ################### */
  this.subscribe = function(topic) {
    if (this.subscribes[topic] == undefined) {
      this.subscribes[topic] = {};
    }
    this.subscribes[topic]["1|1"] = {
      sessionId: "self_1234",
      send: function(frame) {
        this.emit(topic, frame.body, frame.headers);
      }.bind(this)
    };
  };

  this.send = function(topic, headers, body) {
    var _headers = {};
    if (headers) {
      for (var key in headers) {
        _headers[key] = headers[key];
      }
    }
    if (body) {
      _headers["content-length"] = body.length;
    }
    var args = {
      dest: topic,
      frame: {
        body: body,
        headers: _headers
      }
    };
    this.onSend(args);
  };
  /** ############# END FUNCTIONS ###################### */

  function connectionClose(socket) {
    delete this.connections[socket.sessionId];
  }

  function parseRequest(socket, req) {
    var frame = stomp.StompUtils.parseFrame(req.utf8Data);
    var cmdFunc = this.frameHandler[frame.command];
    if (cmdFunc) {
      return cmdFunc(socket, frame);
    }
    return "Command not found";
  }

};
util.inherits(StompServer, EventEmitter);
module.exports = StompServer;