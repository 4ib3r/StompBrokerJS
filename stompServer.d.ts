// Type definitions for stomp-broker-js
// Hand-written; keep in sync with stompServer.js and the README.

/// <reference types="node" />

import { EventEmitter } from 'events';
import type { IncomingMessage, Server as HttpServer } from 'http';
import type { Server as HttpsServer } from 'https';
import type { Duplex } from 'stream';

export = StompServer;

/**
 * Embedded STOMP 1.0 / 1.1 broker for http servers (WebSocket or SockJS).
 *
 * @example
 * import StompServer = require('stomp-broker-js');
 * const stompServer = new StompServer({ server: httpServer });
 */
declare class StompServer extends EventEmitter {
  constructor(config?: StompServer.ServerConfig);

  /** Effective configuration, defaults applied */
  readonly conf: StompServer.ResolvedConfig;

  /**
   * Transport server: a `ws` WebSocketServer (`protocol: 'ws'`) or the SockJS
   * adapter. With `protocolConfig.noServer` use `handleUpgrade` and
   * `emit('connection', ws, request)` to hand over upgraded connections.
   */
  readonly socket: StompServer.TransportServer;

  /** All subscriptions (read-only snapshot, in subscription order) */
  readonly subscribes: StompServer.Subscription[];

  /** Registered middleware, by lower-case command */
  readonly middleware: { [C in StompServer.MiddlewareCommand]?: StompServer.Middleware<C>[] };

  /** Add middleware for a command, after the ones already registered */
  addMiddleware<C extends StompServer.MiddlewareCommand>(command: C, handler: StompServer.Middleware<C>): void;

  /** Replace all middleware of a command with `handler` */
  setMiddleware<C extends StompServer.MiddlewareCommand>(command: C, handler: StompServer.Middleware<C>): void;

  /** Remove a middleware function registered for a command */
  removeMiddleware<C extends StompServer.MiddlewareCommand>(command: C, handler: StompServer.Middleware<C>): void;

  /**
   * Server-side subscription. Wildcards (`*`, `**`) are supported.
   *
   * @param headers `id` chooses the subscription id (must be unused)
   * @returns subscription id; messages are also emitted as events named by it
   */
  subscribe<T = any>(
    topic: string,
    callback?: StompServer.OnSubscribedMessageCallback<T>,
    headers?: { id?: string }
  ): string;

  /**
   * Remove a server-side subscription and its listeners.
   *
   * @returns whether the subscription existed (or a Promise of it, with async `unsubscribe` middleware)
   */
  unsubscribe(id: string): boolean | Promise<boolean>;

  /**
   * Publish a message to the subscribers of `topic` (not to server-side subscriptions).
   * An object body is serialized to JSON when `content-type` is `application/json`.
   */
  send(topic: string, headers?: StompServer.StompHeaders, body?: string | Buffer | object): void;

  /** Serialize an object body of an application/json frame to JSON text */
  frameSerializer(frame: StompServer.MsgFrame): StompServer.MsgFrame;

  /**
   * Parse the text body of an application/json frame to an object.
   * @deprecated no longer applied to incoming frames
   */
  frameParser(frame: StompServer.MsgFrame): StompServer.MsgFrame;

  on<E extends keyof StompServer.StompServerEvents>(event: E, listener: StompServer.StompServerEvents[E]): this;
  /** Messages of the server-side subscription with this id */
  on(subscriptionId: string, listener: StompServer.OnSubscribedMessageCallback): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;

  once<E extends keyof StompServer.StompServerEvents>(event: E, listener: StompServer.StompServerEvents[E]): this;
  once(subscriptionId: string, listener: StompServer.OnSubscribedMessageCallback): this;
  once(event: string | symbol, listener: (...args: any[]) => void): this;

  addListener<E extends keyof StompServer.StompServerEvents>(event: E, listener: StompServer.StompServerEvents[E]): this;
  addListener(subscriptionId: string, listener: StompServer.OnSubscribedMessageCallback): this;
  addListener(event: string | symbol, listener: (...args: any[]) => void): this;

  off<E extends keyof StompServer.StompServerEvents>(event: E, listener: StompServer.StompServerEvents[E]): this;
  off(subscriptionId: string, listener: StompServer.OnSubscribedMessageCallback): this;
  off(event: string | symbol, listener: (...args: any[]) => void): this;

