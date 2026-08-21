---
kind: canonical
status: active
canonical: self
---

# Control protocol


How something outside the application reaches it. `cmd/sok` is one such client; nothing about the
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
- `args` stay encoded until the command decodes them, so this boundary never learns their shapes.

Response: `id`, `ok`, `result`, `error`.

`ok` is explicit rather than inferred from an empty `error`: a command whose result is null and a
command that failed with an empty message would otherwise be the same three bytes.

## C2a. One answer shape on this plane

`result` is always `{code, data}`. A window's command answers its own envelope — `ok`, `code`,
`data`, `message`, `hint` — and the relay passes it through whole; a command this process serves is
given the same shape at the socket edge, from the registry's own record of who serves it rather than
from looking at the value.

Two shapes reached this socket until 2026-08-17: a window's envelope and a bare value, with nothing
in the answer to tell them apart, so a client had to know who owned each command before it could
parse the answer. Two readings taken in one session were parsed against the wrong shape and reported
the opposite of what was on screen — one of them said a sidebar was not drawn while it was.

The in-process caller is a different audience and keeps the value. A window calling `invoke` names
the command and has its type at the call site; this shape is for the plane whose caller is generic.

## C3. The greeting negotiates the version

`system.hello` is reserved — a feature package that registered it would replace negotiation with
something that answers differently. It returns the protocol version this build speaks, the
installation identity, and the full command table.

A version mismatch is refused during the greeting, not at the first command that behaves
differently: a mismatch found halfway through has already produced answers the caller trusted.

The identity is in the greeting so a client that connected to the wrong socket learns that there,
rather than from surprising answers later.

The command table is in the greeting for the same reason: a client that has to ask separately will
act on a name it has not checked.

## C4. The command table answers for itself

`Table` carries what this build serves and what it refuses, and every refusal carries the reason
that blocks it. "Unknown command" and "not built here" send a caller to two different places, and
only the second tells them to stop looking.

**Gate.** `frameworks/wails/coverage_test.go` reads the table from the registry and fails when the
frontend calls a name that is neither served nor refused, when a refusal has no caller, or when a
refusal carries no reason.

A native window creation receipt does not mean its renderer has registered commands.
`window_renderer_wait` waits for the declaration event for one exact window with a finite deadline.
After it succeeds, renderer commands such as `app.boot.wait` are addressable without polling the
command table.

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
everywhere this builds. Overrunning it fails with "invalid argument", which says nothing about
paths.

## C6. Windows

Windows requires a named pipe carrying the same envelope. `core/control/listen_windows.go` currently
refuses startup because that transport has not been implemented. Windows system verification cannot
be declared complete until the application and `sok` both use the named pipe and the same protocol
tests pass on Windows.
