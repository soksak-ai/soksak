---
kind: guide
status: active
canonical: self
---

# Agent control


How an agent drives this application, and which surface answers what.

## A1. The registry is the single source

The command table decides what exists, what its schema is, what its danger class is, and how it
runs. No channel keeps its own list. CLI help, an MCP tool, skill material and documentation are all
derived from the table; none of them is a copy.

## A2. A transport carries, teaching teaches

`sok` and an MCP server are transports: they call the registry and pass results back. Teaching
material tells an agent how to discover commands, and never contains a command list — a list in
teaching material is wrong the first time a plugin registers something.

## A3. Discovery beats injection

A channel exposes discovery — list, then schema, then run — rather than every command at once. Three
meta tools (`commands`, `help`, `run`) keep the tool count fixed while the command count grows.

## A4. One permission gate, in the registry

The danger gate lives with the registry and applies to remote callers (CLI, MCP, socket). A person
acting in the UI is not a remote caller. No channel re-implements the check; a plugin's command
flows through the same gate.

## A5. A channel is thin

A channel handler calls `state.commands` and passes a request through. Validation, routing, gating
and identifier matching are the registry's. A thick channel grows its own bugs, one set per channel.

## A6. The environment is the binary's identity

A binary's installation is fixed when it is built. There is no `--env` flag and no environment
variable that changes it: that switch is how a command reaches the wrong installation silently.
The only authority above it is `SOKSAK_SOCKET`, which the application injects into the terminals it
owns. When that installation is not running, the answer is an error, not a fallback to another one.

## A7. Events are symmetric with commands

The core owns a subscription surface shaped like the command surface, so nothing polls. A connection
is the subscription: its lifetime is the stream's. Entries carry a monotonic sequence, so a dropped
entry appears as a gap and the client reconnects with a cursor rather than guessing.

A client with no long-lived connection reads `activity.recent {since}` instead. A catch-up read at
request time is not polling.

## A8. Everything executed is visible

Registry commands, terminal commands and agent turns are all recorded, and the UI is a view of that
record. Two sources feed it: plugin events, and instrumentation inside `registry.execute()` —
command name, origin (ui or remote), danger class, duration, and the standard response envelope.

Sensitive values (`pass`, `token`, `secret`, `auth`, …) are masked. The answer is shown; the secret
is not. Hiding whole answers to protect a secret removes the observation this exists for.

## A9. Transport neutral

A local window and a remote client consume the same stream and the same command surface. The danger
gate keys on the caller's origin, not on the transport. The core contains no code for one particular
remote.

## A10. The development MCP is not a gate

Wails carries an MCP server behind a build tag, and its documentation marks it experimental. It is
useful for looking and clicking during development. A verdict comes from this application's own
surfaces — the control plane and the test suites — because the MCP server does not exist in a
production build.
