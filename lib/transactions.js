var StompError = require('./errors').StompError;

/** Bytes of a body counted against the transaction limit */
function bodySize(body) {
  if (body === undefined || body === null) {
    return 0;
  }
  return Buffer.isBuffer(body) ? body.length : Buffer.byteLength(String(body));
}

/**
 * Open transactions of one connection: SEND frames are buffered per
 * transaction until COMMIT (returns them for delivery) or ABORT (drops them).
 *
 * @param {number} maxTransactions open transactions at the same time
 * @param {number} maxBytes body bytes buffered in all open transactions
 */
function Transactions(maxTransactions, maxBytes) {
  this.maxTransactions = maxTransactions;
  this.maxBytes = maxBytes;
  this._open = new Map();
  this._bytes = 0;
}

/** Number of open transactions */
Object.defineProperty(Transactions.prototype, 'size', {
  get: function () {
    return this._open.size;
  }
});

Transactions.prototype.has = function (id) {
  return this._open.has(id);
};

Transactions.prototype._get = function (id) {
  var tx = this._open.get(id);
  if (tx === undefined) {
    throw new StompError('Unknown transaction ' + id);
  }
  return tx;
};

Transactions.prototype.begin = function (id) {
  if (this._open.has(id)) {
    throw new StompError('Transaction ' + id + ' is already open');
  }
  if (this._open.size >= this.maxTransactions) {
    throw new StompError('Too many open transactions');
  }
  this._open.set(id, {items: [], bytes: 0});
};

/**
 * Buffer a message of transaction `id`.
 *
 * @param {string} id transaction id
 * @param {*} item what COMMIT returns for this message
 * @param {string|Buffer} body message body, counted against maxBytes
 */
Transactions.prototype.add = function (id, item, body) {
  var tx = this._get(id);
  var size = bodySize(body);
  if (this._bytes + size > this.maxBytes) {
    throw new StompError('Too much data in open transactions');
  }
  tx.items.push(item);
  tx.bytes += size;
  this._bytes += size;
};

/** Close transaction `id` and return its buffered items, in order */
Transactions.prototype.commit = function (id) {
  var tx = this._get(id);
  this._close(id, tx);
  return tx.items;
};

/** Close transaction `id`, dropping its buffered items */
Transactions.prototype.abort = function (id) {
  this._close(id, this._get(id));
};

Transactions.prototype._close = function (id, tx) {
  this._open.delete(id);
  this._bytes -= tx.bytes;
};

/** Drop all open transactions (connection closed) */
Transactions.prototype.clear = function () {
  this._open.clear();
  this._bytes = 0;
};

module.exports = Transactions;
