[![Travis](https://img.shields.io/travis/4ib3r/StompBrokerJS.svg?style=flat-square)](https://travis-ci.org/4ib3r/StompBrokerJS)
[![Known Vulnerabilities](https://snyk.io/test/github/4ib3r/stompbrokerjs/badge.svg)](https://snyk.io/test/github/4ib3r/stompbrokerjs)
[![bitHound](https://img.shields.io/bithound/dependencies/github/4ib3r/StompBrokerJS.svg?style=flat-square)](https://www.bithound.io/github/4ib3r/StompBrokerJS/master/dependencies/npm)
[![bitHound](https://img.shields.io/bithound/code/github/4ib3r/StompBrokerJS.svg?style=flat-square)](https://www.bithound.io/github/4ib3r/StompBrokerJS)
[![Beerpay](https://beerpay.io/4ib3r/StompBrokerJS/badge.svg?style=flat-square)](https://beerpay.io/4ib3r/StompBrokerJS)
[![Paypal](https://www.paypalobjects.com/webstatic/en_US/i/buttons/PP_logo_h_100x26.png)](https://www.paypal.com/pools/c/81vjT1yxR4)
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
* 1.1.1 Unsubscribe on server, updated documentation, added events.
* 1.1.2 Binary data sending, updated documentation, allowed server name modification.

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
}, headers);

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
<dt><a href="#MsgFrame">MsgFrame</a> : <code>object</code></dt>
<dd><p>Message frame</p>
</dd>
</dl>

<a name="StompServer"></a>

## StompServer ⇐ <code>EventEmitter</code>
**Kind**: global class  
**Extends:** <code>EventEmitter</code>  

* [StompServer](#StompServer) ⇐ <code>EventEmitter</code>
    * [new StompServer(config)](#new_StompServer_new)
    * [.onUnsubscribe()](#StompServer+onUnsubscribe) ⇒ <code>boolean</code>
    * [.subscribe(topic, [callback], headers)](#StompServer+subscribe) ⇒ <code>string</code>
    * [.unsubscribe(id)](#StompServer+unsubscribe) ⇒ <code>boolean</code>
    * [.send(topic, headers, body)](#StompServer+send)
    * [.frameSerializer(frame)](#StompServer+frameSerializer) ⇒ <code>[MsgFrame](#MsgFrame)</code>
    * [.frameParser(frame)](#StompServer+frameParser) ⇒ <code>[MsgFrame](#MsgFrame)</code>
    * ["error"](#StompServer+event_error)
    * ["connecting"](#StompServer+event_connecting)
    * ["connected"](#StompServer+event_connected)
    * ["disconnected"](#StompServer+event_disconnected)
    * ["send"](#StompServer+event_send)
    * ["subscribe"](#StompServer+event_subscribe)
    * ["unsubscribe"](#StompServer+event_unsubscribe)

<a name="new_StompServer_new"></a>

### new StompServer(config)

| Param | Type | Description |
| --- | --- | --- |
| config | <code>[ServerConfig](#ServerConfig)</code> | Configuration for STOMP server |

<a name="StompServer+onUnsubscribe"></a>

### stompServer.onUnsubscribe() ⇒ <code>boolean</code>
**Kind**: instance method of <code>[StompServer](#StompServer)</code>  
<a name="StompServer+subscribe"></a>

### stompServer.subscribe(topic, [callback], headers) ⇒ <code>string</code>
Subsribe topic

**Kind**: instance method of <code>[StompServer](#StompServer)</code>  
**Returns**: <code>string</code> - Subscription id, when message is received event with this id is emitted  

| Param | Type | Description |
| --- | --- | --- |
| topic | <code>string</code> | Subscribed destination, wildcard is supported |
| [callback] | <code>[OnSubscribedMessageCallback](#OnSubscribedMessageCallback)</code> | Callback function |
| headers | <code>object</code> | Optional headers, used by client to provide a subscription ID (headers.id) |

**Example**  
```js
stompServer.subscribe("/test.data", function(msg, headers) {}, headers);
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
| body | <code>string</code> | Message body, can be Buffer object |

<a name="StompServer+frameSerializer"></a>

### stompServer.frameSerializer(frame) ⇒ <code>[MsgFrame](#MsgFrame)</code>
Serialize frame to string for send

**Kind**: instance method of <code>[StompServer](#StompServer)</code>  
**Returns**: <code>[MsgFrame](#MsgFrame)</code> - modified frame  

| Param | Type | Description |
| --- | --- | --- |
| frame | <code>[MsgFrame](#MsgFrame)</code> | Message frame |

<a name="StompServer+frameParser"></a>

### stompServer.frameParser(frame) ⇒ <code>[MsgFrame](#MsgFrame)</code>
Parse frame to object for reading

**Kind**: instance method of <code>[StompServer](#StompServer)</code>  
**Returns**: <code>[MsgFrame](#MsgFrame)</code> - modified frame  

| Param | Type | Description |
| --- | --- | --- |
| frame | <code>[MsgFrame](#MsgFrame)</code> | Message frame |

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

<a name="StompServer+event_send"></a>

### "send"
Event emitted when broker send message to subscribers

**Kind**: event emitted by <code>[StompServer](#StompServer)</code>  
**Properties**

| Name | Type | Description |
| --- | --- | --- |
| dest | <code>string</code> | Destination |
| frame | <code>string</code> | Message frame |

<a name="StompServer+event_subscribe"></a>

### "subscribe"
Client subscribe event, emitted when client subscribe topic

**Kind**: event emitted by <code>[StompServer](#StompServer)</code>  
**Properties**

| Name | Type | Description |
| --- | --- | --- |
| id | <code>string</code> | Subscription id |
| sessionId | <code>string</code> | Socket session id |
| topic | <code>string</code> | Destination topic |
| tokens | <code>Array.&lt;string&gt;</code> | Tokenized topic |
| socket | <code>object</code> | Connected socket |

<a name="StompServer+event_unsubscribe"></a>

### "unsubscribe"
Client subscribe event, emitted when client unsubscribe topic

**Kind**: event emitted by <code>[StompServer](#StompServer)</code>  
**Properties**

| Name | Type | Description |
| --- | --- | --- |
| id | <code>string</code> | Subscription id |
| sessionId | <code>string</code> | Socket session id |
| topic | <code>string</code> | Destination topic |
| tokens | <code>Array.&lt;string&gt;</code> | Tokenized topic |
| socket | <code>object</code> | Connected socket |

<a name="ServerConfig"></a>

## ServerConfig : <code>object</code>
STOMP Server configuration

**Kind**: global typedef  

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| server | <code>http.Server</code> |  | Http server reference |
| [serverName] | <code>string</code> | <code>&quot;STOMP-JS/1.1.2&quot;</code> | Websocket server name |
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

<a name="MsgFrame"></a>

## MsgFrame : <code>object</code>
Message frame

**Kind**: global typedef  
