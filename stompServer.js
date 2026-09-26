var EventEmitter    = require('events');
var util            = require('util');

var stomp           = require('./lib/stomp');
var stompUtils      = require('./lib/stomp-utils');
var FrameDecoder    = require('./lib/parser').FrameDecoder;
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
    ws.decoder = new FrameDecoder();

    this.emit('connecting', ws.sessionId);
    this.conf.debug('Connect', ws.sessionId);

    ws.on('message', this.parseRequest.bind(this, ws));
    ws.on('close', function () {
      ws.stompClosed = true;
      // DISCONNECT frame may already have handled the graceful disconnect
      if (!ws.stompDisconnected) {
        stomp.whenDone(function () {
          return this.onDisconnect(ws);
        }.bind(this), function () {}, this._emitError.bind(this));
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
      var handlers = this.middleware[command.toLowerCase()];
      if (!handlers || handlers.length === 0) {
        return finalHandler.call(this, socket, args);
      }
      // snapshot, handlers may change middle-ware while the chain runs
      handlers = handlers.slice();
      var self = this;
      var i = 0;

      function callNext() {
        if (i < handlers.length) {
          return handlers[i++](socket, args, callNext);
        }
        return finalHandler.call(self, socket, args);
      }
      return callNext();
    };
  }

  /** Headers controlled by the broker, never copied from a SEND frame */
  var RESERVED_HEADERS = ['destination', 'subscription', 'message-id', 'receipt',
    'content-length', 'transaction'];

  /** True for an application/json media type, parameters (e.g. charset) ignored */
  function isJson(contentType) {
    return typeof contentType === 'string' &&
      contentType.split(';')[0].trim().toLowerCase() === 'application/json';
  }


  /**
   * Client connected event, emitted after connection established and negotiated
   *
   * @event StompServer#connected
   * @type {object}
   * @property {string} sessionId
   * @property {object} headers
   */
  this.onClientConnected = withMiddleware('connect', function (socket, args) {
    if (socket.stompClosed) {
      return false;
    }
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
    // DISCONNECT frame and socket close may both get here, emit only once
    if (socket.stompDisconnected) {
      return true;
    }
    socket.stompDisconnected = true;
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
  this.onSend = withMiddleware('send', function (socket, args) {
    var destTokens = stompUtils.tokenizeDestination(args.dest);
    var originalBody = args.frame.body;
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

    // body for in-process consumers: the object given to send(), or the
    // decoded JSON text; computed only when somebody needs it
    var self = this;
    var decoded;
    var isDecoded = false;
    function bodyObj() {
      if (!isDecoded) {
        decoded = originalBody !== frame.body ? originalBody : self._decodeBody(headers, frame.body);
        isDecoded = true;
      }
      return decoded;
    }

    if (this.listenerCount('send') > 0) {
      this.emit('send', {
        frame: {
          headers: headers,
          body: bodyObj()
        },
        dest: args.dest
      });
    }

    this._sendToSubscriptions(socket, args, bodyObj, destTokens);
    return true;
  });


  /**
   * Decode a JSON body for server-side consumers. Invalid JSON is passed on
   * as text: it is the sender's data, not a broker failure.
   * @private
   */
  this._decodeBody = function (headers, body) {
    if (typeof body !== 'string' || !isJson(headers['content-type'])) {
      return body;
    }
    try {
      return JSON.parse(body);
    } catch (err) {
      this.conf.debug('Invalid JSON body', headers.destination, err.message);
      return body;
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
        this.subscribes.splice(i, 1);
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
   * @param {function(): *} bodyObj returns the body passed to server-side subscribers
   * @param {string[]} destTokens tokenized destination
   * @private
   */
  this._sendToSubscriptions = function (socket, args, bodyObj, destTokens) {
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
          this.emit(sub.id, bodyObj(), headers);
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
      frame: frame
    };
    this.onSend(selfSocket, args);
  }.bind(this);

  //</editor-fold>


  //<editor-fold defaultstate="collapsed" desc="Frames">

  /**
   * Serialize an object body of an application/json message to JSON text.
   * String and Buffer bodies are sent as they are.
   *
   * @param {MsgFrame} frame Message frame
   * @return {MsgFrame} modified frame
   * */
  this.frameSerializer = function (frame) {
    var body = frame.body;
    if (body !== undefined && body !== null && typeof body !== 'string' && !Buffer.isBuffer(body) &&
        isJson(frame.headers['content-type'])) {
      frame.body = JSON.stringify(body);
    }
    return frame;
  };


  /**
   * Parse the text body of an application/json frame to an object.
   *
   * @deprecated no longer applied to incoming frames: bodies are relayed as
   *   received and decoded only for server-side subscribers
   * @param {MsgFrame} frame Message frame
   * @return {MsgFrame} modified frame
   * */
  this.frameParser = function (frame) {
    if (typeof frame.body === 'string' && isJson(frame.headers['content-type'])) {
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
      clearClock(socket, 'heartbeatClock');
      socket.heartbeatClock = setInterval(function() {
        if (stompUtils.isOpen(socket)) {
          self.conf.debug('PING');
          socket.send(BYTES.LF);
        }
      }, interval);

    } else {
      // Client takes responsibility for sending pings
      // Server should close connection on timeout
      clearClock(socket, 'heartbeatCheckClock');
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
    clearClock(socket, 'heartbeatClock');
    clearClock(socket, 'heartbeatCheckClock');
  };

  function clearClock(socket, key) {
    if (socket[key] !== undefined) {
      clearInterval(socket[key]);
      delete socket[key];
    }
  }

  //</editor-fold>


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


  /**
   * Dispatch one frame to its command handler
   * @private
   */
  this._handleFrame = function (socket, frame) {
    if (!Object.prototype.hasOwnProperty.call(this.frameHandler, frame.command)) {
      this.conf.debug('Command not found', socket.sessionId, frame.command);
      return;
    }
    if (!socket.stompConnected && CONNECT_COMMANDS.indexOf(frame.command) < 0) {
      stomp.fail(socket, 'Not connected', 'CONNECT frame is required before ' + frame.command);
      return;
    }
    this.frameHandler[frame.command](socket, frame);
  };


  /** Commands accepted before the session is connected */
  var CONNECT_COMMANDS = ['CONNECT', 'STOMP'];

  /**
   * Handle data received on a socket: decode every complete frame in it and
   * dispatch them in order. Incomplete frames wait for the next data.
   *
   * @param {WebSocket} socket Source socket
   * @param {string|Buffer} data Text or binary message
   */
  this.parseRequest = function(socket, data) {
    // any incoming data counts as a heart-beat
    socket.heartbeatTime = Date.now();
    if (socket.decoder === undefined) {
      socket.decoder = new FrameDecoder();
    }

    var frame = null;
    try {
      socket.decoder.push(data);
      // stop when a frame closed the connection (ERROR, rejected CONNECT)
      while (!socket.stompClosed && stompUtils.isOpen(socket)) {
        frame = null;
        frame = socket.decoder.shift(socket.stompVersion);
        if (frame === null) {
          break;
        }
        this._handleFrame(socket, frame);
      }
    } catch (err) {
      this.conf.debug('Frame processing error', socket.sessionId, err);
      var receipt = frame && frame.headers ? frame.headers.receipt : undefined;
      stomp.fail(socket, 'Frame processing error', stomp.errorText(err), receipt);
    }
  };

};

util.inherits(StompServer, EventEmitter);

// Export
module.exports = StompServer;
