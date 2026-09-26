// Compile-time checks of stompServer.d.ts (`npm run typecheck`), not run by mocha.
import http = require('http');
import StompServer = require('../../stompServer');

const server = http.createServer();
const stompServer = new StompServer({
  server: server,
  path: '/stomp',
  heartbeat: [10000, 10000],
  limits: { maxFrameSize: 64 * 1024, connectTimeout: Infinity },
  slowConsumerPolicy: 'close',
  debug: console.log
});
new StompServer({ protocol: 'sockjs', server: server });
new StompServer({ protocolConfig: { noServer: true } });

// @ts-expect-error unknown protocol
new StompServer({ server: server, protocol: 'tcp' });
// @ts-expect-error unknown limit
new StompServer({ server: server, limits: { maxFoo: 1 } });
// @ts-expect-error heartbeat is a pair
new StompServer({ server: server, heartbeat: [1000] });

const maxFrameSize: number = stompServer.conf.limits.maxFrameSize;
void maxFrameSize;

// server-side subscriptions and send
interface Reading { value: number }
const subId: string = stompServer.subscribe<Reading>('/sensors.**', function (msg, headers) {
  const value: number = msg.value;
  const destination: string = headers.destination;
  const subscription: string = headers.subscription;
  void value; void destination; void subscription;
});
stompServer.subscribe('/test', undefined, { id: 'mine' });
stompServer.on(subId, function (msg: unknown, headers) {
  void msg; void headers['message-id'];
});
stompServer.send('/test', {}, 'text');
stompServer.send('/test', { 'content-type': 'application/json' }, { a: 1 });
stompServer.send('/test', {}, Buffer.from([1, 2]));
stompServer.unsubscribe(subId);
stompServer.subscribes.forEach(function (sub) {
  const topic: string = sub.topic;
  void topic;
});

// events
stompServer.on('connecting', function (sessionId) { const s: string = sessionId; void s; });
stompServer.on('connected', function (sessionId, headers) { void sessionId; void headers.login; });
stompServer.on('disconnected', function (sessionId) { void sessionId; });
stompServer.on('subscribe', function (sub) {
  const version: StompServer.StompVersion | undefined = sub.socket && sub.socket.version;
  void version;
});
stompServer.on('unsubscribe', function (sub) { void sub.id; });
stompServer.on('send', function (ev) { void ev.dest; void ev.frame.headers; });
stompServer.on('slowConsumer', function (info) { void info.messageId; });
stompServer.once('error', function (err) { const e: Error = err; void e; });
stompServer.on('connected', function (sessionId, headers) {
  // @ts-expect-error `connected` gets a session id string
  const n: number = sessionId;
  void n; void headers;
});

// middleware
stompServer.addMiddleware('connect', function (socket, args, next) {
  void socket.sessionId;
  return Promise.resolve(args.headers.passcode === 'secret').then(function (ok) {
    return ok ? next() : false;
  });
});
const onSubscribe: StompServer.Middleware<'subscribe'> = function (socket, args, next) {
  const ack: StompServer.AckMode = args.ack;
  void ack;
  if (args.dest.indexOf('/private') === 0) {
    throw new StompServer.StompError('Access denied');
  }
  if (socket.state !== 'CONNECTED') {
    socket.close();
  }
  return next();
};
stompServer.addMiddleware('subscribe', onSubscribe);
stompServer.removeMiddleware('subscribe', onSubscribe);
stompServer.setMiddleware('send', function (socket, args, next) {
  const body: string | Buffer = args.frame.body;
  void body; void socket.sessionId; void args.transaction;
  return next();
});
stompServer.addMiddleware('unsubscribe', function (socket, subscriptionId, next) {
  const id: string = subscriptionId;
  void id;
  return next();
});
stompServer.addMiddleware('ack', function (socket, args, next) {
  const messageId: string = args.messageId;
  void messageId;
  return next();
});
stompServer.addMiddleware('begin', function (socket, args, next) {
  void args.transaction;
  return next();
});
stompServer.addMiddleware('disconnect', function (socket, receipt, next) {
  const r: string | undefined = receipt;
  void r;
  return next();
});
// @ts-expect-error no middleware for this command
stompServer.addMiddleware('conect', function (socket: unknown, args: unknown, next: () => unknown) { return next(); });

// errors
const err = new StompServer.StompError('rejected');
const isError: boolean = err instanceof Error;
void isError;

// noServer upgrades
server.on('upgrade', function (request, socket, head) {
  const transport = stompServer.socket;
  if (transport.handleUpgrade) {
    transport.handleUpgrade(request, socket, head, function (ws) {
      transport.emit && transport.emit('connection', ws, request);
    });
  }
});
