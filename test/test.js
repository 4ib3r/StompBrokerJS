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
      stompServer.subscribe("/**", function(msg, headers) {
        var topic = headers.destination;
        assert.equal(topic, '/data');
        assert.equal(msg, 'test body');
      });
      stompServer.send('/data', {}, 'test body');
    });
  });
});

