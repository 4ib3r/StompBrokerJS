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
* 1.1.1 Unsubscribe on server, updated documentation, added events.
* 1.1.2 Binary data sending, updated documentation, allowed server name modification.
* 1.2.0 Added heartbeat.

# Example
```javascript
var http = require("http");
var StompServer = require('stomp-broker-js');

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

## StompServer ⇐ `EventEmitter`
**Kind**: global class  
**Extends:** `EventEmitter`  

* [StompServer](#StompServer) ⇐ `EventEmitter`
    * [new StompServer(config)](#new_StompServer_new)
    * [.onUnsubscribe()](#StompServer+onUnsubscribe) ⇒ `boolean`
    * [.subscribe(topic, [callback], headers)](#StompServer+subscribe) ⇒ `string`
    * [.unsubscribe(id)](#StompServer+unsubscribe) ⇒ `boolean`
    * [.send(topic, headers, body)](#StompServer+send)
    * [.frameSerializer(frame)](#StompServer+frameSerializer) ⇒ [`MsgFrame`](#MsgFrame)
    * [.frameParser(frame)](#StompServer+frameParser) ⇒ [`MsgFrame`](#MsgFrame)
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
| config | [`ServerConfig`](#ServerConfig) | Configuration for STOMP server |

<a name="StompServer+onUnsubscribe"></a>

### stompServer.onUnsubscribe() ⇒ `boolean`
**Kind**: instance method of [`StompServer`](#StompServer)  
<a name="StompServer+subscribe"></a>

### stompServer.subscribe(topic, [callback], headers) ⇒ `string`
Subsribe topic

**Kind**: instance method of [`StompServer`](#StompServer)  
**Returns**: `string` - Subscription id, when message is received event with this id is emitted  

| Param | Type | Description |
| --- | --- | --- |
| topic | `string` | Subscribed destination, wildcard is supported |
| [callback] | [`OnSubscribedMessageCallback`](#OnSubscribedMessageCallback) | Callback function |
| headers | `object` | Optional headers, used by client to provide a subscription ID (headers.id) |

**Example**  
```js
stompServer.subscribe("/test.data", function(msg, headers) {}, headers);
//or alternative
var subs_id = stompServer.subscribe("/test.data");
stompServer.on(subs_id, function(msg, headers) {});
```
<a name="StompServer+unsubscribe"></a>

### stompServer.unsubscribe(id) ⇒ `boolean`
Unsubscribe topic with subscription id

**Kind**: instance method of [`StompServer`](#StompServer)  
**Returns**: `boolean` - Subscription is deleted  

| Param | Type | Description |
| --- | --- | --- |
| id | `string` | Subscription id |

<a name="StompServer+send"></a>

### stompServer.send(topic, headers, body)
Send message to topic

**Kind**: instance method of [`StompServer`](#StompServer)  

| Param | Type | Description |
| --- | --- | --- |
| topic | `string` | Destination for message |
| headers | `object` | Message headers |
| body | `string` | Message body, can be Buffer object |

<a name="StompServer+frameSerializer"></a>

### stompServer.frameSerializer(frame) ⇒ [`MsgFrame`](#MsgFrame)
Serialize frame to string for send

**Kind**: instance method of [`StompServer`](#StompServer)  
**Returns**: [`MsgFrame`](#MsgFrame) - modified frame  

| Param | Type | Description |
| --- | --- | --- |
| frame | [`MsgFrame`](#MsgFrame) | Message frame |

<a name="StompServer+frameParser"></a>

### stompServer.frameParser(frame) ⇒ [`MsgFrame`](#MsgFrame)
Parse frame to object for reading

**Kind**: instance method of [`StompServer`](#StompServer)  
**Returns**: [`MsgFrame`](#MsgFrame) - modified frame  

| Param | Type | Description |
| --- | --- | --- |
| frame | [`MsgFrame`](#MsgFrame) | Message frame |

<a name="StompServer+event_error"></a>

### "error"
Client error event

**Kind**: event emitted by [`StompServer`](#StompServer)  
<a name="StompServer+event_connecting"></a>

### "connecting"
Client connecting event, emitted after socket is opened.

**Kind**: event emitted by [`StompServer`](#StompServer)  
**Properties**

| Name | Type |
| --- | --- |
| sessionId | `string` | 

<a name="StompServer+event_connected"></a>

### "connected"
Client connected event, emitted after connection established and negotiated

**Kind**: event emitted by [`StompServer`](#StompServer)  
**Properties**

| Name | Type |
| --- | --- |
| sessionId | `string` | 
| headers | `object` | 

<a name="StompServer+event_disconnected"></a>

### "disconnected"
Client disconnected event

**Kind**: event emitted by [`StompServer`](#StompServer)  
**Properties**

| Name | Type |
| --- | --- |
| sessionId | `string` | 

<a name="StompServer+event_send"></a>

### "send"
Event emitted when broker send message to subscribers

**Kind**: event emitted by [`StompServer`](#StompServer)  
**Properties**

| Name | Type | Description |
| --- | --- | --- |
| dest | `string` | Destination |
| frame | `string` | Message frame |

<a name="StompServer+event_subscribe"></a>

### "subscribe"
Client subscribe event, emitted when client subscribe topic

**Kind**: event emitted by [`StompServer`](#StompServer)  
**Properties**

| Name | Type | Description |
| --- | --- | --- |
| id | `string` | Subscription id |
| sessionId | `string` | Socket session id |
| topic | `string` | Destination topic |
| tokens | `Array.<string>` | Tokenized topic |
| socket | `object` | Connected socket |

<a name="StompServer+event_unsubscribe"></a>

### "unsubscribe"
Client subscribe event, emitted when client unsubscribe topic

**Kind**: event emitted by [`StompServer`](#StompServer)  
**Properties**

| Name | Type | Description |
| --- | --- | --- |
| id | `string` | Subscription id |
| sessionId | `string` | Socket session id |
| topic | `string` | Destination topic |
| tokens | `Array.<string>` | Tokenized topic |
| socket | `object` | Connected socket |

<a name="ServerConfig"></a>

## ServerConfig : `object`
STOMP Server configuration

**Kind**: global typedef  

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| server | `http.Server` |  | Http server reference |
| [serverName] | `string` | `"STOMP-JS/" + VERSION` | Websocket server name |
| [path] | `string` | `"/stomp"` | Websocket path |
| [heartbeat] | `array` | `[10000, 10000]` | Heartbeat; read [documentation](https://stomp.github.io/stomp-specification-1.1.html#Heart-beating) to config according to your desire |
| [heartbeatErrorMargin] | `number` | `1000` | Heartbeat error margin; specify how strict server should be |
| [debug] | `function` | `function(args) {}` | Debug function |

<a name="OnSubscribedMessageCallback"></a>

## OnSubscribedMessageCallback : `function`
Subscription callback method

**Kind**: global typedef  

| Param | Type | Description |
| --- | --- | --- |
| msg | `string` | Message body |
| headers | `object` | Message headers |
| headers.destination | `string` | Message destination |
| headers.subscription | `string` | Id of subscription |
| headers.message-id | `string` | Id of message |
| headers.content-type | `string` | Content type |
| headers.content-length | `string` | Content length |

<a name="MsgFrame"></a>

## MsgFrame : `object`
Message frame

**Kind**: global typedef  
