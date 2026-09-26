var stompUtils = require('./stomp-utils');

/**
 * States of a session:
 * OPEN (transport connected, no CONNECT yet) → CONNECTED → DISCONNECTING
 * (DISCONNECT received) → CLOSED (transport closed). CLOSED can follow any
 * state.
 */
var STATE = Object.freeze({
  OPEN: 'OPEN',
  CONNECTED: 'CONNECTED',
  DISCONNECTING: 'DISCONNECTING',
  CLOSED: 'CLOSED'
});

/**
 * One client connection: the transport connection and everything the broker
 * keeps per client (protocol state, frame decoder, transactions, timers).
 *
 * @param {object} connection transport connection (send, close, readyState, bufferedAmount)
 * @param {object} options
 * @param {string} options.id session id
 * @param {FrameDecoder} options.decoder
 * @param {Transactions} options.transactions
 */
function Session(connection, options) {
  this.connection = connection;
  this.sessionId = options.id;
  this.state = STATE.OPEN;
  /** negotiated STOMP version, set by CONNECT */
  this.version = undefined;
  this.decoder = options.decoder;
  this.transactions = options.transactions;
  /** time data was last received, for heart-beat checks */
  this.lastReceived = Date.now();
  /** the disconnect handling (event, cleanup) ran */
  this.disconnected = false;
  this.connectTimer = undefined;
  this.heartbeatTimers = [];
}

Session.STATE = STATE;

/** Transport ready state, sessions of transports without one count as open */
Object.defineProperty(Session.prototype, 'readyState', {
  get: function () {
    return this.connection.readyState;
  }
});

/** Bytes queued on the transport connection */
Object.defineProperty(Session.prototype, 'bufferedAmount', {
  get: function () {
    return this.connection.bufferedAmount || 0;
  }
});

/** Negotiated STOMP version (name used by frame serialization) */
Object.defineProperty(Session.prototype, 'stompVersion', {
  get: function () {
    return this.version;
  }
});

Session.prototype.isOpen = function () {
  return this.state !== STATE.CLOSED && stompUtils.isOpen(this.connection);
};

/** True while commands of the session may still take effect */
Session.prototype.isActive = function () {
  return (this.state === STATE.OPEN || this.state === STATE.CONNECTED) && stompUtils.isOpen(this.connection);
};

Session.prototype.isConnected = function () {
  return this.state === STATE.CONNECTED;
};

/** Write serialized data, dropped when the connection is closing or closed */
Session.prototype.send = function (data) {
  if (this.isOpen()) {
    this.connection.send(data);
  }
};

Session.prototype.close = function () {
  this.connection.close();
};

/** The session ended (DISCONNECT or transport closed): stop timers, drop open transactions */
Session.prototype.cleanup = function () {
  clearTimeout(this.connectTimer);
  this.stopHeartbeats();
  this.transactions.clear();
};

Session.prototype.stopHeartbeats = function () {
  this.heartbeatTimers.forEach(clearInterval);
  this.heartbeatTimers = [];
};

/**
 * Start heart-beats in both directions; 0 disables a direction.
 *
 * @param {number} outgoing ms between server heart-beats
 * @param {number} incoming ms the client promised to send data within
 * @param {number} errorMargin ms of tolerance for late client heart-beats
 * @param {function} onTimeout called when the client missed its heart-beat
 */
Session.prototype.startHeartbeats = function (outgoing, incoming, errorMargin, onTimeout) {
  var session = this;
  this.stopHeartbeats();
  if (outgoing > 0) {
    this.heartbeatTimers.push(setInterval(function () {
      session.send('\n');
    }, outgoing));
  }
  if (incoming > 0) {
    this.lastReceived = Date.now();
    this.heartbeatTimers.push(setInterval(function () {
      var silence = Date.now() - session.lastReceived;
      if (silence > incoming + errorMargin) {
        session.stopHeartbeats();
        onTimeout(silence, incoming);
      }
    }, incoming));
  }
};

module.exports = Session;
