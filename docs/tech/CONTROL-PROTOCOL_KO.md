---
kind: canonical
status: active
canonical: CONTROL-PROTOCOL.md
---

# Control protocol

English canonical: [`CONTROL-PROTOCOL.md`](CONTROL-PROTOCOL.md). Where the two differ, English wins.

The path from outside the application to inside. `cmd/sok` is one such client, and nothing in the protocol is specific
specific to it.

## C1. One-line JSON, both directions

A request is one JSON object on one line. The transport is a byte stream with no framing of its own, and a length prefix
would make the socket unreadable by hand — between a control plane a person can operate and one they can only write a client for,
That is where the two control planes part.

```
{"id":"1","command":"state.commands","args":{}}
{"id":"1","ok":true,"result":{...}}
```

## C2. The envelope

Request: `id`, `command`, `args`.

- `id` comes back unchanged and is never interpreted. Even when a client pipelines it and pairs it its own way,
  own terms.
- `command` identifies a registry entry. A command outside the registry does not exist.
- `args` remains encoded until that command decodes it. This boundary holds no argument shape.

Response: `id`, `ok`, `result`, `error`.

`ok` is explicit rather than inferred from an empty `error`. A command whose result is null and a command that failed with an empty message
would otherwise be the same three bytes.

## C3. The greeting negotiates the version

`system.hello` is reserved — a feature package that registers that name would replace negotiation with something that answers differently
into something that answers differently. It returns the protocol version this build speaks, the installation identity, and the command table.

A version mismatch is refused at the greeting, not when the first command behaves differently. A mismatch found halfway through has already
produced answers the caller trusted.

Why the identity is in the greeting: a client attached to the wrong socket finds that out right there, not from a strange answer later.
confirms that there.

The command table is in the greeting for the same reason. A client that has to query it separately acts on a name it has not
checked.

## C4. The command table holds the refusal and its reason together

`Table` holds what this build serves and what it refuses, and every refusal has the reason that blocks it
comes with it. "Unknown command" and "not built here" send a caller to two different places, and only the second
only the second of the two supplies that.

**Gate.** `frameworks/wails/coverage_test.go` reads the table from the registry, and what the frontend calls but
It fails on three: a name that is neither served nor refused·a refusal with no caller·a refusal with no reason.

## C5. Address and access permission

The socket path is derived once from the identity (`<home>/<identifier>.sock`, IDENTITY.md I4) and is never spelled a second time.

Mode is 0600. This socket answers every command this build has, so whoever can connect can do everything the application
can do anything the application can. Group read permission hands that to every process the user runs,
in effect.

A socket file left by a dead process is removed before the bind. Refusing would make every crash need a manual cleanup before a start
is possible, and that file is not the lock — a live owner still holds the address, so the bind fails and names the
The fact is reported.

The path limit is 104 bytes, the lower of darwin's and linux's. A home that works here works anywhere this build
runs. Overrunning it fails with "invalid argument", and that phrase states nothing about paths.

## C6. Windows

A named pipe uses the same envelope. `core/control/listen_windows.go` is the only file that differs, and nothing above it
depends on which transport it is on.
