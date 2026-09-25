const VERSION = require('../package.json').version;
const protocolAdapter = require('./adapter');

module.exports = function buildConfig(config) {
    var protocolConfig = config.protocolConfig || {};
    var conf = {
        server: config.server,
        serverName: config.serverName || 'STOMP-JS/' + VERSION,
        path: config.path || "/stomp",
        heartbeat: config.heartbeat || [0, 0],
        heartbeatErrorMargin: config.heartbeatErrorMargin !== undefined ? config.heartbeatErrorMargin : 1000,
        debug: config.debug || function () {},
        protocol: config.protocol || 'ws',
        protocolConfig: protocolConfig
    };

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
};