  removeListener<E extends keyof StompServer.StompServerEvents>(event: E, listener: StompServer.StompServerEvents[E]): this;
  removeListener(subscriptionId: string, listener: StompServer.OnSubscribedMessageCallback): this;
  removeListener(event: string | symbol, listener: (...args: any[]) => void): this;
}

declare namespace StompServer {
  /** Frame headers, name → value */
  interface StompHeaders {
    [name: string]: string;
  }

  type StompVersion = '1.0' | '1.1';

  type SessionState = 'OPEN' | 'CONNECTED' | 'DISCONNECTING' | 'CLOSED';

  type AckMode = 'auto' | 'client' | 'client-individual';

  type SlowConsumerPolicy = 'drop' | 'close';

  type Protocol = 'ws' | 'sockjs';

  /** Resource limits; sizes are bytes, times milliseconds. Each can be raised, or disabled with Infinity. */
  interface Limits {
    /** Bytes per frame (also the ws maxPayload default). Default 1048576 */
    maxFrameSize: number;
    /** Headers per frame. Default 64 */
    maxHeaders: number;
    /** Characters per header line. Default 8192 */
    maxHeaderLength: number;
    /** Subscriptions per connection. Default 256 */
    maxSubscriptions: number;
    /** Bytes queued for a connection before it counts as a slow consumer. Default 8388608 */
    maxBufferedAmount: number;
    /** Ms from opening the socket to the CONNECT frame. Default 10000 */
    connectTimeout: number;
    /** Open transactions per connection. Default 16 */
    maxTransactions: number;
    /** Body bytes buffered in the open transactions of a connection. Default 4194304 */
    maxTransactionBytes: number;
  }

  interface ServerConfig {
    /** Http server, required unless `protocolConfig.noServer` is set (ws only) */
    server?: HttpServer | HttpsServer;
    /** Name sent in the CONNECTED frame. Default `STOMP-JS/<version>` */
    serverName?: string;
    /** WebSocket path (SockJS prefix). Default `/stomp` */
    path?: string;
    /** [server sends every ms, server expects every ms], 0 disables. Default [0, 0] */
    heartbeat?: [number, number];
    /** Tolerance for late client heart-beats, ms. Default 1000 */
    heartbeatErrorMargin?: number;
    /** Debug logger */
    debug?: (...args: any[]) => void;
    /** Transport. Default `ws` */
    protocol?: Protocol;
    /** Extra options for the ws / sockjs server; they take precedence over broker defaults */
    protocolConfig?: { noServer?: boolean; [option: string]: unknown };
    /** Resource limits, unknown names are rejected */
    limits?: Partial<Limits>;
    /** What to do with a message for a slow consumer. Default `drop` */
    slowConsumerPolicy?: SlowConsumerPolicy;
  }

  interface ResolvedConfig {
    server: HttpServer | HttpsServer | undefined;
    serverName: string;
    path: string;
    heartbeat: [number, number];
    heartbeatErrorMargin: number;
    debug: (...args: any[]) => void;
    protocol: Protocol;
    protocolConfig: { noServer?: boolean; [option: string]: unknown };
    limits: Limits;
    slowConsumerPolicy: SlowConsumerPolicy;
  }

  /** Transport server (`ws` WebSocketServer or the SockJS adapter), see `StompServer#socket` */
  interface TransportServer {
    on(event: 'connection', listener: (connection: any, request?: IncomingMessage) => void): unknown;
    /** ws only */
    handleUpgrade?(request: IncomingMessage, socket: Duplex, head: Buffer, callback: (ws: any) => void): void;
    /** ws only */
    emit?(event: string, ...args: any[]): boolean;
  }

  /** A client connection, as passed to middleware and in subscriptions */
  interface Session {
    readonly sessionId: string;
    /** Negotiated STOMP version, undefined before CONNECT */
    readonly version: StompVersion | undefined;
    readonly state: SessionState;
    /** Bytes queued on the transport connection */
    readonly bufferedAmount: number;
    /** The transport is open */
    isOpen(): boolean;
    /** CONNECT was accepted */
    isConnected(): boolean;
    /** Commands of the session may still take effect (the transport hasn't closed) */
    isActive(): boolean;
    /** Close the connection from the server side */
    close(): void;
  }

