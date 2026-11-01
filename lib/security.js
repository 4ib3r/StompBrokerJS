var stomp = require('./stomp');
var stompUtils = require('./stomp-utils');
var StompError = require('./errors').StompError;

/**
 * The security hooks of a server (authenticate, authorize,
 * allowWildcardSubscriptions) applied to client commands.
 *
 * @param {object} conf resolved configuration, see lib/config.js
 */
function Security(conf) {
  this.conf = conf;
}

/**
 * Run the authenticate hook for a CONNECT frame and store the principal on
 * the session. Rejection (falsy principal) throws a StompError.
 *
 * @return {Promise|undefined} a Promise when the hook is asynchronous
 */
Security.prototype.authenticate = function (session, headers) {
  var conf = this.conf;
  if (conf.authenticate === undefined) {
    return;
  }
  return stomp.andThen(conf.authenticate({
    login: headers.login,
    passcode: headers.passcode,
    headers: headers,
    sessionId: session.sessionId,
    request: session.request
  }), function (principal) {
    // the connection closed while the (async) hook was deciding
    if (!session.isOpen()) {
      return;
    }
    if (!principal) {
      // never the passcode
      conf.debug('Authentication failed', session.sessionId, headers.login);
      throw new StompError('Authentication failed');
    }
    session._principal = principal;
  });
};

/**
 * Run the authorize hook for a client SUBSCRIBE or SEND; anything but
 * `true` throws StompError('Access denied'). Server-side send() and
 * subscribe() are trusted and not authorized.
 *
 * @param {Session} session
 * @param {('subscribe'|'send')} action
 * @param {string} destination
 * @return {Promise|undefined} a Promise when the hook is asynchronous
 */
Security.prototype.authorize = function (session, action, destination) {
  var conf = this.conf;
  if (conf.authorize === undefined) {
    return;
  }
  // the hook only sees well-formed destinations
  stompUtils.tokenizeDestination(destination);
  return stomp.andThen(conf.authorize(session.principal, action, destination, session), function (allowed) {
    if (allowed !== true) {
      conf.debug('Access denied', session.sessionId, action, destination);
      throw new StompError('Access denied');
    }
  });
};

/**
 * StompError for a client subscription with a wildcard when
 * allowWildcardSubscriptions is false
 */
Security.prototype.checkWildcards = function (destination) {
  if (this.conf.allowWildcardSubscriptions) {
    return;
  }
  var wildcard = stompUtils.tokenizeDestination(destination).some(function (token) {
    return token === '*' || token === '**';
  });
  if (wildcard) {
    throw new StompError('Wildcard subscriptions are not allowed');
  }
};

module.exports = Security;
