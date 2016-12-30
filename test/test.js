var http = require("http");
var StompServer = require('../stompServer');


var server = http.createServer();
var stompServer = new StompServer({server: server});

server.listen(61614);

module.exports = stompServer;

stompServer.subscribe("/test");

stompServer.on('/test', function(msg) {
  console.log("MSG: ", msg);
});