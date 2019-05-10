# StompBrokerJS
NodeJS StompBroker

This is simple NodeJs STOMP 1.1 broker for embedded usage.

# Features
* Destination wildcards
    * . is used to separate names in a path
    * \* is used to mach any name in a path
    * \*\* is used to recursively match path names

# TODO
* Authorization
* Acknowledgment
* Async send messages
* Transactions
* Composite Destinations
* Message selectors

# Changelog
* 0.1.0 First working version.
* 0.1.1 Added wildcards to destination, change subscribe method [no backward compatibility]
* 0.1.2 Bug fixes, changed websocket library, updated documentation.
* 0.1.3 Unsubscribe on server, updated documentation, added events.

# Example
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
# Documentation
<https://4ib3r.github.io/StompBrokerJS/>