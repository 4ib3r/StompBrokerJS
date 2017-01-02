# StompBrokerJS
NodeJS StompBroker

This is simple NodeJs STOMP 1.1 broker for embedded usage.

# Features
* Destination wildcards
    * . is used to separate names in a path
    * \* is used to mach any name in a path
    * \*\* is used to recursively match path names

#TODO
* Authorization
* Heartbeat
* Acknowledgment
* Async send messages
* Transactions
* Composite Destinations
* Message selectors

#Changelog
* 0.1.0 First working version.
* 0.1.1 Added wildcards to destination, change subscribe method [no backward compatibility]
* 0.1.2 Bug fixes, changed websocket library, updated documentation.
* 0.1.3 Unsubscribe on server, updated documentation, added events.

#Example
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

#Documentation
## Classes

<dl>
<dt><a href="#StompServer">StompServer</a> ⇐ <code>EventEmitter</code></dt>
<dd></dd>
</dl>

## Typedefs

<dl>
<dt><a href="#ServerConfig">ServerConfig</a> : <code>object</code></dt>
<dd><p>STOMP Server configuration</p>
</dd>
<dt><a href="#OnSubscribedMessageCallback">OnSubscribedMessageCallback</a> : <code>function</code></dt>
<dd><p>Subscription callback method</p>
</dd>
</dl>

<a name="StompServer"></a>

## StompServer ⇐ <code>EventEmitter</code>
**Kind**: global class  
**Extends:** <code>EventEmitter</code>  

* [StompServer](#StompServer) ⇐ <code>EventEmitter</code>
    * [new StompServer(config)](#new_StompServer_new)
    * [.subscribe(topic, [callback])](#StompServer+subscribe) ⇒ <code>string</code>
    * [.unsubscribe(id)](#StompServer+unsubscribe) ⇒ <code>boolean</code>
    * [.send(topic, headers, body)](#StompServer+send)
    * ["error"](#StompServer+event_error)
    * ["connecting"](#StompServer+event_connecting)
    * ["connected"](#StompServer+event_connected)
    * ["disconnected"](#StompServer+event_disconnected)

<a name="new_StompServer_new"></a>

### new StompServer(config)

| Param | Type | Description |
| --- | --- | --- |
| config | <code>[ServerConfig](#ServerConfig)</code> | Configuration for STOMP server |

<a name="StompServer+subscribe"></a>

### stompServer.subscribe(topic, [callback]) ⇒ <code>string</code>
Subsribe topic

**Kind**: instance method of <code>[StompServer](#StompServer)</code>  
**Returns**: <code>string</code> - Subscription id, when message is received event with this id is emitted  

| Param | Type | Description |
| --- | --- | --- |
| topic | <code>string</code> | Subscribed destination, wildcard is supported |
| [callback] | <code>[OnSubscribedMessageCallback](#OnSubscribedMessageCallback)</code> | Callback function |

**Example**  
```js
stompServer.subscribe("/test.data", function(msg, headers) {});
//or alternative
var subs_id = stompServer.subscribe("/test.data");
stompServer.on(subs_id, function(msg, headers) {});
```
<a name="StompServer+unsubscribe"></a>

### stompServer.unsubscribe(id) ⇒ <code>boolean</code>
Unsubscribe topic with subscription id

**Kind**: instance method of <code>[StompServer](#StompServer)</code>  
**Returns**: <code>boolean</code> - Subscription is deleted  

| Param | Type | Description |
| --- | --- | --- |
| id | <code>string</code> | Subscription id |

<a name="StompServer+send"></a>

### stompServer.send(topic, headers, body)
Send message to topic

**Kind**: instance method of <code>[StompServer](#StompServer)</code>  

| Param | Type | Description |
| --- | --- | --- |
| topic | <code>string</code> | Destination for message |
| headers | <code>object</code> | Message headers |
| body | <code>string</code> | Message body |

<a name="StompServer+event_error"></a>

### "error"
Client error event

**Kind**: event emitted by <code>[StompServer](#StompServer)</code>  
<a name="StompServer+event_connecting"></a>

### "connecting"
Client connecting event, emitted after socket is opened.

**Kind**: event emitted by <code>[StompServer](#StompServer)</code>  
**Properties**

| Name | Type |
| --- | --- |
| sessionId | <code>string</code> | 

<a name="StompServer+event_connected"></a>

### "connected"
Client connected event, emitted after connection established and negotiated

**Kind**: event emitted by <code>[StompServer](#StompServer)</code>  
**Properties**

| Name | Type |
| --- | --- |
| sessionId | <code>string</code> | 
| headers | <code>object</code> | 

<a name="StompServer+event_disconnected"></a>

### "disconnected"
Client disconnected event

**Kind**: event emitted by <code>[StompServer](#StompServer)</code>  
**Properties**

| Name | Type |
| --- | --- |
| sessionId | <code>string</code> | 

<a name="ServerConfig"></a>

## ServerConfig : <code>object</code>
STOMP Server configuration

**Kind**: global typedef  

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| server | <code>http.Server</code> |  | Http server reference |
| [debug] | <code>function</code> | <code>function(args) {}</code> | Debug function |
| [path] | <code>string</code> | <code>&quot;/stomp&quot;</code> | Websocket path |

<a name="OnSubscribedMessageCallback"></a>

## OnSubscribedMessageCallback : <code>function</code>
Subscription callback method

**Kind**: global typedef  

| Param | Type | Description |
| --- | --- | --- |
| msg | <code>string</code> | Message body |
| headers | <code>object</code> | Message headers |
| headers.destination | <code>string</code> | Message destination |
| headers.subscription | <code>string</code> | Id of subscription |
| headers.message-id | <code>string</code> | Id of message |
| headers.content-type | <code>string</code> | Content type |
| headers.content-length | <code>string</code> | Content length |

