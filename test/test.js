var http = require("http");
var StompServer = require('../stompServer');
var WebSocket = require('ws');
var stompjs = require('stompjs');

var assert = require('chai').assert;


var server;
var stompServer;

var socket;
var client;

describe('StompServer', function() {

  beforeEach(function(done) {
      server = http.createServer();
      stompServer = new StompServer({server: server});
      server.listen(61614, function(err) {
        assert.ifError(err);
        console.log("Server listen");
        socket = new WebSocket('ws://localhost:61614/stomp');
        client = stompjs.over(socket);
        client.connect({
          login: 'mylogin',
          passcode: 'mypasscode',
          'client-id': 'my-client-id'
        }, function (error) {
          // display the error's message header:
          if (error.command === "ERROR") {
            console.error(error.headers.message);
            done(error);
          } else {
            console.log("Connected");
            done();
          }
        });
      });
  });

  afterEach(function(done) {
    console.log("disconnect");
    client.disconnect(function() {
      server.close();
      done();
    });
  });

  describe('#send', function() {
    it('check msg and topic wildcard subscription', function(done) {
      var headers = {'id': 'sub-0'};
      stompServer.subscribe("/**", function(msg, headers) {
        var topic = headers.destination;
        assert.equal(topic, '/data');
        assert.equal(msg, 'test body');
        done();
      }, headers);
      client.send('/data', {}, 'test body');
    });

    it('sub-topic wildcard subscription', function(done) {
      var msgCnt = 0;
      var timer = null;
      function check() {
        assert.equal(msgCnt, 2);
        done();
      }
      stompServer.subscribe("test.**", function(msg, headers) {
        var topic = headers.destination;
        //assert.equal(topic, '/data');
        assert.equal(msg, 'test body');
        msgCnt++;
        clearTimeout(timer);
        timer = setTimeout(check, 200);
      });
      client.send('test.data', {}, 'test body');
      client.send('test.t1', {}, 'test body');
      client.send('data.t1', {}, 'fail');
    });

    it('specific topic subscription', function(done) {
      var headers = {};
      stompServer.subscribe("/ok", function(msg, headers) {
        var topic = headers.destination;
        assert.equal(topic, '/ok');
        assert.equal(msg, 'test body');
        done();
      }, headers);
      stompServer.subscribe("/fail", function(msg, headers) {
        done(new Error("incorrect subscription executed"));
      }, headers);
      client.send('/ok', {}, 'test body');
    });
  });

  describe('#subscribe', function() {
    it('check binary data delivery', function(done) {
      function onRawMessage(msg) {
        assert.instanceOf(msg, ArrayBuffer);
        var text = Buffer.from(msg).toString();
        assert.match(text, /^MESSAGE(.|\n)*\n\nbinary body\0$/);
        done();
      }
      stompServer.on('subscribe', function() {
        var data = Buffer.from('binary body');
        socket.once('message', onRawMessage);
        stompServer.send('/data', {'content-type': 'application/octet-stream'}, data);
      });
      client.subscribe("/data");
    });
  });

  describe('#unsubscribe', function() {
    it('check topic unsubscribe', function(done) {
      var isSubscribed = true;
      var subId = stompServer.subscribe("/**", function(msg, headers) {
        assert.equal(headers.destination, '/test');
        assert.equal(msg, 'test');
        assert.isTrue(isSubscribed);
        assert.isTrue(stompServer.unsubscribe(subId), 'unsubscribe fail, subId: ' + subId);
        isSubscribed = false;
        setTimeout(function () {
          done();
        }, 200);
        client.send("/test", {}, "test"); //second send msg
      }, {});
      client.send("/test", {}, "test");
    });
  });
});
