# STOMP 1.1 compliance check

Implementation checked: `claude/project-worst-practices-ye8za2` at `4030762`
(master after steps 1–4 plus step 5a). Specification:
[STOMP 1.1](https://stomp.github.io/stomp-specification-1.1.html)
(source: `stomp/stomp-spec`, `src/stomp-specification-1.1.md`).

STOMP 1.1 is the highest version the broker negotiates today, so this is the
version clients actually get. The [1.2 check](stomp-1.2-compliance.md) covers
what is missing to offer 1.2.

Every behaviour marked 🔬 was confirmed by sending raw frames to a running
broker.

## Summary

- **Compliant with 1.1** for everything that matters in practice:
  - framing, escaping of `\n` `\c` `\\`, no trimming, `content-length`;
  - protocol negotiation, the `STOMP` frame, heart-beats;
  - SEND/SUBSCRIBE/UNSUBSCRIBE with required headers and ERROR on failure;
  - ACK/NACK with the 1.1 headers;
  - transactions, DISCONNECT, receipts;
  - MESSAGE and ERROR headers.
- **Two MUST-level deviations, both deliberate:**
  - [N1](#n1-undefined-escape-sequences-are-not-fatal): undefined escape sequences other than `\r` are kept verbatim, not treated as fatal.
  - [N2](#n2-carriage-return-in-headers): a raw CR is treated as part of a CRLF line ending, or rejected inside a header, although the 1.1 grammar allows CR in header values.
- **One SHOULD gap:** [S1](#s1-negotiation-error-without-version-header). The ERROR sent when there is no common version has no `version` header.
- **Not a 1.1 violation, but wrong:** [B1](stomp-1.2-compliance.md#b1-frames-received-before-a-disconnect-are-dropped).
  A SEND received before DISCONNECT is dropped when its async middleware
  finishes late. 1.1 only promises that the frames were *received*, but a
  graceful DISCONNECT exists precisely so that the client doesn't lose them.
- **Things 1.1 doesn't require, done anyway:**
  - every ERROR closes the connection (1.1 requires this only for failed SEND and SUBSCRIBE, and 1.2 always);
  - CRLF line endings are accepted;
  - DISCONNECT closes the connection after the RECEIPT.

Legend: ✅ compliant · ⚠️ deviation (SHOULD / lenient / equivalent) ·
❌ not compliant · — not applicable.

## Conformance matrix

| Spec section | Requirement | Level | Status | Notes |
|---|---|---|---|---|
| STOMP Frames | Command, header lines and the blank line end with LF; NUL may be followed by LFs | MUST | ✅ | CRLF is accepted too 🔬 (lenient, see [N2](#n2-carriage-return-in-headers)) |
| | Commands and header names are case sensitive | MUST | ✅ | `send` gets ERROR `Invalid command` 🔬 |
| Value Encoding | CONNECT and CONNECTED are not escaped, all other frames are | MUST | ⚠️ | `STOMP` frames are also left unescaped, like CONNECT ([D2](stomp-1.2-compliance.md#deliberate-deviations)) |
| | Decode `\n` `\c` `\\` | MUST | ✅ | |
| | Undefined escapes, e.g. `\r`, are a fatal protocol error | MUST | ⚠️ | `\r` gets ERROR plus close 🔬. Every other undefined escape (`\t`, `\x`) is kept verbatim 🔬 ([N1](#n1-undefined-escape-sequences-are-not-fatal)) |
| | Encode with the reverse transformation | MUST | ✅ | `\`, LF and `:` are escaped in names and values. A header containing CR or NUL is left out ([N2](#n2-carriage-return-in-headers)) |
| | Only SEND, MESSAGE and ERROR have a body | MUST (sender) | ✅ / ⚠️ | the server's own frames comply. A body on a client SUBSCRIBE is ignored 🔬 (lenient) |
| | Never trim or pad headers | MUST | ✅ | |
| Size Limits | On limit: ERROR, then disconnect | SHOULD | ✅ / ⚠️ | an oversized single WebSocket message is closed by ws without ERROR ([D5](stomp-1.2-compliance.md#deliberate-deviations)) |
| Repeated headers | The first entry wins | SHOULD | ✅ | |
| Connecting | Rejection: ERROR, then close | SHOULD | ✅ | |
| | Support clients that connect and disconnect rapidly | MUST | ✅ | |
| CONNECT or STOMP | Handle STOMP like CONNECT | SHOULD | ✅ | |
| | `accept-version`, `host` | MUST (client) | — | a missing `accept-version` means 1.0; `host` is ignored (no virtual hosts) |
| CONNECTED | `version` | MUST | ✅ | also `session` and `server` (`STOMP-JS/<version>`) |
| Protocol Negotiation | No `accept-version` means 1.0; use the highest common version | MUST | ✅ | |
| | No common version: ERROR similar to the example | SHOULD | ⚠️ | ERROR plus close, but no `version` header 🔬 ([S1](#s1-negotiation-error-without-version-header)) |
| Once Connected | Unknown frame: MAY answer ERROR | MAY | ✅ | ERROR plus close |
| SEND | `destination` required | MUST | ✅ | |
| | User headers passed through to MESSAGE | MUST | ✅ | only protocol headers are replaced or dropped |
| | Cannot process: ERROR, then disconnect | MUST | ✅ | |
| SUBSCRIBE | `destination` required | MUST | ✅ | ERROR `Destination is required` 🔬 |
| | `id` required, unique within the connection | MUST | ✅ | for 1.1 sessions; 1.0 sessions fall back to the destination |
| | `ack` is `auto` (default), `client` or `client-individual` | — | ✅ | validated |
| | client modes: MAY redeliver unacknowledged messages | MAY | ✅ | at-most-once delivery, documented |
| | Cannot create: ERROR, then disconnect | MUST | ✅ | |
| UNSUBSCRIBE | `id` must match a previous SUBSCRIBE | MUST | ✅ | unknown id gets ERROR. A missing id reads "No subscription undefined" 🔬; the text could be clearer |
| ACK | `message-id` and `subscription` required; `transaction` optional | MUST | ✅ | a missing `subscription` gets ERROR 🔬. The subscription must belong to the connection. `message-id` isn't checked against delivered messages (nothing is tracked) |
| NACK | Same headers as ACK | MUST | ✅ | |
| BEGIN / COMMIT / ABORT | `transaction` required | MUST | ✅ | |
| | Uncommitted transactions aborted on DISCONNECT or connection failure | MUST | ✅ | |
| DISCONNECT | RECEIPT on request; the client sends nothing after it | — | ✅ | later frames are ignored, then the connection is closed |
| content-length | Byte count, read exactly, then NUL; required if the body contains NUL | MUST | ✅ | MESSAGE and ERROR always carry it |
| content-type | SEND, MESSAGE and ERROR SHOULD carry it | SHOULD | ✅ / ⚠️ | ERROR `text/plain`; MESSAGE carries the sender's value if there was one |
| receipt | Any client frame except CONNECT; RECEIPT has an empty body | — | ✅ | `receipt` on CONNECT is ignored 🔬 |
| MESSAGE | `destination`, unique `message-id`, `subscription`, user headers | — | ✅ | no `ack` header, as 1.1 intends |
| RECEIPT | `receipt-id`, sent once the frame is processed | — | ✅ | |
| ERROR | `message` header; `receipt-id` for the failing frame | SHOULD | ✅ | 🔬 |
| Heart-beating | Two integers, missing means `0,0`, MAX negotiation, send a single LF, tolerate lateness | MUST / SHOULD | ✅ | malformed values get ERROR; capped at 2³¹−1 ms. CONNECTED carries the negotiated values ([D3](stomp-1.2-compliance.md#deliberate-deviations), equivalent result) |
| Augmented BNF | `header-name = 1*<any OCTET except LF or ":">`, `header-value = *<any OCTET except LF or ":">` | MUST | ⚠️ | an empty name gets ERROR ✅. A raw `:` in a value is accepted 🔬 (lenient). A raw CR is rejected ([N2](#n2-carriage-return-in-headers)) |

## Deviations

### N1 Undefined escape sequences are not fatal

1.1 says: *"Undefined escape sequences such as `\r` MUST be treated as a fatal
protocol error."*

- `\r` is fatal. It decodes to CR, which is then rejected (ERROR `Header contains a forbidden character`, then close) 🔬.
- Every other undefined sequence (`\t`, `\x`, a trailing `\`) is kept verbatim 🔬.

This was a deliberate choice in step 2. stompjs 2.x negotiates 1.1 but doesn't
escape header values at all, so a value like `C:\temp` would otherwise close
the connection.

**Options:**
- Keep it and document it in the README (recommended while stompjs 2.x is the common client).
- Make it strict with an opt-in `strictEscapes` setting.
- Make it strict for 1.2 sessions only, whose clients are known to escape.

Whatever the choice, the error text for `\r` should name the problem
(`Undefined escape sequence \r`) instead of "forbidden character".

### N2 Carriage return in headers

The 1.1 grammar ends lines with LF only, and allows every octet except LF and
`:` in header names and values, which includes CR. The broker applies the 1.2
rules instead:

| Case | Behaviour |
|---|---|
| CR right before LF | treated as part of a CRLF line ending and removed 🔬 |
| CR anywhere else in a header | ERROR, then close 🔬 |
| Header with CR in an outgoing frame | left out |

This is intentional. It is what makes CRLF clients work, and a CR inside a
header value is almost always a line-ending or injection problem rather than
data. It is stricter than the 1.1 grammar, though.

**Options:**
- Keep it (recommended) and document it.
- Accept raw CR inside values for 1.1 sessions only, and write it back raw to 1.1 subscribers. The risk is that CRLF-tolerant clients then misread the line.

### S1 Negotiation ERROR without `version` header

1.1 says the server SHOULD answer with an ERROR "similar to" the example:
`version:1.2,2.1` as a header and `Supported protocol versions are 1.2 2.1` as
the body.

The broker sends `message: Supported protocol versions are 1.0,1.1` with the
body `Unsupported protocol version 2.0` 🔬. The supported versions are there,
but not in the `version` header that clients can read programmatically.

**Fix:** add `version: 1.0,1.1` to that ERROR, and put the supported versions
in the body. Same as G5 in the 1.2 check.

## Beyond 1.1

- **ERROR always closes the connection.** 1.1 only requires a disconnect after a failed SEND or SUBSCRIBE; for other errors, closing is allowed but not required. The broker closes on every ERROR, as 1.2 requires. Clients written for 1.1 already have to handle a close after ERROR, so this is compatible.
- **DISCONNECT closes the connection** after the RECEIPT. 1.1 leaves closing to the client; closing on the server side is allowed and prevents lingering connections.
- **CRLF line endings** are accepted for every version (1.2 syntax).

## Suggested follow-ups (into step 6)

1. S1: add the `version` header to the negotiation ERROR (tiny, also needed for 1.2).
2. N1: a clearer error text for `\r`; decide between keeping lenient escapes and making them strict for 1.2 sessions or behind a setting.
3. B1: deliver frames that were received before DISCONNECT or close (see the 1.2 check).
4. A conformance test per MUST in this matrix, next to the 1.2 ones.