  /** Stand-in for the server itself, passed to `send` / `unsubscribe` middleware for `send()` / `unsubscribe()` */
  interface ServerSelf {
    readonly sessionId: string;
  }

  interface Subscription {
    id: string;
    sessionId: string;
    /** Destination, may contain wildcards */
    topic: string;
    /** Tokenized destination */
    tokens: string[];
    /** The subscribing client; undefined for server-side subscriptions */
    socket?: Session;
  }

  /** Message frame object */
  interface MsgFrame<B = string | Buffer> {
    command?: string;
    headers: StompHeaders;
    body: B;
  }

  interface MessageHeaders extends StompHeaders {
    destination: string;
    subscription: string;
    'message-id': string;
  }

  /**
   * Message of a server-side subscription. `application/json` bodies are
   * decoded, binary bodies are Buffers, others strings.
   */
  type OnSubscribedMessageCallback<T = any> = (body: T, headers: MessageHeaders) => void;

  interface ConnectArgs {
    /** Client heart-beat header, parsed */
    heartbeat: [number, number];
    headers: StompHeaders;
  }

  interface SendArgs {
    dest: string;
    /** Frame as received; the body is not decoded (text, or Buffer for binary messages) */
    frame: MsgFrame;
    transaction?: string;
  }

  interface SubscribeArgs {
    dest: string;
    ack: AckMode;
    id: string;
  }

  interface TransactionArgs {
    transaction: string;
  }

  interface AckArgs {
    /** Undefined for STOMP 1.0 clients that leave it out */
    subscription: string | undefined;
    messageId: string;
    transaction: string | undefined;
  }

  interface MiddlewareTypes {
    connect: { socket: Session; args: ConnectArgs };
    /** args: receipt id of the DISCONNECT frame, undefined when the connection just closed */
    disconnect: { socket: Session; args: string | undefined };
    send: { socket: Session | ServerSelf; args: SendArgs };
    subscribe: { socket: Session; args: SubscribeArgs };
    /** args: subscription id */
    unsubscribe: { socket: Session | ServerSelf; args: string };
    begin: { socket: Session; args: TransactionArgs };
    commit: { socket: Session; args: TransactionArgs };
    abort: { socket: Session; args: TransactionArgs };
    ack: { socket: Session; args: AckArgs };
    nack: { socket: Session; args: AckArgs };
  }

  type MiddlewareCommand = keyof MiddlewareTypes;

  /** Truthy to accept the command, falsy to reject it; may be a Promise */
  type MiddlewareResult = unknown;

  /**
   * Return `next()` to continue the chain, or a falsy value to reject the
   * command. Throw (or reject with) a `StompError` to send its message to the client.
   */
  type Middleware<C extends MiddlewareCommand = MiddlewareCommand> = (
    socket: MiddlewareTypes[C]['socket'],
    args: MiddlewareTypes[C]['args'],
    next: () => MiddlewareResult
  ) => MiddlewareResult;

  interface SlowConsumerInfo {
    sessionId: string;
    subscription: string;
    destination: string;
    messageId: string;
  }

  interface SendEvent {
    dest: string;
    /** `application/json` bodies decoded, as for server-side subscribers */
    frame: { headers: StompHeaders; body: any };
  }

  interface StompServerEvents {
    /** Socket opened */
    connecting: (sessionId: string) => void;
    /** CONNECT accepted */
    connected: (sessionId: string, headers: StompHeaders) => void;
    disconnected: (sessionId: string) => void;
    subscribe: (subscription: Subscription) => void;
    unsubscribe: (subscription: Subscription) => void;
    /** Message published */
    send: (event: SendEvent) => void;
    /** A message was not delivered to a slow consumer */
    slowConsumer: (info: SlowConsumerInfo) => void;
    /** Emitted only when a listener is registered */
    error: (err: Error) => void;
  }

  /** Error whose message is sent to the client in an ERROR frame, e.g. thrown by middleware to reject a command */
  class StompError extends Error {
    constructor(message: string);
  }
}
