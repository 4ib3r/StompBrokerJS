const VERSION = require('../package.json').version;
const transports = require('./transport');

/**
 * Resource limits; each can be raised, or disabled with Infinity.
 * Sizes are bytes, times milliseconds.
 */
const DEFAULT_LIMITS = {
    maxFrameSize: 1024 * 1024,
    maxHeaders: 64,
    maxHeaderLength: 8 * 1024,
    maxSubscriptions: 256,
    maxBufferedAmount: 8 * 1024 * 1024,
    connectTimeout: 10000,
    maxTransactions: 16,
    maxTransactionBytes: 4 * 1024 * 1024,
    maxPendingFrames: 32
};

const SLOW_CONSUMER_POLICIES = ['drop', 'close'];

function buildLimits(limits) {
    var result = Object.assign({}, DEFAULT_LIMITS);
    Object.keys(limits || {}).forEach(function (key) {
        if (!Object.prototype.hasOwnProperty.call(DEFAULT_LIMITS, key)) {
            throw new Error('Unknown limit "' + key + '", supported: ' + Object.keys(DEFAULT_LIMITS).join(', '));
        }
        var value = limits[key];
        if (value !== Infinity && !(Number.isInteger(value) && value > 0)) {
            throw new Error('Limit "' + key + '" must be a positive integer or Infinity');
        }
        result[key] = value;
    });
    return result;
}

/**
 * Transport from the `protocol` and `transport` options: the name of a
 * built-in transport, or 'custom' with the Transport object.
 */
function resolveTransport(config) {
    var protocol = config.protocol;
    var transport = config.transport;
    if (transport !== undefined && typeof transport !== 'string') {
        transports.checkTransport(transport);
        if (protocol !== undefined) {
            throw new Error('Set either protocol or a custom transport, not both');
        }
        return {protocol: 'custom', transport: transport};
    }
    if (transport !== undefined && protocol !== undefined && transport !== protocol) {
        throw new Error('Conflicting protocol "' + protocol + '" and transport "' + transport + '"');
    }
    protocol = transport || protocol || 'ws';
    if (!transports.isBuiltIn(protocol)) {
        throw new Error('Unknown protocol "' + protocol + '", supported: ' + transports.NAMES.join(', ') +
            ' or a custom transport object');
    }
    return {protocol: protocol, transport: undefined};
}

function buildConfig(config) {
    var protocolConfig = config.protocolConfig || {};
    var transport = resolveTransport(config);
    var conf = {
        server: config.server,
        serverName: config.serverName || 'STOMP-JS/' + VERSION,
        path: config.path || "/stomp",
        heartbeat: config.heartbeat || [0, 0],
        heartbeatErrorMargin: config.heartbeatErrorMargin !== undefined ? config.heartbeatErrorMargin : 1000,
        debug: config.debug || function () {},
        protocol: transport.protocol,
        protocolConfig: protocolConfig,
        transport: transport.transport,
        limits: buildLimits(config.limits),
        slowConsumerPolicy: config.slowConsumerPolicy || 'drop',
        authenticate: config.authenticate,
        authorize: config.authorize,
        allowWildcardSubscriptions: config.allowWildcardSubscriptions !== undefined ?
            config.allowWildcardSubscriptions : true
    };

    ['authenticate', 'authorize'].forEach(function (hook) {
        if (conf[hook] !== undefined && typeof conf[hook] !== 'function') {
            throw new Error(hook + ' must be a function');
        }
    });
    if (typeof conf.allowWildcardSubscriptions !== 'boolean') {
        throw new Error('allowWildcardSubscriptions must be a boolean');
    }

    if (SLOW_CONSUMER_POLICIES.indexOf(conf.slowConsumerPolicy) < 0) {
        throw new Error('slowConsumerPolicy must be one of: ' + SLOW_CONSUMER_POLICIES.join(', '));
    }

    // `ws` may run without an http server when `noServer` is set (upgrade
    // handled by the user); a custom transport brings its own
    var noServer = (conf.protocol === 'ws' && protocolConfig.noServer === true) || conf.protocol === 'custom';
    if (conf.server === undefined && !noServer) {
        throw new Error('Server is required (or set protocolConfig.noServer for the ws protocol)');
    }
    return conf;
}

buildConfig.DEFAULT_LIMITS = DEFAULT_LIMITS;

module.exports = buildConfig;
