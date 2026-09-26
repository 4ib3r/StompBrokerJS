# Step 2 — Streaming, binary-safe parser

**Release:** 2.0.0 · **Size:** M (2–3 days) · **Depends on:** step 1

## As implemented

Differences from the design below, decided while implementing:

- **Body type follows the WebSocket message type** instead of "always a
  `Buffer` + `bodyText()`": frames received in text messages have a string
  body, frames with any part received in a binary message have a `Buffer`
  body. Middleware that reads text bodies keeps working; only binary bodies
  change (they were corrupted strings before). MESSAGE frames are sent as text
  for string bodies and binary for `Buffer` bodies, as before.
- **Unknown escape sequences are kept verbatim** (not a protocol error, P8
  not changed): stompjs 2.x doesn't escape header values, so a value like
  `C:\temp` would otherwise close the connection.
- **Forbidden header characters:** NUL (raw) and CR (raw or `\r`) are
  rejected; LF is allowed through the `\n` escape and escaped again on output
  (1.1) or the header is left out (1.0). Headers that can't be written
  safely are left out by the serializer; so are headers with `undefined` /
  `null` values.
- **Invalid JSON for server-side subscribers** is passed on as text and logged
  with `debug`, not emitted as `error` (it is client data, not a broker
  failure).
- **Frame size:** a decoder limit of 100 MiB (same as the ws `maxPayload`
  default) bounds data buffered for one frame; configurable limits stay in
  step 3.
- **Changelog** goes into the existing "Unreleased" section of `README.MD`.
- **Performance:** single decode path for text and binary. Parsing a typical
  small SEND frame runs at ~0.8 M frames/s vs ~1.3 M frames/s for the old
  (incorrect) string parser on one core (Node 22). The gap is the UTF-8
  encoding of text messages, required to count `content-length` in bytes; a
  second string-only path was not worth the extra bug surface. The 10 %
  criterion below is not met.
