/** Default ms a closing connection gets to finish its close handshake when the transport closes */
var CLOSE_GRACE = 2000;

/**
 * Open connections of a transport, to wait for them when it closes.
 *
 * @param {number} [grace] ms to wait before `onTimeout` is called for the
 *   connections that are still open
 */
function tracker(grace) {
  var open = new Set();
  var waiters = [];

  function notify() {
    if (open.size === 0) {
      var done = waiters;
      waiters = [];
      done.forEach(function (resolve) {
        resolve();
      });
    }
  }

  return {
    add: function (connection) {
      open.add(connection);
    },
    remove: function (connection) {
      open.delete(connection);
      notify();
    },
    forEach: function (fn) {
      Array.from(open).forEach(fn);
    },
    /**
     * Resolves once every connection is closed. Connections still open after
     * the grace time are passed to `onTimeout` (e.g. to terminate them).
     */
    closed: function (onTimeout) {
      if (open.size === 0) {
        return Promise.resolve();
      }
      return new Promise(function (resolve) {
        var timer = setTimeout(function () {
          Array.from(open).forEach(onTimeout);
          // nothing more to wait for when onTimeout couldn't close them
          open.clear();
          notify();
        }, grace === undefined ? tracker.CLOSE_GRACE : grace);
        // shutting down must not keep the process alive
        timer.unref();
        waiters.push(function () {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };
}

tracker.CLOSE_GRACE = CLOSE_GRACE;

module.exports = tracker;
