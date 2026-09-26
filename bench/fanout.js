/**
 * Routing benchmark: publish to one destination among many subscriptions.
 * Run with `node bench/fanout.js`; not part of the test suite.
 */
var StompServer = require('../stompServer');

var broker = new StompServer({protocolConfig: {noServer: true}, limits: {maxSubscriptions: Infinity}});
var sent = 0;

function connectedSession() {
  var session = broker._createSession({
    readyState: 1,
    send: function () {
      sent++;
    },
    close: function () {}
  });
  session.state = 'CONNECTED';
  session.version = '1.1';
  return session;
}

var SUBSCRIPTIONS = 10000;
for (var i = 0; i < SUBSCRIPTIONS; i++) {
  broker.onSubscribe(connectedSession(), {dest: '/topic.t' + i, id: 'sub' + i});
}
for (var j = 0; j < 100; j++) {
  broker.onSubscribe(connectedSession(), {dest: j % 2 ? '/topic.t5' : '/topic.*', id: 'extra' + j});
}

function run(label, destination, messages) {
  sent = 0;
  var start = process.hrtime.bigint();
  for (var n = 0; n < messages; n++) {
    broker.send(destination, {}, 'hello');
  }
  var ms = Number(process.hrtime.bigint() - start) / 1e6;
  console.log(label + ': ' + (ms / messages * 1000).toFixed(1) + ' µs/message, ' +
    (sent / messages) + ' deliveries/message');
}

console.log(SUBSCRIPTIONS + 100 + ' subscriptions');
run('/topic.t1 (exact + 50 wildcard subscriptions)', '/topic.t1', 2000);
run('/topic.t5 (51 exact + 50 wildcard subscriptions)', '/topic.t5', 2000);
