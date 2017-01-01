# StompBrokerJS
NodeJS StompBroker

###Changelog
*0.1.1 Added wildcards to destination, change subscribe method [no backward compatibility]

This is simple NodeJs STOMP 1.1 broker for embeded usage.
```javascript
var http = require("http");
var StompServer = require('stompServer');

var server = http.createServer();
var stompServer = new StompServer({server: server});

server.listen(61614);

stompServer.subscribe("/**", function(msg, headers) {
  var topic = headers.destination;
  console.log(topic, "->", msg);
});

stompServer.send('/test', {}, 'testMsg');
```
