var util = require('util');

/**
 * Error whose message may be sent to the client in an ERROR frame.
 *
 * @param {string} message
 */
function StompError(message) {
  Error.call(this);
  Error.captureStackTrace(this, this.constructor);
  this.name = 'StompError';
  this.message = message;
}
util.inherits(StompError, Error);

/**
 * Malformed data received from a client; the connection must be closed.
 *
 * @param {string} message
 */
function ProtocolError(message) {
  StompError.call(this, message);
  this.name = 'ProtocolError';
}
util.inherits(ProtocolError, StompError);

module.exports = {
  StompError: StompError,
  ProtocolError: ProtocolError
};
