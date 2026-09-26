/**
 * Unit tests for the lib/ building blocks (no network involved).
 */
var assert = require('chai').assert;

var stompUtils = require('../lib/stomp-utils');
var Frame = require('../lib/frame');
var buildConfig = require('../lib/config');
var VERSION = require('../package.json').version;


describe('lib/stomp-utils', function () {

  describe('#parseFrame', function () {
    it('parses command, headers and body', function () {
      var frame = stompUtils.parseFrame('SEND\ndestination:/a\nfoo:bar\n\nhello\0');
      assert.equal(frame.command, 'SEND');
      assert.equal(frame.headers.destination, '/a');
      assert.equal(frame.headers.foo, 'bar');
      assert.equal(frame.body, 'hello');
    });

    it('parses a Buffer the same way as a string, keeping the body binary', function () {
      var frame = stompUtils.parseFrame(Buffer.from('SEND\ndestination:/a\n\nhello\0'));
      assert.equal(frame.command, 'SEND');
      assert.equal(frame.headers.destination, '/a');
      assert.isTrue(Buffer.isBuffer(frame.body));
      assert.equal(frame.body.toString(), 'hello');
    });

    it('keeps colons inside header values', function () {
      var frame = stompUtils.parseFrame('SEND\ndestination:/a\nurl:http://x:80/p\n\n\0');
      assert.equal(frame.headers.url, 'http://x:80/p');
    });

    it('parses a frame without headers', function () {
      var frame = stompUtils.parseFrame('DISCONNECT\n\n\0');
      assert.equal(frame.command, 'DISCONNECT');
      assert.deepEqual(frame.headers, {});
      assert.equal(frame.body, '');
    });

    it('returns null for undefined input', function () {
      assert.isNull(stompUtils.parseFrame(undefined));
    });

    it('does not add pseudo headers', function () {
      var frame = stompUtils.parseFrame('SEND\ndestination:/a\ncontent-length:5\n\nhello\0');
      assert.deepEqual(frame.headers, {destination: '/a', 'content-length': '5'});
    });

    it('keeps blank lines inside the body', function () {
      var frame = stompUtils.parseFrame('SEND\ndestination:/a\n\na\n\nb\n\n\nc\0');
      assert.equal(frame.body, 'a\n\nb\n\n\nc');
    });

    it('uses content-length to read a body containing NULL octets', function () {
      var frame = stompUtils.parseFrame('SEND\ndestination:/a\ncontent-length:3\n\na\0b\0');
      assert.equal(frame.body, 'a\0b');
    });

    it('uses content-length as a UTF-8 byte count', function () {
      var body = 'żółć';
      var raw = 'SEND\ndestination:/a\ncontent-length:' + Buffer.byteLength(body) + '\n\n' + body + '\0';
      assert.equal(stompUtils.parseFrame(Buffer.from(raw)).body.toString(), body);
    });

    it('uses content-length as a UTF-8 byte count for string input', function () {
      var body = 'żółć\0x';
      var raw = 'SEND\ndestination:/a\ncontent-length:' + Buffer.byteLength(body) + '\n\n' + body + '\0';
      assert.equal(stompUtils.parseFrame(raw).body, body);
    });

    it('returns null while a content-length body is incomplete', function () {
      assert.isNull(stompUtils.parseFrame('SEND\ndestination:/a\ncontent-length:99\n\nabc\0'));
    });

    it('parses CRLF line endings', function () {
      var frame = stompUtils.parseFrame('SEND\r\ndestination:/a\r\n\r\nbody\0');
      assert.equal(frame.command, 'SEND');
      assert.equal(frame.headers.destination, '/a');
      assert.equal(frame.body, 'body');
    });

    it('ignores heart-beat EOLs before the command', function () {
      var frame = stompUtils.parseFrame('\n\nCONNECT\naccept-version:1.1\n\n\0');
      assert.equal(frame.command, 'CONNECT');
      assert.equal(frame.headers['accept-version'], '1.1');
    });

    it('unescapes STOMP 1.1 header values', function () {
      var frame = stompUtils.parseFrame('SEND\ndestination:/a\nx:a\\nb\\cc\\\\d\n\n\0');
      assert.equal(frame.headers.x, 'a\nb:c\\d');
    });

    it('keeps the first value of a repeated header', function () {
      var frame = stompUtils.parseFrame('SEND\ndestination:/a\nfoo:first\nfoo:second\n\n\0');
      assert.equal(frame.headers.foo, 'first');
    });
  });


  describe('#tokenizeDestination', function () {
    it('strips the leading slash and splits on dots', function () {
      assert.deepEqual(stompUtils.tokenizeDestination('/one.two.three'), ['one', 'two', 'three']);
    });

    it('accepts destinations without a leading slash', function () {
      assert.deepEqual(stompUtils.tokenizeDestination('one.two'), ['one', 'two']);
    });

    it('treats slashes after the first as part of the name', function () {
      assert.deepEqual(stompUtils.tokenizeDestination('/one/two'), ['one/two']);
    });
  });


  describe('#genId', function () {
    it('uses the given prefix, defaulting to "id"', function () {
      assert.match(stompUtils.genId(), /^id/);
      assert.match(stompUtils.genId('msg'), /^msg/);
    });

    it('generates unique ids', function () {
      var seen = {};
      for (var i = 0; i < 10000; i++) {
        var id = stompUtils.genId();
        assert.isUndefined(seen[id], 'duplicate id ' + id);
        seen[id] = true;
      }
    });
  });


  describe('#sendCommand', function () {
    it('serializes the frame onto the socket', function () {
      var sent = [];
      var socket = {send: function (data) { sent.push(data); }};
      stompUtils.sendCommand(socket, 'RECEIPT', {'receipt-id': 'r1'});
      assert.deepEqual(sent, ['RECEIPT\nreceipt-id:r1\n\n\0']);
    });

    it('adds a receipt header when requested', function () {
      var socket = {send: function () {}};
      var frame = stompUtils.sendCommand(socket, 'SEND', {}, 'x', true);
      assert.match(frame.headers.receipt, /^r/);
    });
  });
});


