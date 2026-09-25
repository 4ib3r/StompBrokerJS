var EventEmitter    = require('events');
var util            = require('util');

var stomp           = require('./lib/stomp');
var stompUtils      = require('./lib/stomp-utils');
var BYTES           = require('./lib/bytes');

var protocolAdapter = require('./lib/adapter');
var buildConfig     = require('./lib/config');

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
 * @typedef MsgFrame Message frame object
 * @property {string|Buffer} body Message body, string or Buffer
 * @property {object} headers Message headers
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

  this.conf = buildConfig(config);

  this.subscribes = [];
  this.middleware = {};
  this.frameHandler = new stomp.FrameHandler(this);

  this.socket = new protocolAdapter[this.conf.protocol]({
      ...this.conf.protocolConfig,
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
    ws.sessionId = stompUtils.genId();

    this.emit('connecting', ws.sessionId);
    this.conf.debug('Connect', ws.sessionId);

    ws.on('message', this.parseRequest.bind(this, ws));
    ws.on('close', function () {
      // DISCONNECT frame already handled the graceful disconnect
      if (!ws.stompDisconnected) {
        ws.stompDisconnected = true;
        try {
          this.onDisconnect(ws);
        } catch (err) {
          this._emitError(err);
        }
      }
      this.afterConnectionClose(ws);
    }.bind(this));
    ws.on('error', function (err) {
      this.conf.debug(err);
      this._emitError(err);
    }.bind(this));
  }.bind(this));

  /**
   * Emit error event only when somebody listens, an unhandled 'error' event
   * would otherwise crash the process.
   * @private
   */
  this._emitError = function (err) {
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    }
  };


  //<editor-fold defaultstate="collapsed" desc="Events">

  /**
   *  Add middle-ware for specific command
   *  @param {('connect'|'disconnect'|'send'|'subscribe'|'unsubscribe')} command Command to hook
   *  @param {function} handler function to add in middle-ware
   * */
  this.addMiddleware = function (command, handler) {
    command = command.toLowerCase();
    if (! this.middleware[command] ) {
      this.middleware[command] = [];
    }
    this.middleware[command].push(handler);
  };

  /**
   *  Clear and set middle-ware for specific command
   *  @param {('connect'|'disconnect'|'send'|'subscribe'|'unsubscribe')} command Command to hook
   *  @param {function} handler function to add in middle-ware
   * */
  this.setMiddleware = function (command, handler) {
    command = command.toLowerCase();
    this.middleware[command] = [handler];
  };

  /**
   *  Remove middle-ware specific for command
   *  @param {('connect'|'disconnect'|'send'|'subscribe'|'unsubscribe')} command Command with hook
   *  @param {function} handler function to remove from middle-ware
   * */
  this.removeMiddleware = function (command, handler) {
    var handlers = this.middleware[command.toLowerCase()] || [];
    var idx = handlers.indexOf(handler);
    if (idx >= 0) {
      handlers.splice(idx, 1);
    }
  };


  /**
   * Wrap command handler with middle-ware chain. Middle-ware is called with
   * (socket, args, next) and must return result of next() to continue, or a
   * falsy value to reject the command. It may also return a Promise.
   */
  function withMiddleware(command, finalHandler) {
    return function(socket, args) {
      var handlers = (this.middleware[command.toLowerCase()] || []).slice();
      var iter = handlers[Symbol.iterator]();
      var self = this;
      var finalArgs = arguments;

      function callNext() {
        var iteration = iter.next();
        if (iteration.done) {
          return finalHandler.apply(self, finalArgs);
        }
        return iteration.value(socket, args, callNext);
      }
      return callNext();
    };
  }

  /** Headers controlled by the broker, never copied from a SEND frame */
  var RESERVED_HEADERS = ['destination', 'subscription', 'message-id', 'receipt',
    'content-length', 'bytes_message', 'transaction'];


  /**
   * Client connected event, emitted after connection established and negotiated
   *
   * @event StompServer#connected
   * @type {object}
   * @property {string} sessionId
   * @property {object} headers
   */
  this.onClientConnected = withMiddleware('connect', function (socket, args) {
    socket.clientHeartbeat = {
      client: args.heartbeat[0],
      server: args.heartbeat[1]
    };
    this.conf.debug('CONNECT', socket.sessionId, socket.clientHeartbeat, args.headers);
    this.emit('connected', socket.sessionId, args.headers);
    return true;
  });

  /**
   * Client disconnected event
   *
   * @event StompServer#disconnected
   * @type {object}
   * @property {string} sessionId
   * */
  this.onDisconnect = withMiddleware('disconnect', function (socket /*, receiptId*/) {
    // TODO: Do we need to do anything with receiptId on disconnect?
    this.afterConnectionClose(socket);
    this.conf.debug('DISCONNECT', socket.sessionId);
    this.emit('disconnected', socket.sessionId);
    return true;
  });


  /**
   * Event emitted when broker send message to subscribers
   *
   * @event StompServer#send
   * @type {object}
   * @property {string} dest Destination
   * @property {string} frame Message frame
   */
  this.onSend = withMiddleware('send', function (socket, args, callback) {
    if (typeof args.dest !== 'string' || args.dest === '') {
      throw new Error('Message destination is required');
    }
    var bodyObj = args.frame.body;
    var frame = this.frameSerializer(args.frame);

    if (frame.body !== undefined && frame.body !== null &&
        typeof frame.body !== 'string' && !Buffer.isBuffer(frame.body)) {
      throw new Error('Message body is not string or Buffer');
    }

    var headers = {};
    var srcHeaders = frame.headers || {};
    for (var key in srcHeaders) {
      if (RESERVED_HEADERS.indexOf(key) < 0) {
        headers[key] = srcHeaders[key];
      }
    }
    headers.destination = args.dest;
    headers['message-id'] = stompUtils.genId('msg');
    if (frame.body !== undefined && frame.body !== null) {
      headers['content-length'] = Buffer.byteLength(frame.body);
    }

    frame.headers = headers;
    args.frame = frame;
    this.emit('send', {
      frame: {
        headers: headers,
        body: bodyObj
      },
      dest: args.dest
    });

    this._sendToSubscriptions(socket, args, bodyObj);

    if (callback) {
      callback(true);
    }
    return true;
  });


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
  this.onSubscribe = withMiddleware('subscribe', function (socket, args) {
    var sub = {
      id: args.id,
      sessionId: socket.sessionId,
      topic: args.dest,
      tokens: stompUtils.tokenizeDestination(args.dest),
      socket: socket
    };
    this.subscribes.push(sub);
    this.emit('subscribe', sub);
    this.conf.debug('Server subscribe', args.id, args.dest);
    return true;
  });


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
  this.onUnsubscribe = withMiddleware('unsubscribe', function (socket, subId) {
    for (var i = 0; i < this.subscribes.length; i++) {
      var sub = this.subscribes[i];
      if (sub.id === subId && sub.sessionId === socket.sessionId) {
        this.subscribes.splice(i--, 1);
        this.emit('unsubscribe', sub);
        return true;
      }
    }
    return false;
  });

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
    if (typeof topic !== 'string' || topic === '') {
      throw new Error('Subscription destination is required');
    }
    var id;
    if (!headers || !headers.id) {
      id = 'self_' + Math.floor(Math.random() * 99999999999);
    } else {
      id = headers.id;
    }
    var sub = {
      topic: topic,
      tokens: stompUtils.tokenizeDestination(topic),
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
   * @param {*} [bodyObj] parsed body passed to server-side subscribers
   * @private
   */
  this._sendToSubscriptions = function (socket, args, bodyObj) {
    if (bodyObj === undefined) {
      bodyObj = args.frame.body;
    }
    var destTokens = stompUtils.tokenizeDestination(args.dest);
    // copy, callbacks may (un)subscribe while we iterate
    var subscribes = this.subscribes.slice();
    for (var i = 0; i < subscribes.length; i++) {
      var sub = subscribes[i];
      if (socket.sessionId === sub.sessionId) {
        continue;
      }
      if (this._matchTokens(sub.tokens, destTokens)) {
        var headers = Object.assign({}, args.frame.headers, {subscription: sub.id});
        var sock = sub.socket;
        if (sock !== undefined) {
          stompUtils.sendFrame(sock, {
            command: 'MESSAGE',
            headers: headers,
            body: args.frame.body
          });
        } else {
          this.emit(sub.id, bodyObj, headers);
        }
      }
    }
  };


  /** Send message to topic
   *
   * @param {string} topic Destination for message
   * @param {Object.<string, string>} headers Message headers
   * @param {string} body Message body
   */
  this.send = function (topic, headers, body) {
    if (typeof topic !== 'string' || topic === '') {
      throw new Error('Message destination is required');
    }
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
  }.bind(this);

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
    if (typeof frame.body === 'string' && frame.headers['content-type'] === 'application/json') {
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
      if (socket.heartbeatClock !== undefined) {
        clearInterval(socket.heartbeatClock);
      }
      socket.heartbeatClock = setInterval(function() {
        if (socket.readyState === undefined || socket.readyState === 1) {
          self.conf.debug('PING');
          socket.send(BYTES.LF);
        }
      }, interval);

    } else {
      // Client takes responsibility for sending pings
      // Server should close connection on timeout
      if (socket.heartbeatCheckClock !== undefined) {
        clearInterval(socket.heartbeatCheckClock);
      }
      socket.heartbeatTime = Date.now();
      socket.heartbeatCheckClock = setInterval(function() {
        var diff = Date.now() - socket.heartbeatTime;
        if (diff > interval + self.conf.heartbeatErrorMargin) {
          self.conf.debug('HEALTH CHECK failed! Closing', diff, interval);
          self.heartbeatOff(socket);
          socket.close();
        } else {
          self.conf.debug('HEALTH CHECK ok!', diff, interval);
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
    if (socket.heartbeatClock !== undefined) {
      clearInterval(socket.heartbeatClock);
      delete socket.heartbeatClock;
    }
    if (socket.heartbeatCheckClock !== undefined) {
      clearInterval(socket.heartbeatCheckClock);
      delete socket.heartbeatCheckClock;
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
    return this._matchTokens(sub.tokens, stompUtils.tokenizeDestination(args.dest));
  };


  /**
   * Match tokenized subscription pattern against tokenized destination.
   * `*` matches exactly one name, `**` matches all remaining names.
   *
   * @param {string[]} pattern subscription tokens
   * @param {string[]} tokens destination tokens
   * @returns {boolean} true if pattern matches destination
   * @private
   */
  this._matchTokens = function (pattern, tokens) {
    for (var i = 0; i < pattern.length; i++) {
      if (pattern[i] === '**') {
        return true;
      }
      if (i >= tokens.length || (pattern[i] !== '*' && pattern[i] !== tokens[i])) {
        return false;
      }
    }
    return pattern.length === tokens.length;
  };


  /**
   * After connection close
   *
   * @param socket WebSocket connection that has been closed and is dying
   */
  this.afterConnectionClose = function (socket) {
    // remove from subscribes
    for (var i = 0; i < this.subscribes.length; i++) {
      var sub = this.subscribes[i];
      if (sub.sessionId === socket.sessionId) {
        this.subscribes.splice(i--, 1);
      }
    }

    // turn off server side heart-beat (if needed)
    this.heartbeatOff(socket);
  };


  /** Commands accepted before the session is connected */
  var CONNECT_COMMANDS = ['CONNECT', 'STOMP'];
  var CLIENT_COMMANDS = CONNECT_COMMANDS.concat(['DISCONNECT', 'SUBSCRIBE', 'UNSUBSCRIBE', 'SEND']);

  this.parseRequest = function(socket, data) {
    // any incoming data counts as a heart-beat
    socket.heartbeatTime = Date.now();

    // if it's ping then ignore
    if (stompUtils.isHeartbeat(data)) {
      this.conf.debug('PONG');
      return;
    }

    var frame;
    try {
      frame = stompUtils.parseFrame(data, socket.stompVersion);
      if (frame === null) {
        return;
      }
      if (CLIENT_COMMANDS.indexOf(frame.command) < 0) {
        return 'Command not found';
      }
      if (!socket.stompConnected && CONNECT_COMMANDS.indexOf(frame.command) < 0) {
        stomp.fail(socket, 'Not connected', 'CONNECT frame is required before ' + frame.command);
        return;
      }
      frame = this.frameParser(frame);
      return this.frameHandler[frame.command](socket, frame);
    } catch (err) {
      this.conf.debug('Frame processing error', socket.sessionId, err);
      var receipt = frame && frame.headers ? frame.headers.receipt : undefined;
      try {
        stomp.fail(socket, 'Frame processing error', err && err.message ? err.message : err, receipt);
      } catch (sendErr) {
        this.conf.debug('Cannot send ERROR frame', sendErr);
      }
    }
  };

};

util.inherits(StompServer, EventEmitter);

// Export
module.exports = StompServer;
