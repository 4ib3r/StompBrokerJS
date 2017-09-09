var http = require("http");
var StompServer = require('../stompServer');

var testCase = require('mocha').describe;
var before = require('mocha').before;
var after = require('mocha').after;
var assertions = require('mocha').it;
var assert = require('chai').assert;


var server = http.createServer();
var stompServer = new StompServer({server: server});

testCase('StompServer', function() {

  before(function() {
    server.listen(61614);
  });

  after(function() {
    server.close();
  });

  testCase('#send', function() {
    assertions('check msg and topic subscription', function() {
      var headers = {'id': 'sub-0'};
      stompServer.subscribe("/**", function(msg, headers) {
        var topic = headers.destination;
        assert.equal(topic, '/data');
        assert.equal(msg, 'test body');
      }, headers);
      stompServer.send('/data', {}, 'test body');
    });
  });

  testCase('#unsubscribe', function() {
    assertions('check topic unsubscribe', function() {
      var headers = {'id': 'sub-0'};
      stompServer.subscribe("/**", function(msg, headers) {
        var subId = headers.subscription;
        assert.isTrue(stompServer.unsubscribe(subId), 'unsubscribe successfull, subId: ' + subId);
      }, headers);
    });
  });
});
