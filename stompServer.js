var EventEmitter    = require('events');
var util            = require('util');

var stomp           = require('./lib/stomp');
var stompUtils      = require('./lib/stomp-utils');
var FrameDecoder    = require('./lib/parser').FrameDecoder;
var Frame           = require('./lib/frame');
var StompError      = require('./lib/errors').StompError;
var Transactions    = require('./lib/transactions');
var Session         = require('./lib/session');
var SubscriptionRegistry = require('./lib/subscription-registry');

var protocolAdapter = require('./lib/adapter');
var buildConfig     = require('./lib/config');

/**
 * STOMP Server configuration
 *
 * @typedef {object} ServerConfig
 * @param {http.Server} server Http server reference
 * @param {string} [serverName=STOMP-JS/VERSION] Name of STOMP server
 * @param {string} [path=/stomp] WebSocket path
 * @param {array} [heartbeat=[0, 0]] Heartbeat; read documentation to config according to your desire
 * @param {number} [heartbeatErrorMargin=1000] Heartbeat error margin; specify how strict server should be
 * @param {function} [debug=function(args) {}] Debug function
 * @param {object} [limits] Resource limits, see README "Limits"
 * @param {('drop'|'close')} [slowConsumerPolicy=drop] What to do with messages for a client whose
 *   connection has more than limits.maxBufferedAmount bytes queued
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

  this._registry = new SubscriptionRegistry();
  /** sessions of open connections, by id */
  this._sessions = new Map();
  this.middleware = {};
  this.frameHandler = new stomp.FrameHandler(this);

  var limits = this.conf.limits;
  var transportDefaults = this.conf.protocol === 'ws' ? {
    perMessageDeflate: false,
    maxPayload: limits.maxFrameSize === Infinity ? undefined : limits.maxFrameSize
  } : {};
  // user options win over broker defaults
  this.socket = new protocolAdapter[this.conf.protocol](Object.assign(transportDefaults, this.conf.protocolConfig, {
    server: this.conf.server,
    path: this.conf.path
  }));
  /**
   * Client connecting event, emitted after socket is opened.
   *
   * @event StompServer#connecting
   * @type {object}
   * @property {string} sessionId
   */
  this.socket.on('connection', function (ws) {
    var session = this._createSession(ws);
    this._sessions.set(session.sessionId, session);
    if (limits.connectTimeout !== Infinity) {
      session.connectTimer = setTimeout(function () {
        if (session.state === Session.STATE.OPEN) {
          this.conf.debug('CONNECT timeout', session.sessionId);
          stomp.fail(session, 'CONNECTION ERROR', 'CONNECT frame not received in time');
        }
      }.bind(this), limits.connectTimeout);
    }

    this.emit('connecting', session.sessionId);
    this.conf.debug('Connect', session.sessionId);

    ws.on('message', this.parseRequest.bind(this, session));
    ws.on('close', function () {
      session.state = Session.STATE.CLOSED;
      this._sessions.delete(session.sessionId);
      // DISCONNECT frame may already have handled the graceful disconnect
      if (!session.disconnected) {
        stomp.whenDone(function () {
          return this.onDisconnect(session);
        }.bind(this), function () {}, this._emitError.bind(this));
      }
      this.afterConnectionClose(session);
    }.bind(this));
    ws.on('error', function (err) {
      this.conf.debug(err);
      this._emitError(err);
    }.bind(this));
  }.bind(this));

  /**
   * All subscriptions (read-only snapshot, in subscription order)
   * @name StompServer#subscribes
   * @type {object[]}
   */
  Object.defineProperty(this, 'subscribes', {
    get: function () {
      return this._registry.all();
    }
  });

  /**
   * Session for a transport connection
   * @private
   */
  this._createSession = function (connection) {
    return new Session(connection, {
      id: stompUtils.genId(),
      decoder: new FrameDecoder({
        maxFrameSize: limits.maxFrameSize,
        maxHeaders: limits.maxHeaders,
        maxHeaderLength: limits.maxHeaderLength
      }),
      transactions: new Transactions(limits.maxTransactions, limits.maxTransactionBytes)
    });
  };

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

  /** Commands middle-ware can be registered for */
  var MIDDLEWARE_COMMANDS = ['connect', 'disconnect', 'send', 'subscribe', 'unsubscribe',
    'begin', 'commit', 'abort', 'ack', 'nack'];

  /** Lower-case command name, TypeError for commands without middle-ware (e.g. typos) */
  function middlewareCommand(command) {
    var name = String(command).toLowerCase();
    if (MIDDLEWARE_COMMANDS.indexOf(name) < 0) {
      throw new TypeError('No middleware for command "' + command + '", supported: ' +
        MIDDLEWARE_COMMANDS.join(', '));
    }
    return name;
  }

  /**
   *  Add middle-ware for specific command
   *  @param {('connect'|'disconnect'|'send'|'subscribe'|'unsubscribe'|'begin'|'commit'|'abort'|'ack'|'nack')} command
   *    Command to hook
   *  @param {function} handler function to add in middle-ware
   * */
  this.addMiddleware = function (command, handler) {
    command = middlewareCommand(command);
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
    command = middlewareCommand(command);
    this.middleware[command] = [handler];
  };

  /**
   *  Remove middle-ware specific for command
   *  @param {('connect'|'disconnect'|'send'|'subscribe'|'unsubscribe')} command Command with hook
   *  @param {function} handler function to remove from middle-ware
   * */
  this.removeMiddleware = function (command, handler) {
    var handlers = this.middleware[middlewareCommand(command)] || [];
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

  /** Copy of CONNECT headers safe to log */
  function redactCredentials(headers) {
    var copy = Object.assign({}, headers);
    if (copy.passcode !== undefined) {
      copy.passcode = '***';
    }
    return copy;
  }

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
    if (socket.state === Session.STATE.CLOSED) {
      return false;
    }
    this.conf.debug('CONNECT', socket.sessionId, args.heartbeat, redactCredentials(args.headers));
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
    if (socket.disconnected) {
      return true;
    }
    socket.disconnected = true;
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
    // a SEND received before the connection ended is still delivered, but
    // not one of a transaction that was aborted when the session ended
    if (args.transaction !== undefined) {
      if (!socket.isActive()) {
        return false;
      }
      // delivered on COMMIT; validate now so that COMMIT can't fail half-way
      stompUtils.tokenizeDestination(args.dest);
      socket.transactions.add(args.transaction, args, args.frame.body);
      return true;
    }
    return this._publish(socket, args);
  });


  /**
   * Deliver a message (SEND frame, server send() or committed transaction) to
   * the matching subscriptions.
   * @private
   */
  this._publish = function (socket, args) {
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
  };


  /** Transaction of an active connection, StompError when it isn't open */
  function openTransaction(socket, id) {
    if (!socket.transactions.has(id)) {
      throw new StompError('Unknown transaction ' + id);
    }
  }

  /** Start a transaction (BEGIN) */
  this.onBegin = withMiddleware('begin', function (socket, args) {
    if (!socket.isActive()) {
      return false;
    }
    socket.transactions.begin(args.transaction);
    return true;
  });

  /** Deliver the messages of a transaction, in order (COMMIT) */
  this.onCommit = withMiddleware('commit', function (socket, args) {
    if (!socket.isActive()) {
      return false;
    }
    var messages = socket.transactions.commit(args.transaction);
    for (var i = 0; i < messages.length; i++) {
      this._publish(socket, messages[i]);
    }
    return true;
  });

  /** Drop the messages of a transaction (ABORT) */
  this.onAbort = withMiddleware('abort', function (socket, args) {
    if (!socket.isActive()) {
      return false;
    }
    socket.transactions.abort(args.transaction);
    return true;
  });

  /**
   * ACK / NACK: the subscription (when given) must belong to the connection,
   * the transaction (when given) must be open. Delivery is at-most-once, so
   * they don't change what is delivered; middle-ware can act on them.
   */
  function acknowledge(socket, args) {
    if (!socket.isActive()) {
      return false;
    }
    if (args.subscription !== undefined && this._registry.get(socket.sessionId, args.subscription) === undefined) {
      throw new StompError('No subscription ' + args.subscription);
    }
    if (args.transaction !== undefined) {
      openTransaction(socket, args.transaction);
    }
    return true;
  }

  this.onAck = withMiddleware('ack', acknowledge);
  this.onNack = withMiddleware('nack', acknowledge);


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
    // the connection may have ended while (async) middle-ware was deciding
    if (!socket.isActive()) {
      return false;
    }
    if (this._registry.get(socket.sessionId, args.id) !== undefined) {
      throw new StompError('Subscription id ' + args.id + ' is already in use');
    }
    if (this._registry.countSession(socket.sessionId) >= this.conf.limits.maxSubscriptions) {
      throw new StompError('Too many subscriptions');
    }
    var sub = {
      id: args.id,
      sessionId: socket.sessionId,
      topic: args.dest,
      tokens: stompUtils.tokenizeDestination(args.dest),
      socket: socket
    };
    this._registry.add(sub);
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
    var sub = this._registry.remove(socket.sessionId, subId);
    if (sub === undefined) {
      return false;
    }
    this.emit('unsubscribe', sub);
    return true;
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
      sessionId: selfSocket.sessionId
    };
    this._registry.add(sub);
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
    // a new array: callbacks may (un)subscribe while we iterate
    var subscribes = this._registry.match(destTokens);
    // serialized once, only the subscription header differs per subscriber
    var message = new Frame.MessageTemplate(args.frame.headers, args.frame.body);
    for (var i = 0; i < subscribes.length; i++) {
      var sub = subscribes[i];
      if (socket.sessionId === sub.sessionId) {
        continue;
      }
      var session = sub.socket;
      if (session === undefined) {
        this.emit(sub.id, bodyObj(), Object.assign({}, args.frame.headers, {subscription: sub.id}));
      } else if (session.isOpen()) {
        if (session.bufferedAmount > this.conf.limits.maxBufferedAmount) {
          this._slowConsumer(session, sub, args.frame.headers);
        } else {
          session.send(message.render(session.version, sub.id));
        }
      }
    }
  };


  /**
   * Slow consumer event: a message was not delivered because the connection of
   * the subscriber has more than limits.maxBufferedAmount bytes queued. With
   * slowConsumerPolicy 'close' the connection is closed as well.
   *
   * @event StompServer#slowConsumer
   * @type {object}
   * @property {string} sessionId
   * @property {string} subscription Subscription id
   * @property {string} destination
   * @property {string} messageId
   * @private
   */
  this._slowConsumer = function (socket, sub, headers) {
    this.conf.debug('Slow consumer', socket.sessionId, socket.bufferedAmount);
    this.emit('slowConsumer', {
      sessionId: socket.sessionId,
      subscription: sub.id,
      destination: headers.destination,
      messageId: headers['message-id']
    });
    if (this.conf.slowConsumerPolicy === 'close') {
      stomp.fail(socket, 'Slow consumer', 'Too much data queued for this connection');
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


  /**
   * The session ended (DISCONNECT or connection closed): drop its
   * subscriptions and transactions, stop its timers.
   *
   * @param {Session} session
   */
  this.afterConnectionClose = function (session) {
    this._registry.removeSession(session.sessionId);
    session.cleanup();
  };


  /**
   * Accept one received frame. Frames after DISCONNECT are ignored, frames
   * before CONNECT rejected; the others are processed in the order they were
   * received, each after the previous one completed (see Session#enqueue).
   * @private
   */
  this._handleFrame = function (socket, frame) {
    if (socket.state === Session.STATE.DISCONNECTING) {
      this.conf.debug('Frame after DISCONNECT ignored', socket.sessionId, frame.command);
      return;
    }
    var known = Object.prototype.hasOwnProperty.call(this.frameHandler, frame.command);
    if (!socket.isConnected() && CONNECT_COMMANDS.indexOf(frame.command) < 0) {
      if (!known) {
        unknownCommand(socket, frame);
      } else {
        stomp.fail(socket, 'Not connected', 'CONNECT frame is required before ' + frame.command);
      }
      return;
    }
    if (frame.command === 'DISCONNECT') {
      // later frames are ignored from now on, also while the frames received
      // before the DISCONNECT are still being processed
      socket.state = Session.STATE.DISCONNECTING;
    }
    var self = this;
    socket.enqueue(function () {
      return self._processFrame(socket, frame, known);
    });
  };

  /**
   * Run the command handler of a frame
   * @return {Promise|undefined} settles when an asynchronous command completed
   * @private
   */
  this._processFrame = function (socket, frame, known) {
    if (!known) {
      unknownCommand(socket, frame);
      return;
    }
    try {
      return this.frameHandler[frame.command](socket, frame);
    } catch (err) {
      this._frameError(socket, frame, err);
    }
  };

  /** ERROR for a command the broker doesn't know, then close */
  function unknownCommand(socket, frame) {
    stomp.fail(socket, 'Unknown command', 'Unknown command ' + frame.command, frame.headers.receipt);
  }

  /**
   * ERROR for a frame that could not be decoded or processed, then close
   * @private
   */
  this._frameError = function (socket, frame, err) {
    this.conf.debug('Frame processing error', socket.sessionId, err);
    if (!(err instanceof StompError)) {
      this._emitError(err);
    }
    var receipt = frame && frame.headers ? frame.headers.receipt : undefined;
    stomp.fail(socket, 'Frame processing error', stomp.clientErrorText(err), receipt);
  };


  /** Commands accepted before the session is connected */
  var CONNECT_COMMANDS = ['CONNECT', 'STOMP'];

  /**
   * Handle data received on a socket: decode every complete frame in it and
   * dispatch them in order. Incomplete frames wait for the next data.
   *
   * @param {Session} socket Source session
   * @param {string|Buffer} data Text or binary message
   */
  this.parseRequest = function(socket, data) {
    // any incoming data counts as a heart-beat
    socket.lastReceived = Date.now();

    var frame = null;
    try {
      socket.decoder.push(data);
      // stop when a frame closed the connection (ERROR, rejected CONNECT)
      while (socket.isOpen()) {
        frame = null;
        frame = socket.decoder.shift(socket.version);
        if (frame === null) {
          break;
        }
        this._handleFrame(socket, frame);
      }
    } catch (err) {
      this._frameError(socket, frame, err);
    }
  };

};

util.inherits(StompServer, EventEmitter);

/** Error whose message is sent to the client, e.g. thrown by middleware to reject a command */
StompServer.StompError = StompError;

// Export
module.exports = StompServer;
