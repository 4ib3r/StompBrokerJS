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
  if (config === undefined) {
    config = {};
  }
  this.conf = {
    server: config.server,
    path: config.path || "/stomp",
    debug: config.debug || function (args) {
    }
  };
  if (this.conf.server === undefined) {
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
    connectionClose(socket);
    this.conf.debug("DISCONNECT", socket.sessionId);
    this.emit('disconnected', socket.sessionId);
    this.conf.debug("DISCONNECT", socket.sessionId, receiptId);
    return true;
  };

  /**
   * Event emitted when broker send message to subscribers
   * @event StompServer#send
   * @type {object}
   * @property {string} dest Destination
   * @property {string} frame Message frame
   * */
  this.onSend = function (socket, args, callback) {
    var bodyObj = args.frame.body;
    var frame = this.frameSerializer(args.frame);
    var headers = { //default headers
      'message-id': stomp.genId("msg"),
      'content-type': 'text/plain'
    };
    if (frame.body !== undefined) {
      if (typeof frame.body !== 'string')
        throw "Message body is not string";
      frame.headers["content-length"] = frame.body.length;
    }
    if (frame.headers) {
      for (var key in frame.headers) {
        headers[key] = frame.headers[key];
      }
    }
    args.frame = frame;
    this.emit('send', {frame: {headers: frame.headers, body: bodyObj}, dest: args.dest});
    this._sendToSubscriptions(socket, frame);
    if (callback) {
      callback(true);
    }
  };

  /**
   * Send message to matching subscribers.
   *
   * @param {object} websocket to send the message on
   * @param {string} frame message frame
   * @private
   */
  this._sendToSubscriptions = function (socket, frame) {
    for (var i in this.subscribes) {
      var sub = this.subscribes[i];
      if (socket.sessionId === sub.sessionId) {
        continue;
      }
      //console.log(args.dest);
      var tokens = stomp.StompUtils.tokenizeDestination(args.dest);
      var match = true;
      for (var t in tokens) {
        var token = tokens[t];
        if (sub.tokens[t] === undefined ||
          (sub.tokens[t] !== token && sub.tokens[t] !== '*' && sub.tokens[t] !== '**')) {
          match = false;
          break;
        } else if (sub.tokens[t] === "**") {
          break;
        }
      }
      if (match) {
        frame.headers.subscription = sub.id;
        frame.command = "MESSAGE";
        var sock = sub.socket;
        if (sock !== undefined) {
          stomp.StompUtils.sendFrame(sock, frame);
        } else {
          this.emit(sub.id, bodyObj, frame.headers);
        }
      }
    }
  }

  /**
   * Client subscribe event, emitted when client subscribe topic
   * @event StompServer#subscribe
   * @type {object}
   * @property {string} id Subscription id
   * @property {string} sessionId Socket session id
   * @property {string} topic Destination topic
   * @property {string[]} tokens Tokenized topic
   * @property {object} socket Connected socket
   * */
  this.onSubscribe = function (socket, args) {
    var sub = {
      id: args.id,
      sessionId: socket.sessionId,
      topic: args.dest,
      tokens: stomp.StompUtils.tokenizeDestination(args.dest),
      socket: socket
    };
    this.subscribes.push(sub);
    this.emit("subscribe", sub);
    this.conf.debug("Server subscribe", args.id, args.dest);
    return true;
  };
  /**
   * Client subscribe event, emitted when client unsubscribe topic
   * @event StompServer#unsubscribe
   * @type {object}
   * @property {string} id Subscription id
   * @property {string} sessionId Socket session id
   * @property {string} topic Destination topic
   * @property {string[]} tokens Tokenized topic
   * @property {object} socket Connected socket
   * */

  /** @return {boolean} */
  this.onUnsubscribe = function (socket, subId) {
    for (var t in this.subscribes) {
      var sub = this.subscribes[t];
      if (sub.id === subId && sub.sessionId === socket.sessionId) {
        delete this.subscribes[t];
        this.emit("unsubscribe", sub);
        return true;
      }
    }
    return false;
  };
  /*############# END EVENTS ###################### */

  /* ################ FUNCTIONS ################### */

  var selfSocket = {
    sessionId: "self_1234"
  };

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
   * @param {object} headers Optional headers, used by client to provide a subscription ID (headers.id)
   * @return {string} Subscription id, when message is received event with this id is emitted
   * @example
   * stompServer.subscribe("/test.data", function(msg, headers) {});
   * //or alternative
   * var subs_id = stompServer.subscribe("/test.data");
   * stompServer.on(subs_id, function(msg, headers) {});
   * */
  this.subscribe = function (topic, callback, headers) {
    var id;
    if (!headers || !headers.id) {
      id = "self_" + Math.floor(Math.random() * 99999999999);
    } else {
      id = headers.id;
    }
    var sub = {
      topic: topic,
      tokens: stomp.StompUtils.tokenizeDestination(topic),
      id: id,
      sessionId: "self_1234"
    };
    this.subscribes.push(sub);
    this.emit("subscribe", sub);
    if (callback) {
      this.on(id, callback);
    }
    return id;
  };

  /** Unsubscribe topic with subscription id
   * @param {string} id Subscription id
   * @return {boolean} Subscription is deleted
   * */
  this.unsubscribe = function (id) {
    this.removeAllListeners(id);
    return this.onUnsubscribe(selfSocket, id);
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
    var frame = {
      body: body,
      headers: _headers
    };
    var args = {
      dest: topic,
      frame: this.frameParser(frame)
    };
    this.onSend(selfSocket, args);
  };

  /* ############# END FUNCTIONS ###################### */

  function connectionClose(socket) {
    var self = this;
    for (var t in self.subscribes) {
      var sub = self.subscribes[t];
      if (sub.sessionId === socket.sessionId) {
        delete self.subscribes[t];
      }
    }
  }

  /**
   * @typedef {object} MsgFrame
   * Message frame
   * */

  /** Serialize frame to string for send
   * @param {MsgFrame} frame Message frame
   * @return {MsgFrame} modified frame
   * */
  this.frameSerializer = function (frame) {
    if (frame.body !== undefined && frame.headers['content-type'] === 'application/json') {
      frame.body = JSON.stringify(frame.body);
    }
    return frame;
  };

  /** Parse frame to object for reading
   * @param {MsgFrame} frame Message frame
   * @return {MsgFrame} modified frame
   * */
  this.frameParser = function (frame) {
    if (frame.body !== undefined && frame.headers['content-type'] === 'application/json') {
      frame.body = JSON.parse(frame.body);
    }
    return frame;
  };

  function parseRequest(socket, data) {
    var frame = stomp.StompUtils.parseFrame(data);
    var cmdFunc = this.frameHandler[frame.command];
    if (cmdFunc) {
      frame = this.frameParser(frame);
      return cmdFunc(socket, frame);
    }
    return "Command not found";
  }

};
util.inherits(StompServer, EventEmitter);

/** Create a StompServer */
module.exports = StompServer;
