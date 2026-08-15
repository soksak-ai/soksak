---
kind: guide
status: active
canonical: AGENT-CONTROL.md
---

# Agent control

English canonical: [`AGENT-CONTROL.md`](AGENT-CONTROL.md). Where the two differ, English wins.

How an agent drives this application, and which surface answers what.

## A1. The registry is the single source

The command table settles what exists, what the schema is, what the danger class is, and how it
sets it. No channel keeps its own list. CLI help·MCP tool·skill material·documentation are all derived from that table
derived from it, and none of them is a copy.

## A2. A transport carries, teaching teaches

`sok` and the MCP server are transports — they call the registry and pass results back. Teaching material
how to discover commands, and never contains a command list. Teaching material with a list is wrong from the first moment a plugin registers
is wrong from the first moment.

## A3. Discovery beats injection

A channel does not expose everything at once; it offers a discovery path — list, schema, run. Three meta tools
(`commands`·`help`·`run`), the tool count is fixed however many commands are added.

## A4. One permission gate, in the registry

The danger gate is with the registry and applies to remote callers (CLI, MCP, socket). A person acting in the UI
A person is not a remote caller. No channel re-implements that check, and a plugin's command goes through the same
passes the same gate.

## A5. A channel is thin

A channel handler calls `state.commands` and passes the request through. Validation·routing·gating·identifier matching are
are the registry's. A thick channel grows its own bugs, one set per channel.

## A6. The environment is the binary's identity

A binary's installation is fixed at build time. There is no `--env` flag and no environment variable that changes it. That
switch is the path by which a command silently arrives at a different installation. The only authority above it is what the application
injects into the terminals it owns — `SOKSAK_SOCKET`. When that installation is not running, the answer is an error, not a fallback to another
installation.

## A7. Events are symmetric with commands

The core owns a subscription surface shaped like the command surface, so nothing polls. A connection is the subscription, and the connection's lifetime
is the stream's. Entries have a monotonic sequence, so a dropped entry appears as a gap, and the client, instead of guessing,
reconnects with a cursor instead.

A client with no long-lived connection reads `activity.recent {since}` instead. A catch-up read at request time is
is not polling.

## A8. Everything executed is visible

Registry commands, terminal commands and agent turns are all recorded, and the UI is a view of that record. Two sources feed it —
plugin events, and instrumentation inside `registry.execute()` (command name, origin (ui/remote), danger class,
duration, standard response envelope).

Sensitive values (`pass`, `token`, `secret`, `auth`, …) are masked. The answer is shown and the secret is hidden. Hiding a whole answer to protect the
Hiding the whole answer to protect it removes the observation this mechanism exists for.

## A9. Transport neutral

A local window and a remote client use the same stream and the same command surface. The danger gate keys not on the transport but on
the caller's origin. The core contains no code for one particular remote.

## A10. The development MCP is not a gate

Wails has an MCP server behind a build tag, and its documentation marks it experimental. During development
It is used for looking and clicking during development. A verdict comes from this application's own surfaces — the control plane and the test suites.
That is because the MCP server does not exist in a production build.
