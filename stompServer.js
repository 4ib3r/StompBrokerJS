var stomp = require('./lib/stomp');
var http = require("http");
var WebSocketServer = require('ws').Server;
var EventEmitter = require('events');
var util = require('util');

/**
 * STOMP Server configuration
 * @typedef {object} ServerConfig
 * @param {http.Server} server Http server reference
 * @param {function} [debug=function(args) {}] Debug function
 * @param {string} [path=/stomp] Websocket path
 * */


/**
 * @class
 * @augments EventEmitter
 * Create stomp server with config
 * @param {ServerConfig} config Configuration for STOMP server
 */
var StompServer = function (config) {
  EventEmitter.call(this);
  if (config == undefined) {
    config = {};
  }
  this.conf = {
    server: config.server,
    path: config.path || "/stomp",
    debug: config.debug || function (args) {}
  };
  if (this.conf.server == undefined) {
    throw "Server is required";
  }

  this.subscribes = [];
  this.frameHandler = new stomp.FrameHandler(this);
  this.heartBeatConfig = {client: 0, server: 0};


  this.socket = new WebSocketServer({
    server: this.conf.server,
    path: this.conf.path,
    perMessageDeflate: false
  });

  /**
   * Client error event
   * @event StompServer#error
   * @type {object}
   * */
  this.socket.on('error', function (err) {
    this.conf.debug(err);
    this.emit('error', err);
  }.bind(this));

  /**
   * Client connecting event, emitted after socket is opened.
   * @event StompServer#connecting
   * @type {object}
   * @property {string} sessionId
   * */
  this.socket.on('connection', function (webSocket) {
    webSocket.sessionId = stomp.StompUtils.genId();
    this.emit('connecting', webSocket.sessionId);
    this.conf.debug("Connect", webSocket.sessionId);
    webSocket.on('message', parseRequest.bind(this, webSocket));
    webSocket.on('close', connectionClose.bind(this, webSocket));
    webSocket.on('error', function (err) {
      this.conf.debug(err);
      this.emit('error', err);
    }.bind(this));
  }.bind(this));

  /*############# EVENTS ###################### */

  /**
   * Client connected event, emitted after connection established and negotiated
   * @event StompServer#connected
   * @type {object}
   * @property {string} sessionId
   * @property {object} headers
   * */
  this.onClientConnected = function (socket, args) {
    socket.clientHeartBeat = {client: args.hearBeat[0], server: args.hearBeat[1]};
    this.conf.debug("CONNECT", socket.sessionId, socket.clientHeartBeat, args.headers);
    this.emit('connected', socket.sessionId, args.headers);
    return true;
  };


  /**
   * Client disconnected event
   * @event StompServer#disconnected
   * @type {object}
   * @property {string} sessionId
   * */
  this.onDisconnect = function (socket, receiptId) {
    this.connectionClose(socket).bind(this);
    this.conf.debug("DISCONNECT", socket.sessionId);
    this.emit('disconnected', socket.sessionId);
    this.conf.debug("DISCONNECT", socket.sessionId, receiptId);
    return true;
  };

  this.onSend = function (socket, args, callback) {
    for (var i in this.subscribes) {
      var sub = this.subscribes[i]
      if (socket.sessionId == sub.sessionId) {
        continue;
      }
      //console.log(args.dest);
      var tokens = args.dest.substr(args.dest.indexOf('/') + 1).split(".");
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
          'subscription': sub.id,
          'message-id': stomp.genId("msg"),
          'destination': args.dest,
          'topic': sub.topic,
          'content-type': 'text/plain',
          'content-length': args.frame.headers['content-length']
        }, args.frame.body);
      }
    }
    if (callback) {
      callback(true);
    }
  };

  this.onSubscribe = function (socket, args) {
    this.subscribes.push({
      id: args.id,
      sessionId: socket.sessionId,
      topic: args.dest,
      tokens: args.dest.substr(args.dest.indexOf('/') + 1).split("."),
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
  /*############# END EVENTS ###################### */

  /* ################ FUNCTIONS ################### */

  function selfSocket(_this, subId) {
    return {
      rawFrame: true,
      sessionId: "self_1234",
      send: function (frame) {
        var body = frame.body != undefined ? frame.body.toString() : '';
        this.emit(subId, body, frame.headers);
      }.bind(_this)
    };
  }


  /**
   * Subscription callback method
   *
   * @callback OnSubscribedMessageCallback
   * @param {string} msg Message body
   * @param {object} headers Message headers
   * @param {string} headers.destination Message destination
   * @param {string} headers.subscription Id of subscription
   * @param {string} headers.message-id Id of message
   * @param {string} headers.content-type Content type
   * @param {string} headers.content-length Content length
   * */

  /** Subsribe topic
   * @param {string} topic Subscribed destination, wildcard is supported
   * @param {OnSubscribedMessageCallback=} callback Callback function
   * @return {string} Subscription id, when message is received event with this id is emitted
   * @example
   * stompServer.subscribe("/test.data", function(msg, headers) {});
   * //or alternative
   * var subs_id = stompServer.subscribe("/test.data");
   * stompServer.on(subs_id, function(msg, headers) {});
   * */
  this.subscribe = function (topic, callback) {
    var id = "self_" + Math.floor(Math.random() * 99999999999);
    this.subscribes.push({
      topic: topic,
      tokens: topic.substr(topic.indexOf('/') + 1).split("."),
      id: id,
      sessionId: "self_1234",
      socket: selfSocket(this, id)
    });
    if (callback) {
      this.on(id, callback);
    }
    return id;
  };

  /** Unsubscribe topic with subscription id
   * @param {string} id Subscription id
   * @return {boolean} Subscription is deleted
   * */
  this.unsubscribe = function(id) {
    this.removeAllListeners(id);
    return this.onUnsubscribe(selfSocket(this, id), id);
  };

  /** Send message to topic
   * @param {string} topic Destination for message
   * @param {object} headers Message headers
   * @param {string} body Message body */
  this.send = function (topic, headers, body) {
    var _headers = {};
    if (headers) {
      for (var key in headers) {
        _headers[key] = headers[key];
      }
    }
    if (body) {
      if (typeof body != 'string')
        body = body.toString();
      _headers["content-length"] = body.length;
    }
    var args = {
      dest: topic,
      frame: {
        body: body,
        headers: _headers
      }
    };
    this.onSend(selfSocket(this, 'internal'), args);
  };

  /* ############# END FUNCTIONS ###################### */

  function connectionClose(socket) {
    var self = this;
    for (var t in self.subscribes) {
      var sub = self.subscribes[t];
      if (sub.sessionId == socket.sessionId) {
        delete self.subscribes[t];
      }
    }
  }

  function parseRequest(socket, data) {
    var frame = stomp.StompUtils.parseFrame(data);
    var cmdFunc = this.frameHandler[frame.command];
    if (cmdFunc) {
      return cmdFunc(socket, frame);
    }
    return "Command not found";
  }

};
util.inherits(StompServer, EventEmitter);

/** Create a StompServer */
module.exports = StompServer;