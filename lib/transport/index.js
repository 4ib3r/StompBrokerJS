/**
 * Built-in transports, by `protocol` name. Each is loaded when it is used,
 * so that the optional `sockjs` package is required only for SockJS.
 */
var BUILT_IN = {
  ws: function () {
    return require('./ws');
  },
  sockjs: function () {
    return require('./sockjs');
  }
};

/** Names of the built-in transports */
var NAMES = Object.keys(BUILT_IN);

/** Methods a custom transport must have */
var TRANSPORT_METHODS = ['onConnection', 'close'];

function isBuiltIn(name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(BUILT_IN, name);
}

/** Error when `transport` is not a usable custom transport object */
function checkTransport(transport) {
  var missing = TRANSPORT_METHODS.filter(function (method) {
    return !transport || typeof transport[method] !== 'function';
  });
  if (missing.length > 0) {
    throw new Error('A custom transport must implement ' + TRANSPORT_METHODS.join(', ') +
      ' (missing: ' + missing.join(', ') + ')');
  }
}

/**
 * Create a built-in transport.
 *
 * @param {string} name 'ws' or 'sockjs'
 * @param {object} options transport options (server, path, ...)
 */
function create(name, options) {
  var Transport = BUILT_IN[name]();
  return new Transport(options);
}

module.exports = {
  NAMES: NAMES,
  isBuiltIn: isBuiltIn,
  checkTransport: checkTransport,
  create: create,
  MemoryTransport: require('./memory')
};
