---
kind: changelog
status: historical
canonical: docs/tech/CONTROL-PROTOCOL.md
---

# Control protocol design flow

The current contract is [CONTROL-PROTOCOL.md](./CONTROL-PROTOCOL.md).

## Why the control plane has one response envelope

The socket carried both bare values and window response envelopes. A generic client could not tell
which shape it had received without already knowing which process owned the command. That made valid
screen state appear as a failed command when the client chose the wrong parser.

Every control-plane response now includes one self-describing envelope. The relay preserves a
window's envelope, and Core-served commands receive the same outer shape at the socket boundary.
In-process typed callers may still use direct values because they already know the command type.

## Evidence

Protocol tests drive Core and window-owned commands through the same generic client and require the
same envelope grammar. Greeting tests reject incompatible protocol versions before any command runs.
