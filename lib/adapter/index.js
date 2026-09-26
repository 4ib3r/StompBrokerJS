var WebSocketServer = require('ws').Server;
var sockjs = require('sockjs');

/**
 * Instantiating WebSocketServer by default
 * other options provide adapters
 */
module.exports = {
    ws: WebSocketServer,
    sockjs: SockJsAdapter
};

function SockJsAdapter(config) {
    var opts = Object.assign({}, config, {
        sockjs_url: "https://cdn.jsdelivr.net/sockjs/1.0.1/sockjs.min.js",
        prefix: config.path || '/ws'
    });
    var sockjsServer = sockjs.createServer(opts);

    sockjsServer.installHandlers(opts.server, {
        prefix: opts.prefix
    });

    return {
        on: function (event, onConnection) {
            if (event === 'connection') {
                sockjsServer.on('connection', function (conn) {
                    var websocketConnectionWrapper = {
                        get readyState() {
                            return conn.readyState;
                        },
                        on: function (connEvent, eventHandler) {
                            switch (connEvent) {
                                case 'message':
                                    conn.on('data', eventHandler);
                                    break;
                                default:
                                    conn.on(connEvent, eventHandler);
                            }
                        },
                        send: function (data /*, options*/) {
                            return conn.write(data);
                        },
                        close: function () {
                            conn.close.call(conn);
                            conn.end.call(conn);
                        }
                    };

                    onConnection(websocketConnectionWrapper);
                });
            } else throw new Error('No such event on sockjs adapter: ' + event);

        }
    };
}