- Pipelined frames after a CONNECT in the same WebSocket message are rejected
  with "Not connected" when the connect middleware is asynchronous (the
  CONNECT isn't accepted yet when they are dispatched). Clients wait for
  CONNECTED, so this is not expected to matter.

## Goal

Every byte a client sends is decoded into exactly the frames it contains, and
every frame the broker writes is well-formed, whatever the chunking, encoding
or header content.

## Problems addressed

| # | Problem | Where |
|---|---|---|
| P1 | Only the first frame of a WebSocket message is parsed, the rest is dropped; a frame split across messages is dispatched truncated. `stompjs` 2.x splits every frame > 16 KB (`maxWebSocketFrameSize`), so large messages from the most common JS client are cut. | `lib/stomp-utils.js` `parseFrame`, `stompServer.js` `parseRequest` |
| P2 | Buffer bodies are always decoded as UTF-8 (`FF 00 80` → 7 bytes of U+FFFD) | `lib/stomp-utils.js` `readBody` |
| P3 | Header names/values are unescaped on input and written back unescaped for names (and for 1.0 sessions entirely); NUL/CR never escaped → injected `subscription`/`destination` headers and forged frames | `lib/stomp-utils.js` `addHeader`, `lib/frame.js` `toStringOrBuffer` |
| P4 | JSON bodies parsed in `parseRequest` and re-stringified on send: precision loss, key order/whitespace changes, `JSON.parse('')` closes the connection; `application/json;charset=utf-8` not recognised | `stompServer.js` `frameParser` / `frameSerializer` |
| P5 | Header keys and values `trim()`med (whitespace is significant in 1.1+) | `lib/stomp-utils.js` `addHeader` |
| P6 | `STOMP` frames unescaped but `CONNECT` not | `lib/frame.js` `RAW_HEADER_COMMANDS` |
| P7 | Frame without headers serialized with an extra LF in the body | `lib/frame.js` `toStringOrBuffer` |
| P8 | Undefined escape sequences tolerated (fatal per spec) | `lib/stomp-utils.js` `unescapeHeaderValue` |
| P9 | `bytes_message` pseudo-header injected into headers and stripped later | `lib/stomp-utils.js`, `stompServer.js` `RESERVED_HEADERS` |

## Design

### `lib/parser.js` — `FrameDecoder`

One instance per connection, created in the `connection` handler.

```js
const decoder = new FrameDecoder({version: () => session.version});
const frames = decoder.push(chunk);   // chunk: Buffer | string → Frame[]
decoder.pending;                      // bytes buffered for an incomplete frame
decoder.reset();
```

- Internally everything is a `Buffer`; string input → `Buffer.from(s, 'utf8')`.
  This is also what `ws` ≥ 8 delivers (step 5), so no second rewrite.
- Keep a list of pending chunks and concatenate lazily (only when a frame
  boundary spans chunks) to avoid O(n²) copying on many small chunks.
- State machine per frame:
  1. skip EOLs (`\n`, `\r\n`) — heart-beats; report them so the caller can
     refresh the heart-beat clock even when no frame completes;
  2. `COMMAND` line; must match `/^[A-Z]+$/` else protocol error;
  3. header lines until an empty line;
  4. body: with `content-length` → wait until `len + 1` bytes are available,
     byte at `len` must be `\0` else protocol error; without it → up to the
     first `\0`;
  5. emit, continue with the remaining bytes (multiple frames per chunk).
- An incomplete frame is kept for the next `push()`; nothing is dispatched
  until the frame is complete.
- Protocol errors throw `ProtocolError` (new, `lib/errors.js`) — the caller
  sends ERROR and closes.

### Headers

- Split on the first `:`; no trimming; strip only a trailing `\r`.
- Unescape name and value unless the command is `CONNECT`, `STOMP` or
  `CONNECTED`, or the session is 1.0. `STOMP` is defined by the spec as an
  alias of `CONNECT`, and clients send identical headers for both, so a
  passcode containing `\` must decode the same way (P6). Add `STOMP` to
  `RAW_HEADER_COMMANDS` and test both commands with the same headers.
- Escapes: `\\`, `\n`, `\c`; `\r` only when the session is 1.2 (1.1 → error).
  Any other escape → `ProtocolError` (P8).
- After unescaping, reject NUL in names and values, and CR/LF in values
  (P3). Names with `:` are allowed (escaped as `\c`).
- Headers map: `Object.create(null)`; first occurrence of a repeated header
  wins (existing behaviour, spec-mandated).
- Remove `bytes_message` (P9).

### `Frame`

- `body` is always a `Buffer` (or `null`); add `bodyText()` (cached UTF-8
  decode) and `isText()` (valid UTF-8 check via `TextDecoder('utf-8',
  {fatal: true})`, cached).
- Add `binary` flag: set when the frame arrived as a binary WebSocket message
  (ws 5: `Buffer` input; ws 8: `isBinary`).
- Move methods to the prototype.

### Serializer (`lib/frame.js`)

- Header block built as `command + '\n' + (name:value + '\n')* + '\n'`
  (fixes P7).
- 1.1+: escape names **and** values (`\\`, `\n`, `\c`, and `\r` for 1.2).
- 1.0: no escape mechanism → drop headers whose name or value contains
  `\n`, `\r` or `\0`, and `debug()` it.
- Output: send as text (`string`) when the body is valid UTF-8 and the source
  frame was not binary; otherwise a `Buffer`. Keeps browser clients that
  expect text frames working.

### Wiring (`stompServer.js`)

- `connection`: `ws.decoder = new FrameDecoder(...)` (moves into `Session` in
  step 5).
- `parseRequest(socket, data)`: refresh heart-beat clock, then
  `for (const frame of socket.decoder.push(data)) dispatch(frame)`. On
  `ProtocolError`: ERROR + close, stop processing the rest of the chunk.
- Stop dispatching once the socket is closed (a chunk may contain frames after
  DISCONNECT).

### JSON (P4)

- Delete `frameParser` from the inbound path; bodies are relayed as received.
- `frameSerializer` only applies to server-side `send()` with a non-string,
  non-Buffer body and `application/json` content type.
- Decode JSON only when delivering to server-side `subscribe()` callbacks,
  inside `try/catch`; on failure pass the text and emit `error`.
- Content-type check via media type: `type.split(';')[0].trim().toLowerCase()
  === 'application/json'`.

## Tasks

- [ ] `lib/errors.js`: `StompError`, `ProtocolError`
- [ ] `lib/parser.js`: `FrameDecoder` + unit tests (write the tests first)
- [ ] `lib/frame.js`: prototype methods, Buffer body, `bodyText()`,
      `isText()`, `binary`, fixed serializer and escaping
- [ ] `lib/stomp-utils.js`: remove `parseFrame`, `readBody`, `addHeader`
      (keep a thin deprecated `parseFrame` wrapper over `FrameDecoder` for
      one release — it is reachable via `require('stomp-broker-js/lib/…')`)
- [ ] `stompServer.js`: per-socket decoder, dispatch loop, JSON only for
      server-side subscribers, remove `bytes_message` from `RESERVED_HEADERS`
- [ ] `lib/stomp.js`: SEND handler passes `Buffer` body; middleware receives
      `args.frame` with `bodyText()`
- [ ] `CHANGELOG.md` (new) + README "Message bodies" section

## Tests

New `test/parser.test.js`:

- two / three frames in one chunk; frame + heart-beat EOLs interleaved
- one frame split into 2, 3, and 1-byte chunks; split inside a multi-byte
  UTF-8 character, inside `\r\n`, inside `content-length` body, right before
  the NUL
- `content-length` body containing `\0`; missing NUL after `content-length`
  → `ProtocolError`
- binary body `FF 00 80` round-trips byte-for-byte, `content-length: 3`
- header whitespace preserved (`foo: bar ` → `' bar '`)
- repeated header: first wins
- escapes: all valid ones; `\t` → error; `\r` in 1.1 → error, in 1.2 → CR
- injection: name `x\nsubscription\cHACK\0MESSAGE…` → `ProtocolError`
- serializer: no-header frame has no stray LF; 1.1 escapes names and
  values; 1.0 drops headers with control characters
- property/fuzz test: 10 000 random frames (random headers incl. escapes,
  random binary bodies, with/without `content-length`) concatenated and split
  at random offsets → decoded frames equal the originals

Integration (`test/broker.test.js`):

- 100 KB body sent in 16 KB WebSocket messages (what stompjs does) is
  delivered intact — the regression test for P1
- binary SEND is received as binary MESSAGE with identical bytes
- text SEND is received as a text WebSocket message
- JSON: body relayed byte-identical (large integer, custom whitespace);
  empty JSON body does not close the connection; server-side subscriber gets
  the parsed object; `application/json; charset=utf-8` recognised

Existing tests to update:

- `unit.test.js` "marks frames with content-length as bytes_message" → delete
- `unit.test.js` "falls back to NULL terminator when content-length exceeds
  the data" → now "waits for more data"
- `broker.test.js` "forwards application/json bodies to clients as JSON text"
  → asserts the original bytes

## Acceptance criteria

- All of the above pass on Node 20/22/24; coverage ≥ 95 %.
- Fuzz test runs in < 2 s.
- Micro-benchmark (`bench/parse.js`, not in CI): decoding 100 k small frames
  is not slower than the current parser by more than 10 %.

## Compatibility / changelog

- Middleware and `send` event: `frame.body` is now a `Buffer`; use
  `frame.bodyText()` for a string. **Observable** — documented.
- Server-side `subscribe()` callbacks: unchanged for text and JSON; binary
  bodies are now delivered as `Buffer` instead of a corrupted string.
- Malformed frames that were silently accepted now produce ERROR + close.

## Risks

- Browser clients relying on MESSAGE always being a text frame: mitigated by
  text-when-valid-UTF-8.
- Performance of `Buffer.concat` on fragmented input: mitigated by lazy
  concatenation; covered by the benchmark.
