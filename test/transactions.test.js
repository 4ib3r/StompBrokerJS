/**
 * Transactions (BEGIN / COMMIT / ABORT), ACK / NACK and middleware commands.
 */
var assert = require('chai').assert;

var support = require('./support/raw-client');
var Transactions = require('../lib/transactions');
var StompError = require('../lib/errors').StompError;

var buildFrame = support.buildFrame;


describe('lib/transactions', function () {
  it('returns the messages of a committed transaction in order', function () {
    var txs = new Transactions(2, 100);
    txs.begin('t1');
    txs.add('t1', 'a', 'x');
    txs.add('t1', 'b', Buffer.from('yz'));
    assert.deepEqual(txs.commit('t1'), ['a', 'b']);
    assert.equal(txs.size, 0);
  });

  it('limits open transactions and buffered bytes', function () {
    var txs = new Transactions(1, 4);
    txs.begin('t1');
    assert.throws(function () {
      txs.begin('t2');
    }, StompError, /Too many open transactions/);
    txs.add('t1', 'a', 'abcd');
    assert.throws(function () {
      txs.add('t1', 'b', 'e');
    }, StompError, /Too much data/);
    txs.abort('t1');
    txs.begin('t2');
    txs.add('t2', 'c', 'abcd');
  });

  it('rejects unknown and duplicate transactions', function () {
    var txs = new Transactions(2, 100);
    ['commit', 'abort'].forEach(function (method) {
      assert.throws(function () {
        txs[method]('nope');
      }, StompError, /Unknown transaction nope/);
    });
    assert.throws(function () {
      txs.add('nope', 'a', '');
    }, StompError, /Unknown transaction/);
    txs.begin('t1');
    assert.throws(function () {
      txs.begin('t1');
    }, StompError, /already open/);
  });

  it('drops everything on clear', function () {
    var txs = new Transactions(2, 4);
    txs.begin('t1');
    txs.add('t1', 'a', 'abcd');
    txs.clear();
    assert.equal(txs.size, 0);
    txs.begin('t1');
    txs.add('t1', 'a', 'abcd');
  });
});


