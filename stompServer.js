var http            = require('http');
var WebSocketServer = require('ws').Server;
var EventEmitter    = require('events');
var util            = require('util');

var Stomp           = require('./lib/stomp');
var StompUtils      = require('./lib/stomp-utils');
var Bytes           = require('./lib/bytes');

const VERSION = require('./package.json').version;


/**
 * STOMP Server configuration
 *
 * @typedef {object} ServerConfig
 * @param {http.Server} server Http server reference
 * @param {string} [serverName=STOMP-JS/VERSION] Name of STOMP server
 * @param {string} [path=/stomp] WebSocket path
 * @param {array} [heartbeat=[10000, 10000]] Heartbeat; read documentation to config according to your desire
 * @param {number} [heartbeatErrorMargin=1000] Heartbeat error margin; specify how strict server should be
 * @param {function} [debug=function(args) {}] Debug function
 */


/**
 * @class
 * @augments EventEmitter
 * 
 * Create Stomp server with config
 * 
 * @param {ServerConfig} config Configuration for STOMP server
 */
var StompServer = function (config) {
  EventEmitter.call(this);

  if (config === undefined) {
    config = {};
  }
  
  this.conf = {
    server: config.server,
    serverName: config.serverName || 'STOMP-JS/' + VERSION,
    path: config.path || '/stomp',
    heartbeat: config.heartbeat || [10000, 10000],
    heartbeatErrorMargin: config.heartbeatErrorMargin || 1000,
    debug: config.debug || function (args) {
      // console.log(arguments);
    }
  };
  
  if (this.conf.server === undefined) {
    throw 'Server is required';
  }

  this.subscribes = [];
  this.frameHandler = new Stomp.FrameHandler(this);
  
  this.socket = new WebSocketServer({
    server: this.conf.server,
    path: this.conf.path,
    perMessageDeflate: false
  });

  /**
   * Client connecting event, emitted after socket is opened.
   *
   * @event StompServer#connecting
   * @type {object}
   * @property {string} sessionId
   */
  this.socket.on('connection', function (ws) {
    ws.sessionId = StompUtils.genId();

    this.emit('connecting', ws.sessionId);
    this.conf.debug('Connect', ws.sessionId);

    ws.on('message', this.parseRequest.bind(this, ws));
    ws.on('close', this.onDisconnect.bind(this, ws));
    ws.on('error', function (err) {
      this.conf.debug(err);
      this.emit('error', err);
    }.bind(this));
  }.bind(this));


  //<editor-fold defaultstate="collapsed" desc="Events">

  /**
   * Client connected event, emitted after connection established and negotiated
   *
   * @event StompServer#connected
   * @type {object}
   * @property {string} sessionId
   * @property {object} headers
   */
  this.onClientConnected = function (socket, args) {
    socket.clientHeartbeat = {
      client: args.heartbeat[0],
      server: args.heartbeat[1]
    };
    this.conf.debug('CONNECT', socket.sessionId, socket.clientHeartbeat, args.headers);
    this.emit('connected', socket.sessionId, args.headers);
    return true;
  };


  /**
   * Client disconnected event
   *
   * @event StompServer#disconnected
   * @type {object}
   * @property {string} sessionId
   */
  this.onDisconnect = function (socket, receiptId) {
    this.afterConnectionClose(socket);
    this.conf.debug('DISCONNECT', socket.sessionId);
    this.emit('disconnected', socket.sessionId);
    this.conf.debug('DISCONNECT', socket.sessionId, receiptId);
    return true;
  };


  /**
   * Event emitted when broker send message to subscribers
   *
   * @event StompServer#send
   * @type {object}
   * @property {string} dest Destination
   * @property {string} frame Message frame
   */
  this.onSend = function (socket, args, callback) {
    var bodyObj = args.frame.body;
    var frame = this.frameSerializer(args.frame);
    var headers = {
      //default headers
      'message-id': StompUtils.genId('msg'),
      'content-type': 'text/plain'
    };

    if (frame.body !== undefined) {
      if (typeof frame.body !== 'string' && !Buffer.isBuffer(frame.body)) {
        throw 'Message body is not string';
      }
      frame.headers['content-length'] = frame.body.length;
    }

    if (frame.headers) {
      for (var key in frame.headers) {
        headers[key] = frame.headers[key];
      }
    }

    args.frame = frame;
    this.emit('send', {
      frame: {
        headers: frame.headers,
        body: bodyObj
      },
      dest: args.dest
    });

    this._sendToSubscriptions(socket, args);

    if (callback) {
      callback(true);
    }
  };


  /**
   * Client subscribe event, emitted when client subscribe topic
   *
   * @event StompServer#subscribe
   * @type {object}
   * @property {string} id Subscription id
   * @property {string} sessionId Socket session id
   * @property {string} topic Destination topic
   * @property {string[]} tokens Tokenized topic
   * @property {object} socket Connected socket
   */
  this.onSubscribe = function (socket, args) {
    var sub = {
      id: args.id,
      sessionId: socket.sessionId,
      topic: args.dest,
      tokens: StompUtils.tokenizeDestination(args.dest),
      socket: socket
    };
    this.subscribes.push(sub);
    this.emit('subscribe', sub);
    this.conf.debug('Server subscribe', args.id, args.dest);
    return true;
  };


  /**
   * Client subscribe event, emitted when client unsubscribe topic
   *
   * @event StompServer#unsubscribe
   * @type {object}
   * @property {string} id Subscription id
   * @property {string} sessionId Socket session id
   * @property {string} topic Destination topic
   * @property {string[]} tokens Tokenized topic
   * @property {object} socket Connected socket
   * @return {boolean}
   */
  this.onUnsubscribe = function (socket, subId) {
    for (var t in this.subscribes) {
      var sub = this.subscribes[t];
      if (sub.id === subId && sub.sessionId === socket.sessionId) {
        delete this.subscribes[t];
        this.emit('unsubscribe', sub);
        return true;
      }
    }
    return false;
  };

  //</editor-fold>


  //<editor-fold defaultstate="collapsed" desc="Subscribe & Unsubscribe">

  var selfSocket = {
    sessionId: 'self_1234'
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
   */


  /**
   * Subscribe topic
   *
   * @param {string} topic Subscribed destination, wildcard is supported
   * @param {OnSubscribedMessageCallback=} callback Callback function
   * @param {object} headers Optional headers, used by client to provide a subscription ID (headers.id)
   * @return {string} Subscription id, when message is received event with this id is emitted
   * @example
   * stompServer.subscribe('/test.data', function(msg, headers) {});
   * //or alternative
   * var subs_id = stompServer.subscribe('/test.data');
   * stompServer.on(subs_id, function(msg, headers) {});
   */
  this.subscribe = function (topic, callback, headers) {
    var id;
    if (!headers || !headers.id) {
      id = 'self_' + Math.floor(Math.random() * 99999999999);
    } else {
      id = headers.id;
    }
    var sub = {
      topic: topic,
      tokens: StompUtils.tokenizeDestination(topic),
      id: id,
      sessionId: 'self_1234'
    };
    this.subscribes.push(sub);
    this.emit('subscribe', sub);
    if (callback) {
      this.on(id, callback);
    }
    return id;
  };


  /** Unsubscribe topic with subscription id
   *
   * @param {string} id Subscription id
   * @return {boolean} Subscription is deleted
   */
  this.unsubscribe = function (id) {
    this.removeAllListeners(id);
    return this.onUnsubscribe(selfSocket, id);
  };

  //</editor-fold>


  //<editor-fold defaultstate="collapsed" desc="Send">

  /**
   * Send message to matching subscribers.
   *
   * @param {object} socket websocket to send the message on
   * @param {string} args onSend args
   * @private
   */
  this._sendToSubscriptions = function (socket, args) {
    for (var i in this.subscribes) {
      var sub = this.subscribes[i];
      if (socket.sessionId === sub.sessionId) {
        continue;
      }
      var match = this._checkSubMatchDest(sub, args);
      if (match) {
        args.frame.headers.subscription = sub.id;
        args.frame.command = 'MESSAGE';
        var sock = sub.socket;
        if (sock !== undefined) {
          StompUtils.sendFrame(sock, args.frame);
        } else {
          this.emit(sub.id, args.frame.body, args.frame.headers);
        }
      }
    }
  };


  /** Send message to topic
   *
   * @param {string} topic Destination for message
   * @param {object} headers Message headers
   * @param {string} body Message body
   */
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

  //</editor-fold>


  //<editor-fold defaultstate="collapsed" desc="Frames">

  /**
   * Serialize frame to string for send
   *
   * @param {MsgFrame} frame Message frame
   * @return {MsgFrame} modified frame
   * */
  this.frameSerializer = function (frame) {
    if (frame.body !== undefined && frame.headers['content-type'] === 'application/json' && !Buffer.isBuffer(frame.body)) {
      frame.body = JSON.stringify(frame.body);
    }
    return frame;
  };


  /**
   * Parse frame to object for reading
   *
   * @param {MsgFrame} frame Message frame
   * @return {MsgFrame} modified frame
   * */
  this.frameParser = function (frame) {
    if (frame.body !== undefined && frame.headers['content-type'] === 'application/json') {
      frame.body = JSON.parse(frame.body);
    }
    return frame;
  };

  //</editor-fold>


  //<editor-fold defaultstate="collapsed" desc="Heartbeat">

  /**
   * Heart-beat: Turn On for given socket
   *
   * @param {WebSocket} socket Destination WebSocket
   * @param {number} interval Heart-beat interval
   * @param {boolean} serverSide If true then server is responsible for sending pings
   * */
  this.heartbeatOn = function (socket, interval, serverSide) {
    var self = this;

    if (serverSide) {
      // Server takes responsibility for sending pings
      // Client should close connection on timeout
      socket.heartbeatClock = setInterval(function() {
        if(socket.readyState == 1) {
          self.conf.debug('PING');
          socket.send(Bytes.LF);
        }
      }, interval);

    } else {
      // Client takes responsibility for sending pings
      // Server should close connection on timeout
      socket.heartbeatTime = Date.now() + interval;
      socket.heartbeatClock = setInterval(function() {
        var diff = Date.now() - socket.heartbeatTime;
        if (diff > interval + self.conf.heartbeatErrorMargin) {
          self.conf.debug('HEALTH CHECK failed! Closing', diff, interval);
          socket.close();
        } else {
          self.conf.debug('HEALTH CHECK ok!', diff, interval);
          socket.heartbeatTime -= diff;
        }
      }, interval);
    }
  };


  /**
   * Heart-beat: Turn Off for given socket
   *
   * @param {WebSocket} socket Destination WebSocket
   * */
  this.heartbeatOff = function (socket) {
    if(socket.heartbeatClock !== undefined) {
      clearInterval(socket.heartbeatClock);
      delete socket.heartbeatClock;
    }
  };

  //</editor-fold>


  /**
   * Test if the input subscriber has subscribed to the target destination.
   *
   * @param sub the subscriber
   * @param args onSend args
   * @returns {boolean} true if the input subscription matches destination
   * @private
   */
  this._checkSubMatchDest = function (sub, args) {
    var match = true;
    var tokens = StompUtils.tokenizeDestination(args.dest);
    for (var t in tokens) {
      var token = tokens[t];
      if (sub.tokens[t] === undefined || (sub.tokens[t] !== token && sub.tokens[t] !== '*' && sub.tokens[t] !== '**')) {
        match = false;
        break;
      } else if (sub.tokens[t] === '**') {
        break;
      }
    }
    return match;
  };


  /**
   * After connection close
   *
   * @param socket WebSocket connection that has been closed and is dying
   */
  this.afterConnectionClose = function (socket) {
    // remove from subscribes
    for (var t in this.subscribes) {
      var sub = this.subscribes[t];
      if (sub.sessionId === socket.sessionId) {
        delete this.subscribes[t];
      }
    }

    // turn off server side heart-beat (if needed)
    this.heartbeatOff(socket);
  };


  this.parseRequest = function(socket, data) {
    // check if it's incoming heartbeat
    if (socket.heartbeatClock !== undefined) {
      // beat
      socket.heartbeatTime = Date.now();

      // if it's ping then ignore
      if(data === Bytes.LF) {
        this.conf.debug('PONG');
        return;
      }
    }

    // normal data
    var frame = StompUtils.parseFrame(data);
    var cmdFunc = this.frameHandler[frame.command];
    if (cmdFunc) {
      frame = this.frameParser(frame);
      return cmdFunc(socket, frame);
    }

    return 'Command not found';
  };

};

util.inherits(StompServer, EventEmitter);

// Export
module.exports = StompServer;
