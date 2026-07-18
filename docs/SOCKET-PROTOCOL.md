# Socket Protocol

The wire contract of the app's control socket — framing, the request envelope, version
negotiation, and the compatibility window. Every socket consumer (`sok`, MCP, remote
forwarders, E2E harnesses) speaks this contract; the command payloads riding on it are
specified in [MESSAGE-PROTOCOL.md](MESSAGE-PROTOCOL.md).

**Single source of truth**: the `soksak-spec-socket` crate (`src-tauri/protocol`). It holds the
version constants, the compatibility window, and the pure verdict functions. The app and every
client depend on the crate — nobody copies a constant, so the two sides of the wire cannot
drift apart silently.

## 1. Transport and framing

- The server is a Unix domain socket at `<identity home>/<identifier>.sock`
  (e.g. `~/.soksak-dev/com.soksak.dev.sock`), permissions `0600`.
- One JSON object per line, in both directions. A request line yields exactly one reply line
  on the same connection, carrying the request's `id`.
- `events.subscribe` converts the connection into a push stream after one acknowledgement —
  connection lifetime becomes subscription lifetime.
- The JSON-RPC server reaches the OS through a transport seam (`IpcListenerSeam` /
  `IpcConnection` in `src-tauri/src/ipc.rs`). On Unix the transport is the Unix domain
  socket above; on Windows the same seam is implemented with named pipes (through
  `interprocess`'s local sockets — the crate the terminal sidecars validated across
  their five-platform CI matrix). No protocol code changes with the transport, and the
  seam's round-trip test runs against both.

## 2. Request envelope

```
{ id?, method, params?, protocol?, pane?, window?, parent?, origin?, timeoutMs? }
```

| field | meaning |
|---|---|
| `id` | echoed verbatim on the reply line |
| `method` | command name, resolved by the app's command registry |
| `params` | command parameters (see MESSAGE-PROTOCOL §1) |
| `protocol` | the socket protocol version this client speaks. **Absent means 0** (a legacy, pre-negotiation client) |
| `pane` / `window` / `parent` / `origin` / `timeoutMs` | targeting and correlation context (see AI-CONTROL.md) |

Unknown fields are ignored on both sides — that tolerance is what lets a newer peer talk to an
older one inside the window.

Replies follow the response envelope of MESSAGE-PROTOCOL §3 (`{ok, code, message, window,
data?, hint?}`), plus the echoed `id`.

## 3. Negotiation — `system.hello`

`system.hello` is answered **at the transport level**, before dispatch and without touching the
front. It answers even when the webview hangs — it is the first diagnostic for "is the app
alive, and do we speak the same protocol".

```
{ "ok": true, "protocol": 1, "minClientProtocol": 0, "appVersion": "0.1.0",
  "identity": "com.soksak.dev", "pid": 4242, "startedAt": 1700000000000,
  "capabilities": ["hello.v1"], "id": … }
```

| field | meaning |
|---|---|
| `protocol` | the socket protocol version the app speaks |
| `minClientProtocol` | the oldest client protocol the app still serves (the floor) |
| `appVersion` | the app's package version (human diagnostics — never used for compatibility judgement) |
| `identity` | the app identity (`com.soksak.{dev\|debug\|app}`) — confirms which environment answered |
| `pid` / `startedAt` | process id and server start time (ms epoch) — restart detection |
| `capabilities` | transport-level behaviors only (`hello.v1`). Feature discovery stays with `state.commands` — this list never becomes a feature catalog |

`system.hello` is exempt from the version gate: a skewed client's only way to learn both
version numbers is the hello itself.

A pre-negotiation app forwards `system.hello` to the front and answers
`{ok:false, code:"UNKNOWN_COMMAND"}` — clients read that as "the app speaks protocol 0".

## 4. The compatibility window

Constants (from `soksak-spec-socket`):

| constant | value | meaning |
|---|---|---|
| `SOCKET_PROTOCOL_VERSION` | 1 | the protocol this build speaks |
| `MIN_COMPATIBLE_CLIENT_PROTOCOL` | 0 | oldest client the app serves |
| `MIN_COMPATIBLE_SERVER_PROTOCOL` | 0 | oldest app a client accepts |

The verdict is pure and symmetric (`evaluate_compat(own, floor, peer)`): a peer below the
floor is `PeerTooOld`, a peer above one's own version means `SelfTooOld`. The **absent = 0**
rule carries both halves of the contract: legacy peers stay inside the window for as long as
the floor is 0, and raising the floor later shuts them out with no new mechanism.

A request outside the window never reaches dispatch. It stops at the transport with the
standard failure envelope:

```
{ "ok": false, "code": "VERSION_SKEW",
  "message": "the client speaks socket protocol 999 but the app speaks up to 1 — update the app (…).",
  "data": { "appProtocol": 1, "minClientProtocol": 0, "clientProtocol": 999 }, "id": … }
```

The `message` is one direction-explicit sentence: it names the stale side, both version
numbers, and the remedy. `data` carries the raw numbers so an agent can judge for itself.
Skew rejections are recorded in the activity feed like every other routed failure.

**Raising a floor is legislation.** Neither floor ever rises as a side effect of a feature
change — dropping released peers takes an explicit commit of its own, stating which versions
it abandons.

## 5. Version bump rules

The common cases never bump `SOCKET_PROTOCOL_VERSION`:

- **No bump** for additive optional request or response fields — unknown fields are ignored.
- **No bump** for new methods — an unknown method already returns a typed error.
- **No bump** for `message`/`hint` wording — prose is not contract.

Bump when an existing field changes type, meaning, or becomes required; when the one-line-JSON
framing or the response envelope shape changes; or when an existing method changes semantics
such that an old peer would misread the reply.

## 6. Client conduct

- Every request declares `protocol`. In `sok` all envelopes are born in one pure builder
  (`build_request`), so one-shot commands, the events subscription, and MCP delegation are all
  declared — there is no second fill point to forget.
- `sok hello` sends the negotiation and prints the reply as pure JSON on stdout, the verdict
  sentence on stderr, and exits nonzero on skew — scripts judge by exit code.
- Clients apply the same symmetric verdict with `MIN_COMPATIBLE_SERVER_PROTOCOL` as the floor:
  a pre-hello app is protocol 0 (compatible while the floor is 0), and an app speaking a newer
  protocol is refused with the client named as the stale side.
