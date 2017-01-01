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
  this.subscribes = [];
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
    for (var i in this.subscribes) {
      var sub = this.subscribes[i]
      if (socket.sessionId == sub.sessionId) {
        continue;
      }
      var tokens = args.dest.substr(args.dest.indexOf('/')+1).split(".");
      var match = true;
      for (var t in tokens) {
        var token = tokens[t];
        if (sub.tokens[t] == undefined ||
          (sub.tokens[t] != token && sub.tokens[t] != '*' && sub.tokens[t] != '**')) {
          match = false;
          break;
        } else if (sub.tokens[t] == "**") {
          break;
        }
      }
      if (match) {
        var sock = sub.socket;
        stomp.StompUtils.sendCommand(sock, "MESSAGE", {
          subscription: sub.id,
          'message-id': stomp.genId("msg"),
          destination: args.dest,
          'topic': sub.topic,
          'content-type': 'text/plain',
          'content-length': args.frame.headers['content-length']
        }, args.frame.body);
      }
    }
    callback(true);
  };

  this.onSubscribe = function(socket, args) {
    this.subscribes.push({
      id: args.id,
      sessionId: socket.sessionId,
      topic: args.dest,
      tokens: args.dest.substr(args.dest.indexOf('/')+1).split("."),
      socket: socket
    });
    this.conf.debug("Server subscribe", args.id, args.dest);
    return true;
  };

  this.onUnsubscribe = function (socket, subId) {
    for (var t in this.subscribes) {
      var sub = this.subscribes[t];
      if (sub.id == subId && sub.sessionId == socket.sessionId) {
        delete this.subscribes[t];
        return true;
      }
    }
    return false;
  };
  /**############# END EVENTS ###################### */

  /** ################ FUNCTIONS ################### */
  this.subscribe = function(topic, callback) {
    var id = "self_" + Math.floor(Math.random() * 99999999999);
    this.subscribes.push({
      topic: topic,
      tokens: topic.substr(topic.indexOf('/')+1).split("."),
      id: id,
      sessionId: "self_1234",
      socket: {
        rawFrame: true,
        sessionId: "self_1234",
        send: function (frame) {
          var body = frame.body != undefined ? frame.body.toString() : '';
          this.emit(id, body, frame.headers);
        }.bind(this)
      }
    });
    this.on(id, callback)
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