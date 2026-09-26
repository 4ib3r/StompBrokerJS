/**
 * SubscriptionRegistry: trie matching against the reference (linear) matcher.
 */
var assert = require('chai').assert;

var SubscriptionRegistry = require('../lib/subscription-registry');

/** Reference semantics of destination patterns (the matcher used before the trie) */
function matches(pattern, tokens) {
  for (var i = 0; i < pattern.length; i++) {
    if (pattern[i] === '**') {
      return true;
    }
    if (i >= tokens.length || (pattern[i] !== '*' && pattern[i] !== tokens[i])) {
      return false;
    }
  }
  return pattern.length === tokens.length;
}

function sub(sessionId, id, pattern) {
  return {sessionId: sessionId, id: id, tokens: pattern.split('.')};
}

function ids(subs) {
  return subs.map(function (s) {
    return s.id;
  });
}

describe('lib/subscription-registry', function () {
  it('matches exact names, * and **', function () {
    var registry = new SubscriptionRegistry();
    ['a.b', 'a.*', 'a.**', '**', '*.b', 'a.b.c', 'a', '*'].forEach(function (pattern, i) {
      registry.add(sub('s', 'p' + i + ':' + pattern, pattern));
    });
    assert.deepEqual(ids(registry.match(['a', 'b'])), ['p0:a.b', 'p1:a.*', 'p2:a.**', 'p3:**', 'p4:*.b']);
    assert.deepEqual(ids(registry.match(['a'])), ['p2:a.**', 'p3:**', 'p6:a', 'p7:*']);
    assert.deepEqual(ids(registry.match(['x', 'y', 'z'])), ['p3:**']);
  });

  it('returns matches in subscription order', function () {
    var registry = new SubscriptionRegistry();
    registry.add(sub('s', '1', 'a.**'));
    registry.add(sub('s', '2', 'a.b'));
    registry.add(sub('s', '3', '*.b'));
    registry.add(sub('t', '4', 'a.b'));
    assert.deepEqual(ids(registry.match(['a', 'b'])), ['1', '2', '3', '4']);
  });

  it('indexes subscriptions per session', function () {
    var registry = new SubscriptionRegistry();
    registry.add(sub('s', '1', 'a'));
    registry.add(sub('t', '1', 'a'));
    assert.throws(function () {
      registry.add(sub('s', '1', 'b'));
    }, /already in use/);
    assert.equal(registry.countSession('s'), 1);
    assert.equal(registry.get('t', '1').sessionId, 't');
    assert.equal(registry.remove('s', '1').sessionId, 's');
    assert.isUndefined(registry.remove('s', '1'));
    assert.deepEqual(registry.match(['a']).map(function (s) {
      return s.sessionId;
    }), ['t']);
  });

  it('removes all subscriptions of a session and prunes the trie', function () {
    var registry = new SubscriptionRegistry();
    registry.add(sub('s', '1', 'a.b.c'));
    registry.add(sub('s', '2', 'a.*.**'));
    registry.add(sub('t', '3', 'x'));
    assert.lengthOf(registry.removeSession('s'), 2);
    assert.deepEqual(registry.removeSession('s'), []);
    assert.equal(registry.size, 1);
    assert.deepEqual(Array.from(registry._root.children.keys()), ['x']);
  });

  it('agrees with the reference matcher on random patterns', function () {
    var seed = 7;
    function random(n) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    }
    var names = ['a', 'b', 'c', '*', '**'];
    function randomTokens(allowWildcards) {
      var tokens = [];
      var length = 1 + random(4);
      for (var i = 0; i < length; i++) {
        tokens.push(names[random(allowWildcards ? names.length : 3)]);
      }
      return tokens;
    }

    var registry = new SubscriptionRegistry();
    var live = [];
    for (var n = 0; n < 3000; n++) {
      if (live.length > 0 && random(4) === 0) {
        var gone = live.splice(random(live.length), 1)[0];
        registry.remove(gone.sessionId, gone.id);
      } else {
        var s = {sessionId: 's' + random(5), id: 'id' + n, tokens: randomTokens(true)};
        registry.add(s);
        live.push(s);
      }
      if (n % 10 === 0) {
        var dest = randomTokens(false);
        var expected = live.filter(function (candidate) {
          return matches(candidate.tokens, dest);
        }).sort(function (x, y) {
          return x.seq - y.seq;
        });
        assert.deepEqual(ids(registry.match(dest)), ids(expected), dest.join('.'));
      }
    }
    assert.equal(registry.size, live.length);
  });
});
