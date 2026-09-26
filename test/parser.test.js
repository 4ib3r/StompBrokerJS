/**
 * FrameDecoder: incremental parsing of STOMP frames from arbitrary chunks.
 */
var assert = require('chai').assert;

var FrameDecoder = require('../lib/parser').FrameDecoder;
var ProtocolError = require('../lib/errors').ProtocolError;
var Frame = require('../lib/frame');


/** Decode all frames from `chunks` pushed one by one */
function decodeAll(chunks, version, options) {
  var decoder = new FrameDecoder(options);
  var frames = [];
  chunks.forEach(function (chunk) {
    decoder.push(chunk);
    var frame;
    while ((frame = decoder.shift(version)) !== null) {
      frames.push(frame);
    }
  });
  return frames;
}

/** Split `data` (string or Buffer) into pieces of `size` */
function split(data, size) {
  var pieces = [];
  for (var i = 0; i < data.length; i += size) {
    pieces.push(data.slice(i, i + size));
  }
  return pieces;
}

function plain(frame) {
  return {command: frame.command, headers: frame.headers, body: frame.body};
}


describe('lib/parser FrameDecoder', function () {

  describe('framing', function () {
    it('decodes several frames from one chunk', function () {
      var frames = decodeAll(['SEND\ndestination:/a\n\none\0SEND\ndestination:/b\n\ntwo\0']);
      assert.deepEqual(frames.map(plain), [
        {command: 'SEND', headers: {destination: '/a'}, body: 'one'},
        {command: 'SEND', headers: {destination: '/b'}, body: 'two'}
      ]);
    });

    it('skips heart-beat EOLs before, between and after frames', function () {
      var frames = decodeAll(['\n\r\nSEND\ndestination:/a\n\none\0\n\n\r\nSEND\ndestination:/b\n\ntwo\0\n']);
      assert.deepEqual(frames.map(function (f) {
        return f.body;
      }), ['one', 'two']);
    });

    it('returns nothing for heart-beats only and leaves nothing pending', function () {
      var decoder = new FrameDecoder();
      decoder.push('\n\r\n\n');
      assert.isNull(decoder.shift());
      assert.equal(decoder.pending, 0);
    });

    it('waits for the NUL of a frame split across chunks', function () {
      var decoder = new FrameDecoder();
      decoder.push('SEND\ndestination:/a\n\nhel');
      assert.isNull(decoder.shift());
      decoder.push('lo');
      assert.isNull(decoder.shift());
      decoder.push('\0');
      assert.equal(decoder.shift().body, 'hello');
      assert.equal(decoder.pending, 0);
    });

    it('decodes the same frames for every two-piece split', function () {
      var raw = 'SEND\r\ndestination:/a\r\ncontent-length:3\r\n\r\na\0b\0\nSEND\ndestination:/b\nx:\\n\n\nżółć\0';
      var expected = decodeAll([raw]).map(plain);
      assert.lengthOf(expected, 2);
      var bytes = Buffer.from(raw);
      for (var i = 1; i < bytes.length; i++) {
        // split the UTF-8 bytes anywhere, including inside a character, CRLF or the body
        var frames = decodeAll([bytes.subarray(0, i), bytes.subarray(i)]);
        assert.deepEqual(frames.map(function (f) {
          return {command: f.command, headers: f.headers, body: f.body.toString()};
        }), expected, 'split at byte ' + i);
      }
    });

    it('decodes a frame fed one byte at a time', function () {
      var raw = Buffer.from('SEND\ndestination:/a\ncontent-length:6\n\nżół\0');
      var frames = decodeAll(split(raw, 1));
      assert.lengthOf(frames, 1);
      assert.equal(frames[0].body.toString(), 'żół');
    });

    it('decodes a large text frame sent in 16 KB pieces (stompjs splitting)', function () {
      var body = new Array(100 * 1024 + 1).join('x');
      var frames = decodeAll(split('SEND\ndestination:/a\n\n' + body + '\0', 16 * 1024));
      assert.lengthOf(frames, 1);
      assert.equal(frames[0].body, body);
    });

    it('reports the pending byte count of an incomplete frame', function () {
      var decoder = new FrameDecoder();
      decoder.push('SEND\n\nab');
      assert.isNull(decoder.shift());
      assert.equal(decoder.pending, 8);
    });
  });


  describe('bodies', function () {
    it('reads content-length octets, including NUL', function () {
      var frames = decodeAll(['SEND\ncontent-length:3\n\na\0b\0']);
      assert.equal(frames[0].body, 'a\0b');
    });

    it('waits for all content-length octets', function () {
      var decoder = new FrameDecoder();
      decoder.push('SEND\ncontent-length:5\n\nab\0');
      assert.isNull(decoder.shift());
      decoder.push('cd\0');
      assert.equal(decoder.shift().body, 'ab\0cd');
    });

    it('keeps a binary body byte for byte', function () {
      var body = Buffer.from([0xff, 0x00, 0x80]);
      var raw = Buffer.concat([Buffer.from('SEND\ncontent-length:3\n\n'), body, Buffer.from([0])]);
      var frame = decodeAll([raw])[0];
      assert.isTrue(Buffer.isBuffer(frame.body));
      assert.isTrue(frame.body.equals(body));
    });

    it('returns a text body as a string', function () {
      assert.isString(decodeAll(['SEND\n\nabc\0'])[0].body);
    });

    it('returns a Buffer body when part of the frame arrived binary', function () {
      var frame = decodeAll(['SEND\n\nab', Buffer.from('c\0')])[0];
      assert.isTrue(Buffer.isBuffer(frame.body));
      assert.equal(frame.body.toString(), 'abc');
    });

    it('rejects a content-length body not followed by NUL', function () {
      assert.throws(function () {
        decodeAll(['SEND\ncontent-length:2\n\nabc\0']);
      }, ProtocolError, /NUL/);
    });

    it('rejects an invalid content-length', function () {
      ['abc', '-1', '1.5', ' 3'].forEach(function (value) {
        assert.throws(function () {
          decodeAll(['SEND\ncontent-length:' + value + '\n\nabc\0']);
        }, ProtocolError, /content-length/, value);
      });
    });
  });


  describe('headers', function () {
    it('keeps whitespace in header names and values', function () {
      var frame = decodeAll(['SEND\nfoo: bar \n x :y\n\n\0'])[0];
      assert.deepEqual(frame.headers, {foo: ' bar ', ' x ': 'y'});
    });

    it('keeps colons inside values', function () {
      assert.equal(decodeAll(['SEND\nurl:http://x:80/\n\n\0'])[0].headers.url, 'http://x:80/');
    });

    it('keeps the first value of a repeated header', function () {
      assert.equal(decodeAll(['SEND\nfoo:1\nfoo:2\n\n\0'])[0].headers.foo, '1');
    });

    it('unescapes names and values in STOMP 1.1 frames', function () {
      var frame = decodeAll(['SEND\na\\cb:x\\ny\\\\z\n\n\0'], '1.1')[0];
      assert.deepEqual(frame.headers, {'a:b': 'x\ny\\z'});
    });

    it('keeps unknown escape sequences verbatim', function () {
      assert.equal(decodeAll(['SEND\npath:C:\\temp\\x\n\n\0'], '1.1')[0].headers.path, 'C:\\temp\\x');
    });

    it('does not unescape STOMP 1.0 frames', function () {
      assert.equal(decodeAll(['SEND\nx:a\\nb\n\n\0'], '1.0')[0].headers.x, 'a\\nb');
    });

    it('does not unescape CONNECT and STOMP frames alike', function () {
      var connect = decodeAll(['CONNECT\npasscode:a\\nb\n\n\0'])[0];
      var stomp = decodeAll(['STOMP\npasscode:a\\nb\n\n\0'])[0];
      assert.equal(connect.headers.passcode, 'a\\nb');
      assert.equal(stomp.headers.passcode, 'a\\nb');
    });

    it('ignores a __proto__ header', function () {
      var frame = decodeAll(['SEND\n__proto__:x\n\n\0'])[0];
      assert.deepEqual(Object.keys(frame.headers), []);
      assert.equal(Object.getPrototypeOf(frame.headers), Object.prototype);
    });

    it('rejects a NUL inside a header (frame smuggling)', function () {
      assert.throws(function () {
        decodeAll(['SEND\ndestination:/a\nx:y\0MESSAGE\ndestination:/admin\n\nbody\0']);
      }, ProtocolError);
    });

    it('rejects CR inside a header, raw or escaped', function () {
      assert.throws(function () {
        decodeAll(['SEND\nx:a\rb\n\n\0']);
      }, ProtocolError);
      assert.throws(function () {
        decodeAll(['SEND\nx:a\\rb\n\n\0'], '1.1');
      }, ProtocolError);
    });

    it('rejects a header line without a name', function () {
      ['SEND\n:x\n\n\0', 'SEND\nnocolon\n\n\0'].forEach(function (raw) {
        assert.throws(function () {
          decodeAll([raw]);
        }, ProtocolError, /header/);
      });
    });

    it('rejects an invalid command', function () {
      ['send\n\n\0', 'SEND X\n\n\0', '\u00ff\n\n\0'].forEach(function (raw) {
        assert.throws(function () {
          decodeAll([raw]);
        }, ProtocolError, /command/);
      });
    });
  });


  describe('limits', function () {
    it('rejects an incomplete frame larger than maxFrameSize', function () {
      var decoder = new FrameDecoder({maxFrameSize: 16});
      decoder.push('SEND\n\n0123456789');
      assert.isNull(decoder.shift());
      decoder.push('0123456789');
      assert.throws(function () {
        decoder.shift();
      }, ProtocolError, /too large/);
    });

    it('rejects a content-length above maxFrameSize before the body arrives', function () {
      var decoder = new FrameDecoder({maxFrameSize: 16});
      decoder.push('SEND\ncontent-length:1000\n\n');
      assert.throws(function () {
        decoder.shift();
      }, ProtocolError, /too large/);
    });

    it('accepts a frame of exactly maxFrameSize', function () {
      var raw = 'SEND\n\n0123456789\0';
      var frames = decodeAll([raw], undefined, {maxFrameSize: Buffer.byteLength(raw)});
      assert.lengthOf(frames, 1);
    });
  });


  describe('round trip', function () {
    // deterministic PRNG, failures are reproducible
    function prng(seed) {
      return function () {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
    }

    it('decodes 2000 random frames split at random offsets as serialized', function () {
      var random = prng(42);
      var alphabet = 'abc:\\\n xyzŻółć-/.';
      function text(max) {
        var len = Math.floor(random() * max);
        var s = '';
        for (var i = 0; i < len; i++) {
          s += alphabet.charAt(Math.floor(random() * alphabet.length));
        }
        return s;
      }

      var frames = [];
      var raw = [];
      for (var n = 0; n < 2000; n++) {
        var headers = {};
        var count = Math.floor(random() * 4);
        for (var h = 0; h < count; h++) {
          var name = 'h' + h + text(5);
          headers[name] = text(10);
        }
        var binary = random() < 0.3;
        var body;
        if (binary) {
          body = Buffer.alloc(Math.floor(random() * 20));
          for (var b = 0; b < body.length; b++) {
            body[b] = Math.floor(random() * 256);
          }
          headers['content-length'] = String(body.length);
        } else {
          body = text(30).replace(/\0/g, '');
        }
        frames.push({command: 'SEND', headers: headers, body: body});
        var serialized = new Frame({command: 'SEND', headers: headers, body: body}).toStringOrBuffer('1.1');
        raw.push(Buffer.isBuffer(serialized) ? serialized : Buffer.from(serialized));
        if (random() < 0.2) {
          raw.push(Buffer.from('\n'));
        }
      }

      var all = Buffer.concat(raw);
      var chunks = [];
      for (var pos = 0; pos < all.length;) {
        var size = 1 + Math.floor(random() * 200);
        chunks.push(all.subarray(pos, pos + size));
        pos += size;
      }

      var decoded = decodeAll(chunks, '1.1');
      assert.lengthOf(decoded, frames.length);
      decoded.forEach(function (frame, i) {
        assert.equal(frame.command, 'SEND');
        assert.deepEqual(frame.headers, frames[i].headers, 'headers of frame ' + i);
        var expected = frames[i].body;
        var actual = Buffer.isBuffer(expected) ? frame.body : frame.body.toString();
        if (Buffer.isBuffer(expected)) {
          assert.isTrue(actual.equals(expected), 'body of frame ' + i);
        } else {
          assert.equal(actual, expected, 'body of frame ' + i);
        }
      });
    });
  });
});
