module.exports = function buildConfig(config) {
    var conf = {
        server: config.server,
        serverName: config.serverName || "STOMP-JS/1.1.2",
        path: config.path || "/stomp",
        debug: config.debug || function (args) {},
        protocol: config.protocol || 'ws',
        heartBeatConfig: config.heartBeatConfig || {
            client: 0,
            server: 0
        }
    };

    if (conf.server === undefined) {
        throw "Server is required";
    }
    if (conf.heartBeatConfig.server !== 0) {
        throw "Server side heart beat is not supported!";
    }
    return conf;
};