describe('lib/frame', function () {
  it('serializes a string body with NULL terminator', function () {
    var frame = new Frame({command: 'MESSAGE', headers: {a: '1', b: '2'}, body: 'hello'});
    assert.equal(frame.toStringOrBuffer(), 'MESSAGE\na:1\nb:2\n\nhello\0');
  });

  it('serializes a frame without body', function () {
    var frame = new Frame({command: 'RECEIPT', headers: {'receipt-id': 'r'}});
    assert.equal(frame.toStringOrBuffer(), 'RECEIPT\nreceipt-id:r\n\n\0');
  });

  it('serializes a Buffer body into a Buffer', function () {
    var body = Buffer.from([0x00, 0x01, 0xff]);
    var frame = new Frame({command: 'MESSAGE', headers: {a: '1'}, body: body});
    var out = frame.toStringOrBuffer();
    assert.isTrue(Buffer.isBuffer(out));
    var header = Buffer.from('MESSAGE\na:1\n\n');
    assert.isTrue(out.slice(0, header.length).equals(header));
    assert.isTrue(out.slice(header.length, header.length + 3).equals(body));
    assert.equal(out[out.length - 1], 0);
    assert.equal(out.length, header.length + body.length + 1);
  });

  it('escapes STOMP 1.1 special characters in header values', function () {
    var frame = new Frame({command: 'MESSAGE', headers: {x: 'a\nb:c\\d'}, body: ''});
    assert.equal(frame.toStringOrBuffer(), 'MESSAGE\nx:a\\nb\\cc\\\\d\n\n\0');
  });

  it('serializes a frame without headers without an extra line feed', function () {
    var frame = new Frame({command: 'DISCONNECT', headers: {}, body: 'x'});
    assert.equal(frame.toStringOrBuffer(), 'DISCONNECT\n\nx\0');
  });

  it('escapes header names as well as values', function () {
    var frame = new Frame({command: 'MESSAGE', headers: {'a:b\nc': 'v'}});
    assert.equal(frame.toStringOrBuffer('1.1'), 'MESSAGE\na\\cb\\nc:v\n\n\0');
  });

  it('leaves out headers that cannot be written for STOMP 1.1', function () {
    var frame = new Frame({command: 'MESSAGE', headers: {a: 'x\ry', b: 'x\0y', 'c\0': 'v', ok: '1'}});
    assert.equal(frame.toStringOrBuffer('1.1'), 'MESSAGE\nok:1\n\n\0');
  });

  it('leaves out headers that cannot be written for STOMP 1.0', function () {
    var frame = new Frame({command: 'MESSAGE', headers: {a: 'x\ny', 'b:c': 'v', d: 'x\0', ok: 'u:v'}});
    assert.equal(frame.toStringOrBuffer('1.0'), 'MESSAGE\nok:u:v\n\n\0');
  });

  it('does not escape CONNECTED headers but leaves out unsafe ones', function () {
    var frame = new Frame({command: 'CONNECTED', headers: {server: 'a:b', bad: 'x\ny'}});
    assert.equal(frame.toStringOrBuffer('1.1'), 'CONNECTED\nserver:a:b\n\n\0');
  });

  it('leaves out headers with undefined or null values', function () {
    var frame = new Frame({command: 'RECEIPT', headers: {'receipt-id': undefined, x: null, y: 0}});
    assert.equal(frame.toStringOrBuffer(), 'RECEIPT\ny:0\n\n\0');
  });

  it('adds a receipt header with buildFrame(args, true)', function () {
    var frame = new Frame().buildFrame({command: 'SEND', headers: {session: 's1'}}, true);
    assert.match(frame.headers.receipt, /-s1$/);
  });
});