describe('Transactions and acknowledgements', function () {
  var ctx = support.useBroker();

  function connectedClient(headers) {
    var client = ctx.client();
    return client.connect(headers).then(function () {
      return client;
    });
  }

  /** Connected sender and a receiver subscribed to /t as s1 */
  function pair(config) {
    return ctx.start(config).then(function () {
      return Promise.all([connectedClient(), connectedClient()]);
    }).then(function (clients) {
      return clients[1].subscribe('/t', 's1').then(function () {
        return {sender: clients[0], receiver: clients[1]};
      });
    });
  }

  function bodies(client) {
    return client.messages().map(function (m) {
      return m.body;
    });
  }

  function expectError(client, text) {
    return client.waitForCommand('ERROR').then(function (error) {
      assert.equal(error.body, text);
      return client.waitForClose();
    });
  }


  describe('transactions', function () {
    it('delivers transactional messages only on COMMIT, in order', function () {
      var p;
      return pair().then(function (clients) {
        p = clients;
        return p.sender.sendWithReceipt('BEGIN', {transaction: 'tx1'});
      }).then(function (reply) {
        assert.equal(reply.command, 'RECEIPT');
        p.sender.send('SEND', {destination: '/t', transaction: 'tx1'}, 'one');
        p.sender.send('SEND', {destination: '/t', transaction: 'tx1'}, 'two');
        return p.sender.flush();
      }).then(function () {
        return p.receiver.flush();
      }).then(function () {
        assert.deepEqual(bodies(p.receiver), [], 'nothing before COMMIT');
        return p.sender.sendWithReceipt('COMMIT', {transaction: 'tx1'});
      }).then(function (reply) {
        assert.equal(reply.command, 'RECEIPT');
        return p.receiver.waitFor(function (f) {
          return f.command === 'MESSAGE' && f.body === 'two';
        });
      }).then(function () {
        assert.deepEqual(bodies(p.receiver), ['one', 'two']);
        assert.isUndefined(p.receiver.messages()[0].headers.transaction, 'transaction header not forwarded');
      });
    });

    it('delivers nothing of an aborted transaction', function () {
      var p;
      return pair().then(function (clients) {
        p = clients;
        p.sender.send('BEGIN', {transaction: 'tx1'});
        p.sender.send('SEND', {destination: '/t', transaction: 'tx1'}, 'dropped');
        return p.sender.sendWithReceipt('ABORT', {transaction: 'tx1'});
      }).then(function (reply) {
        assert.equal(reply.command, 'RECEIPT');
        p.sender.send('SEND', {destination: '/t'}, 'after');
        return p.receiver.waitForCommand('MESSAGE');
      }).then(function () {
        assert.deepEqual(bodies(p.receiver), ['after']);
      });
    });

    it('delivers non-transactional messages sent during a transaction immediately', function () {
      var p;
      return pair().then(function (clients) {
        p = clients;
        p.sender.send('BEGIN', {transaction: 'tx1'});
        p.sender.send('SEND', {destination: '/t', transaction: 'tx1'}, 'later');
        p.sender.send('SEND', {destination: '/t'}, 'now');
        return p.receiver.waitForCommand('MESSAGE');
      }).then(function () {
        p.sender.send('COMMIT', {transaction: 'tx1'});
        return p.receiver.waitFor(function (f) {
          return f.command === 'MESSAGE' && f.body === 'later';
        });
      }).then(function () {
        assert.deepEqual(bodies(p.receiver), ['now', 'later']);
      });
    });

    it('runs send middleware when the transactional SEND arrives', function () {
      var p;
      var seen = [];
      return pair().then(function (clients) {
        p = clients;
        ctx.broker.addMiddleware('send', function (socket, args, next) {
          seen.push(args.transaction);
          return next();
        });
        p.sender.send('BEGIN', {transaction: 'tx1'});
        return p.sender.sendWithReceipt('SEND', {destination: '/t', transaction: 'tx1'}, 'x');
      }).then(function () {
        assert.deepEqual(seen, ['tx1']);
        return p.sender.sendWithReceipt('COMMIT', {transaction: 'tx1'});
      }).then(function () {
        assert.deepEqual(seen, ['tx1'], 'not run again on COMMIT');
      });
    });

    it('discards open transactions when the connection closes', function () {
      var p;
      var serverSocket;
      return pair().then(function (clients) {
        p = clients;
        p.sender.send('BEGIN', {transaction: 'tx1'});
        return p.sender.sendWithReceipt('SEND', {destination: '/t', transaction: 'tx1'}, 'x');
      }).then(function () {
        // the server side of the sender: the connection with an open transaction
        serverSocket = Array.from(ctx.broker._sessions.values()).filter(function (session) {
          return session.transactions.size > 0;
        })[0];
        assert.isTrue(serverSocket.transactions.has('tx1'));
        return new Promise(function (resolve) {
          ctx.broker.once('disconnected', resolve);
          p.sender.close();
        });
      }).then(function () {
        assert.equal(serverSocket.transactions.size, 0);
        return p.receiver.flush();
      }).then(function () {
        assert.lengthOf(p.receiver.messages(), 0);
      });
    });

    [
      ['BEGIN without transaction header', 'BEGIN', {}, 'BEGIN requires a transaction header'],
      ['COMMIT of an unknown transaction', 'COMMIT', {transaction: 'nope'}, 'Unknown transaction nope'],
      ['ABORT of an unknown transaction', 'ABORT', {transaction: 'nope'}, 'Unknown transaction nope'],
      ['SEND in an unknown transaction', 'SEND', {destination: '/t', transaction: 'nope'}, 'Unknown transaction nope']
    ].forEach(function (c) {
      it('rejects ' + c[0], function () {
        return ctx.start().then(function () {
          return connectedClient();
        }).then(function (client) {
          client.send(c[1], c[2]);
          return expectError(client, c[3]);
        });
      });
    });

    it('rejects a transaction id that is already open', function () {
      return ctx.start().then(function () {
        return connectedClient();
      }).then(function (client) {
        client.send('BEGIN', {transaction: 'tx1'});
        client.send('BEGIN', {transaction: 'tx1'});
        return expectError(client, 'Transaction tx1 is already open');
      });
    });

    it('limits open transactions per connection', function () {
      return ctx.start({limits: {maxTransactions: 2}}).then(function () {
        return connectedClient();
      }).then(function (client) {
        client.send('BEGIN', {transaction: 'a'});
        client.send('BEGIN', {transaction: 'b'});
        client.send('BEGIN', {transaction: 'c'});
        return expectError(client, 'Too many open transactions');
      });
    });

    it('limits data buffered in open transactions', function () {
      return ctx.start({limits: {maxTransactionBytes: 5}}).then(function () {
        return connectedClient();
      }).then(function (client) {
        client.send('BEGIN', {transaction: 'a'});
        client.send('SEND', {destination: '/t', transaction: 'a'}, 'abc');
        client.send('SEND', {destination: '/t', transaction: 'a'}, 'def');
        return expectError(client, 'Too much data in open transactions');
      });
    });

    it('rejects a transactional SEND without destination when it arrives', function () {
      return ctx.start().then(function () {
        return connectedClient();
      }).then(function (client) {
        client.send('BEGIN', {transaction: 'a'});
        client.send('SEND', {transaction: 'a'}, 'x');
        return expectError(client, 'Destination is required');
      });
    });
  });


  describe('ACK and NACK', function () {
    ['ACK', 'NACK'].forEach(function (command) {
      it('answers ' + command + ' with a RECEIPT and passes it to middleware', function () {
        var seen = [];
        var p;
        return pair().then(function (clients) {
          p = clients;
          ctx.broker.addMiddleware(command, function (socket, args, next) {
            seen.push(args);
            return next();
          });
          return p.receiver.sendWithReceipt(command, {subscription: 's1', 'message-id': 'm1'});
        }).then(function (reply) {
          assert.equal(reply.command, 'RECEIPT');
          assert.deepEqual(seen, [{subscription: 's1', messageId: 'm1', transaction: undefined}]);
        });
      });

      it('rejects ' + command + ' without message-id', function () {
        return pair().then(function (p) {
          p.receiver.send(command, {subscription: 's1'});
          return expectError(p.receiver, command + ' requires a message-id header');
        });
      });

      it('rejects ' + command + ' without subscription from a STOMP 1.1 client', function () {
        return pair().then(function (p) {
          p.receiver.send(command, {'message-id': 'm1'});
          return expectError(p.receiver, command + ' requires a subscription header');
        });
      });
    });

    it('rejects ACK for a subscription of another connection', function () {
      return pair().then(function (p) {
        p.sender.send('ACK', {subscription: 's1', 'message-id': 'm1'});
        return expectError(p.sender, 'No subscription s1');
      });
    });

    it('accepts ACK within an open transaction and rejects it for an unknown one', function () {
      var p;
      return pair().then(function (clients) {
        p = clients;
        p.receiver.send('BEGIN', {transaction: 'tx1'});
        return p.receiver.sendWithReceipt('ACK', {subscription: 's1', 'message-id': 'm1', transaction: 'tx1'});
      }).then(function (reply) {
        assert.equal(reply.command, 'RECEIPT');
        p.receiver.send('ACK', {subscription: 's1', 'message-id': 'm1', transaction: 'nope'});
        return expectError(p.receiver, 'Unknown transaction nope');
      });
    });

    it('accepts ACK with only message-id from a STOMP 1.0 client', function () {
      return ctx.start().then(function () {
        return connectedClient({'accept-version': '1.0'});
      }).then(function (client) {
        return client.sendWithReceipt('ACK', {'message-id': 'm1'});
      }).then(function (reply) {
        assert.equal(reply.command, 'RECEIPT');
      });
    });

    it('does not change delivery (at-most-once)', function () {
      var p;
      return pair().then(function (clients) {
        p = clients;
        return p.receiver.sendWithReceipt('NACK', {subscription: 's1', 'message-id': 'm1'});
      }).then(function () {
        return p.receiver.flush();
      }).then(function () {
        assert.lengthOf(p.receiver.messages(), 0, 'NACK does not redeliver');
      });
    });
  });


  describe('middleware commands', function () {
    it('throws for a command without middleware', function () {
      return ctx.start().then(function (broker) {
        ['conect', 'message', ''].forEach(function (command) {
          ['addMiddleware', 'setMiddleware', 'removeMiddleware'].forEach(function (method) {
            assert.throws(function () {
              broker[method](command, function () {});
            }, TypeError, /No middleware for command/, method + ' ' + command);
          });
        });
      });
    });

    it('accepts command names in any case', function () {
      return ctx.start().then(function (broker) {
        broker.addMiddleware('BEGIN', function () {});
        assert.lengthOf(broker.middleware.begin, 1);
      });
    });
  });


  it('handles a whole transaction sent in one WebSocket message', function () {
    var p;
    return pair().then(function (clients) {
      p = clients;
      p.sender.sendRaw(buildFrame('BEGIN', {transaction: 't'}) +
        buildFrame('SEND', {destination: '/t', transaction: 't'}, 'a') +
        buildFrame('SEND', {destination: '/t', transaction: 't'}, 'b') +
        buildFrame('COMMIT', {transaction: 't'}));
      return p.receiver.waitFor(function (f) {
        return f.command === 'MESSAGE' && f.body === 'b';
      });
    }).then(function () {
      assert.deepEqual(bodies(p.receiver), ['a', 'b']);
    });
  });
});
