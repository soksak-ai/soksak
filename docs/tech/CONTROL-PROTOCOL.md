---
kind: canonical
status: active
canonical: self
---

# Control protocol


How something outside the application connects to it. `cmd/sok` is one such client; nothing about the
protocol is specific to it.

## C1. One line of JSON, both directions

A request is one JSON object on one line. The transport is a byte stream with no framing, and a
length prefix would make the socket unreadable by hand — which is the difference between a control
plane a person can operate and one they can only write a client for.

```
{"id":"1","command":"state.commands","args":{}}
{"id":"1","ok":true,"result":{...}}
```

## C2. The envelope

Request: `id`, `command`, `args`.

- `id` is echoed and never interpreted, so a client may pipeline and match on its own terms.
- `command` names a registry entry. Nothing outside the registry exists.
- `args` stay encoded until the command decodes them, so this boundary never receives their shapes.

Response: `id`, `ok`, `result`, `error`.

`ok` is explicit rather than inferred from an empty `error`: a command whose result is null and a
command that failed with an empty message would otherwise be the same three bytes.

## C2a. One answer shape on this plane

`result` is always `{code, data}`. A window's command answers its own envelope — `ok`, `code`,
`data`, `message`, `hint` — and the relay passes it through whole; a command this process serves is
given the same shape at the socket edge, from the registry's own record of who serves it rather than
from looking at the value.

The in-process caller is a different audience and keeps the value. A window calling `invoke` names
the command and has its type at the call site; this shape is for the plane whose caller is generic.

## C3. The greeting negotiates the version

`system.hello` is reserved — a feature package that registered it would replace negotiation with
something that answers differently. It returns the protocol version this build speaks, the
installation identity, and the full command table.

A version mismatch is refused during the greeting, not at the first command that behaves
differently: a mismatch found halfway through has already produced answers the caller trusted.

The identity is in the greeting so a client that connected to the wrong socket is told there,
rather than from surprising answers later.

The command table is in the greeting for the same reason: a client that has to ask separately will
act on a name it has not checked.

## C4. The command table answers for itself

`Table` includes what this build serves and what it refuses, and every refusal includes the reason
that blocks it. "Unknown command" and "not built here" send a caller to two different places, and
only the second ends the search.

**Gate.** `frameworks/wails/coverage_test.go` reads the table from the registry and fails when the
frontend calls a name that is neither served nor refused, when a refusal has no caller, or when a
refusal includes no reason.

A native window creation receipt does not mean its renderer has registered commands.
`window_renderer_wait` waits for the declaration event for one exact window with a finite deadline.
After it succeeds, renderer commands such as `app.boot.wait` are addressable without polling the
command table.

For a delegated renderer command with a declared `timeoutMs`, the relay deadline is at least five
seconds longer than the command deadline. The relay must not replace a domain timeout with a
transport timeout at the same instant. Commands without a declared timeout retain the fixed relay
deadline.

## C5. The address, and who may connect

The socket path is derived once from the identity (`<home>/<identifier>.sock`, IDENTITY.md I4) and
is never spelled a second time.

Mode is 0600. The socket answers every command this build has, so whoever can connect can do
anything the application can; a group-readable socket would hand that to every process the user
runs.

A socket file left by a dead process is removed before binding. Refusing instead would make every
crash need a manual cleanup, and the file is not the lock — a live owner still holds the address, so
the bind fails and names it.

The path limit is 104 bytes, the lower of darwin's and linux's, so a home that works here works
everywhere this builds. Overrunning it fails with "invalid argument", which reports nothing about
paths.

## C6. Windows

Windows uses a named pipe carrying the same envelope. The identity derives one opaque pipe name from
the runtime root and installation identifier; the application listener, `sok` and the sidecar host
use that address without converting it to a file path. The pipe ACL grants access only to the current
process user.

Windows system verification is not complete yet. The PTY sidecar still needs its named-pipe listener,
and the application, `sok`, sidecar host and ConPTY process must pass the installed terminal system
suite on Windows. A cross-build is not that runtime verdict.