describe('lib/config', function () {
  var server = {};

  it('applies defaults', function () {
    var conf = buildConfig({server: server});
    assert.strictEqual(conf.server, server);
    assert.equal(conf.serverName, 'STOMP-JS/' + VERSION);
    assert.equal(conf.path, '/stomp');
    assert.deepEqual(conf.heartbeat, [0, 0]);
    assert.equal(conf.heartbeatErrorMargin, 1000);
    assert.equal(conf.protocol, 'ws');
    assert.deepEqual(conf.protocolConfig, {});
    assert.isFunction(conf.debug);
  });

  it('keeps provided values', function () {
    var debug = function () {};
    var conf = buildConfig({
      server: server,
      serverName: 'X',
      path: '/p',
      heartbeat: [1, 2],
      heartbeatErrorMargin: 5,
      debug: debug,
      protocol: 'sockjs',
      protocolConfig: {a: 1}
    });
    assert.equal(conf.serverName, 'X');
    assert.equal(conf.path, '/p');
    assert.deepEqual(conf.heartbeat, [1, 2]);
    assert.equal(conf.heartbeatErrorMargin, 5);
    assert.strictEqual(conf.debug, debug);
    assert.equal(conf.protocol, 'sockjs');
    assert.deepEqual(conf.protocolConfig, {a: 1});
  });

  it('respects heartbeatErrorMargin of 0', function () {
    assert.equal(buildConfig({server: server, heartbeatErrorMargin: 0}).heartbeatErrorMargin, 0);
  });

  it('throws an Error instance when server is missing', function () {
    assert.throws(function () {
      buildConfig({});
    }, Error, /server/i);
  });

  it('rejects an unknown protocol', function () {
    assert.throws(function () {
      buildConfig({server: server, protocol: 'foo'});
    }, Error, /protocol/i);
  });
});
