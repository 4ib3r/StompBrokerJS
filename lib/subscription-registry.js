/**
 * Node of the destination trie: one level of a tokenized destination.
 * @private
 */
function Node(parent, key) {
  this.parent = parent;
  this.key = key;
  // exact names
  this.children = new Map();
  // `*`: any single name
  this.star = null;
  // subscriptions whose pattern ends here
  this.subs = new Set();
  // subscriptions whose pattern continues with `**` here: any rest, also none
  this.rest = new Set();
}

Node.prototype.isEmpty = function () {
  return this.children.size === 0 && this.star === null && this.subs.size === 0 && this.rest.size === 0;
};

/**
 * Subscriptions of all sessions, indexed for routing and per session.
 *
 * Destination patterns are token lists (`/a.b` → ['a', 'b']): `*` matches
 * exactly one name, `**` matches all remaining names (also none) and ends the
 * pattern. Matching walks a trie, so its cost depends on the destination
 * depth and the number of matches, not on the number of subscriptions.
 *
 * A subscription is an object with at least `id`, `sessionId` and `tokens`;
 * the registry adds a private `seq` so that matches come back in
 * subscription order.
 */
function SubscriptionRegistry() {
  this._root = new Node(null, null);
  // sessionId -> Map(subscription id -> subscription)
  this._sessions = new Map();
  // all subscriptions, in subscription order
  this._all = new Set();
  // subscription -> {node, set} where it is stored in the trie
  this._placement = new Map();
  this._seq = 0;
}

/** Number of subscriptions */
Object.defineProperty(SubscriptionRegistry.prototype, 'size', {
  get: function () {
    return this._all.size;
  }
});

/** All subscriptions, in subscription order */
SubscriptionRegistry.prototype.all = function () {
  return Array.from(this._all);
};

/** @return {object|undefined} subscription `id` of session `sessionId` */
SubscriptionRegistry.prototype.get = function (sessionId, id) {
  var subs = this._sessions.get(sessionId);
  return subs === undefined ? undefined : subs.get(id);
};

/** Number of subscriptions of a session */
SubscriptionRegistry.prototype.countSession = function (sessionId) {
  var subs = this._sessions.get(sessionId);
  return subs === undefined ? 0 : subs.size;
};

/**
 * Add a subscription. Its id must not be in use by the same session.
 *
 * @param {{id: string, sessionId: string, tokens: string[]}} sub
 */
SubscriptionRegistry.prototype.add = function (sub) {
  var subs = this._sessions.get(sub.sessionId);
  if (subs === undefined) {
    subs = new Map();
    this._sessions.set(sub.sessionId, subs);
  } else if (subs.has(sub.id)) {
    throw new Error('Subscription id ' + sub.id + ' is already in use');
  }

  var node = this._root;
  var set = null;
  for (var i = 0; i < sub.tokens.length && set === null; i++) {
    var token = sub.tokens[i];
    if (token === '**') {
      set = node.rest;
    } else if (token === '*') {
      node = node.star || (node.star = new Node(node, '*'));
    } else {
      var child = node.children.get(token);
      if (child === undefined) {
        child = new Node(node, token);
        node.children.set(token, child);
      }
      node = child;
    }
  }
  if (set === null) {
    set = node.subs;
  }

  Object.defineProperty(sub, 'seq', {value: ++this._seq, configurable: true});
  set.add(sub);
  this._placement.set(sub, {node: node, set: set});
  subs.set(sub.id, sub);
  this._all.add(sub);
};

/**
 * Remove subscription `id` of session `sessionId`.
 *
 * @return {object|undefined} the removed subscription
 */
SubscriptionRegistry.prototype.remove = function (sessionId, id) {
  var subs = this._sessions.get(sessionId);
  var sub = subs === undefined ? undefined : subs.get(id);
  if (sub === undefined) {
    return undefined;
  }
  subs.delete(id);
  if (subs.size === 0) {
    this._sessions.delete(sessionId);
  }
  this._unlink(sub);
  return sub;
};

/**
 * Remove all subscriptions of a session.
 *
 * @return {object[]} the removed subscriptions
 */
SubscriptionRegistry.prototype.removeSession = function (sessionId) {
  var subs = this._sessions.get(sessionId);
  if (subs === undefined) {
    return [];
  }
  this._sessions.delete(sessionId);
  var removed = Array.from(subs.values());
  for (var i = 0; i < removed.length; i++) {
    this._unlink(removed[i]);
  }
  return removed;
};

/** Take a subscription out of the trie and the ordered set, prune empty nodes */
SubscriptionRegistry.prototype._unlink = function (sub) {
  var placement = this._placement.get(sub);
  this._placement.delete(sub);
  this._all.delete(sub);
  placement.set.delete(sub);
  var node = placement.node;
  while (node.parent !== null && node.isEmpty()) {
    if (node.key === '*') {
      node.parent.star = null;
    } else {
      node.parent.children.delete(node.key);
    }
    node = node.parent;
  }
};

/**
 * Subscriptions whose pattern matches a destination, in subscription order.
 *
 * @param {string[]} tokens tokenized destination
 * @return {object[]}
 */
SubscriptionRegistry.prototype.match = function (tokens) {
  var result = [];
  collect(this._root, tokens, 0, result);
  if (result.length > 1) {
    result.sort(function (a, b) {
      return a.seq - b.seq;
    });
  }
  return result;
};

function collect(node, tokens, i, result) {
  node.rest.forEach(function (sub) {
    result.push(sub);
  });
  if (i === tokens.length) {
    node.subs.forEach(function (sub) {
      result.push(sub);
    });
    return;
  }
  var child = node.children.get(tokens[i]);
  if (child !== undefined) {
    collect(child, tokens, i + 1, result);
  }
  if (node.star !== null) {
    collect(node.star, tokens, i + 1, result);
  }
}

module.exports = SubscriptionRegistry;
