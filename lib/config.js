const VERSION = require('../package.json').version;

module.exports = function buildConfig(config) {
    var conf = {
        server: config.server,
        serverName: config.serverName || 'STOMP-JS/' + VERSION,
        path: config.path || "/stomp",
        heartbeat: config.heartbeat || [0, 0],
        heartbeatErrorMargin: config.heartbeatErrorMargin || 1000,
        debug: config.debug || function () {},
        protocol: config.protocol || 'ws'
    };

    if (conf.server === undefined) {
        throw "Server is required";
    }
    return conf;
};
