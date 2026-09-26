const VERSION = require('../package.json').version;
const protocolAdapter = require('./adapter');

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
    connectTimeout: 10000
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

function buildConfig(config) {
    var protocolConfig = config.protocolConfig || {};
    var conf = {
        server: config.server,
        serverName: config.serverName || 'STOMP-JS/' + VERSION,
        path: config.path || "/stomp",
        heartbeat: config.heartbeat || [0, 0],
        heartbeatErrorMargin: config.heartbeatErrorMargin !== undefined ? config.heartbeatErrorMargin : 1000,
        debug: config.debug || function () {},
        protocol: config.protocol || 'ws',
        protocolConfig: protocolConfig,
        limits: buildLimits(config.limits),
        slowConsumerPolicy: config.slowConsumerPolicy || 'drop'
    };

    if (SLOW_CONSUMER_POLICIES.indexOf(conf.slowConsumerPolicy) < 0) {
        throw new Error('slowConsumerPolicy must be one of: ' + SLOW_CONSUMER_POLICIES.join(', '));
    }

    if (!Object.prototype.hasOwnProperty.call(protocolAdapter, conf.protocol)) {
        throw new Error('Unknown protocol "' + conf.protocol + '", supported: ' +
            Object.keys(protocolAdapter).join(', '));
    }

    // `ws` may run without an http server when `noServer` is set (upgrade handled by the user)
    var noServer = conf.protocol === 'ws' && protocolConfig.noServer === true;
    if (conf.server === undefined && !noServer) {
        throw new Error('Server is required (or set protocolConfig.noServer for the ws protocol)');
    }
    return conf;
}

buildConfig.DEFAULT_LIMITS = DEFAULT_LIMITS;

module.exports = buildConfig;
