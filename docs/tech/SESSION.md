---
kind: canonical
status: active
canonical: self
scope: workspace
---

# Session

A session is work a person or a program started that outlives the things that display it. This
document defines what a session is, what its state is, who stores that state, and what happens to
it when a window closes, a process exits, or the application restarts.

Every other rule about keeping work across a restart is subordinate to this one. Process handoff
exists to keep a session's state; it is not a goal of its own.

## S1. Definition

A **session** is a unit of work with three properties. All three are required.

1. **It has an owner that is not the display.** The work continues when no view shows it.
2. **It has state a later attachment needs.** Reattaching without that state is not the same work.
3. **One component owns it.** That component defines what the state is and how it is stored.

A view, a pane, a split node and a window are not sessions. They are places a session is shown. A
session is shown in zero, one, or more of them over its life.

A request-response call is not a session: it has no state a later attachment needs.

A cache is not a session: losing it costs time, not work.

### S1-1. Examples of the boundary

| Work | Session | Reason |
| --- | --- | --- |
| A shell running under a pty | Yes | The process continues with no view; the working directory and the output it produced are needed to reattach |
| A browser view's page and history | Yes | The navigation history and scroll position are needed to reattach; the owner keeps the page loading while no view shows it |
| A terminal screen | Yes | The mirror holds the grid; output past the retained tail no longer reproduces it |
| A file tree's expanded folders | No | Reconstructed from the filesystem; losing it costs no work |
| One command sent over the control protocol | No | No state a later attachment needs |

### S1-2. The owner is a sidecar

A session's owner is a sidecar, never the core. The core does not know what a session's state
contains and cannot store it correctly.

The core owns the **index**: which sessions exist, which component owns each, and where each was
last shown. It does not own the state.

### S1-3. One view attaches to more than one session

A terminal view shows two sessions with different owners. The PTY daemon owns the shell: the
process, the working directory, the output it produced. The terminal mirror owns the screen: the
grid that output painted, and the alternate screen a full-screen program drew.

They are paired, never merged. Each stores its own state, restores on its own, and returns its own
outcome. A person sees one terminal; the model holds two sessions, and the attachment record
(S2-4) holds one row per session against the same view.

The screen is not a derivative the shell can reproduce. The daemon retains a bounded output tail,
and past that bound the output that painted the top of the screen is gone. The grid the mirror
holds is the only remaining form of it.

## S2. Identity

### S2-1. The owner issues the id

A session id is issued by the owner when it creates the session. The owner chooses the form. Every
operation on a session takes the id.

The caller passes coordinates — which pane, which window — so the owner can answer "this pane
already holds a session" without the caller tracking the id itself. That answer is a yes with an
id, or a no. It is the one question a coordinate settles; nothing else is addressed by coordinate.
The owner compares those coordinates and resolves nothing from them: an owner that read a pane id
would define what a pane is, and that definition is the core's.

### S2-2. Coordinates are a lookup, not the identity

A coordinate answers "is there a session here". The id answers "which session". They are different
questions and a component that used one for the other loses sessions when the coordinate changes.

Measured 2026-08-16: a terminal session looked up by `windowLabel + "|" + paneId` alone could not
be reattached after a restore issued new pane ids, while the shell was still running and still
holding its scrollback. The daemon's own id was unaffected; nothing had recorded it.

The core records the id beside the coordinate. A lookup by coordinate that finds nothing falls to
the recorded id, and a session whose coordinate changed is still addressable.

### S2-3. Lifetime

A session id is kept for the life of the session. The owner's id form does not repeat within the
identity home, including across the owner's own restarts, so a reference left by a closed session
resolves to nothing rather than to a different session.

A counter that starts at zero on every start does not meet this. Its second start hands out the
ids its first start used, and a record left by the first start is read as the second start's own.
The owner seeds its id space instead of counting from zero.

### S2-4. Attachment is not identity

A session is attached to a view. The attachment is a separate record: `{ sessionId, viewId }`. The
attachment changes when the session is shown somewhere else; the session id does not.

A session with no attachment whose owner holds it is **detached**, not closed. Detached is a
normal state.

## S3. What is session state

**Session state** is what a later attachment needs and cannot derive. It survives the process that
holds it.

**Process state** is what only has meaning while a process is alive. It does not survive that
process and is not stored.

| | Session state | Process state |
| --- | --- | --- |
| Shell — PTY daemon | Working directory, environment the shell was started with, the retained output tail, exit status | The pty file descriptor, the child process id, the connection to a subscriber |
| Screen — terminal mirror | The grid, the alternate screen, cursor position and style, the modes a program set | The half-read escape sequence in the parser, the socket to the daemon |
| Browser view | Address, navigation history, scroll position, form values the page declares as restorable | The renderer process, the network connections, the compositor surface |

An owner classifies only what it holds. The daemon parses no output and therefore owns no grid;
the mirror runs no shell and therefore owns no working directory.

The owner classifies its own facts as session state or process state. The core does not.

A fact that can be recomputed from another fact is not session state. Storing it creates two
sources for one truth.

### S3-1. What survives a close

When a session closes, its state is removed. What survives is what another component owns and
recorded for its own reason: a workspace's layout, a command history the application keeps, a file
the session wrote.

A session's own state does not outlive the session. A closed session is not recoverable.

## S4. Storage

### S4-1. The owner stores it

The owner sidecar stores its sessions' state. It chooses the format and the location within the
identity home. The core does not read, write, or validate that store.

The core cannot store it correctly: the state's shape is the owner's, and a core that stored it
would have to know that shape, which is the coupling this rule exists to prevent.

### S4-2. When it is written

The owner writes at least at these points:

- **Creation.** The facts needed to create an equivalent session: what was started, where, and with
  what environment.
- **Close.** The final state.

An owner that cannot write more often writes only these two. An owner that writes more often
raises what an uncontrolled exit preserves: the state recovered after such an exit is the state at
the last write, and nothing later.

Recreating a session from creation facts alone is a **degraded** recovery. It is reported as
degraded and never presented as a full restore.

### S4-3. How it is written

A write is atomic: written to a temporary file in the same directory and renamed over the target. A
reader never sees a partial record.

The rename covers a process exit, which is what S6 recovers from. It does not cover a power loss:
that needs the temporary file and its directory synced before the rename, and an owner that claims
to survive a power loss does that.

A record states the session id it is for. A reader that finds a record whose id does not match the
path refuses the record rather than repairing it.

A record that cannot be parsed costs that record only. Other sessions' records are unaffected.

### S4-4. Isolation

One session's record is written only by that session's owner and names only that session.

A record is stored at a path derived from the session id. Two sessions never write to one path. An
owner writing a record for session A never opens the path of session B.

A write is serialized per session id within the owner. Two writes for one session never interleave.

A record is not shared between sessions. A value two sessions both need is stored by whoever owns
it and read through that owner, not copied into both records.

## S5. States

A session is in exactly one state.

| State | Meaning |
| --- | --- |
| `live` | The owner holds it and a view shows it |
| `detached` | The owner holds it and no view shows it |
| `orphaned` | No owner holds it and no owner has reported it unrecoverable |
| `lost` | An owner read its store and found no record for it |

Closing ends a session. A closed session is in none of these states because it no longer exists,
and `session.list` returns nothing for it.

`live` and `detached` differ by attachment, not by health. A detached session is doing its work.

`orphaned` is what the core reports whenever no owner holds the session, and that includes the
whole time an owner's process is not running. The core does not read an owner's store (S4-1), so it
cannot tell a recoverable session from an unrecoverable one on its own.

`lost` is a verdict its owner returns after reading its store at start. The core never derives it.
A session stays `orphaned` until an owner returns that verdict, however long its owner is down.

`lost` is a defect. The count is a measured value, not an accepted outcome, and its gate asserts
zero.

Attachment does not apply to `orphaned` or `lost`. No owner holds the session, so there is nothing
for a view to attach to.

## S6. Recovery

### S6-1. When the owner process restarts

The owner reads its records at start, restores each session, and reports the outcome for each.

| Outcome | Meaning | State after |
| --- | --- | --- |
| `full` | The state at the last write is restored | `detached` |
| `degraded` | Only the creation facts were available; an equivalent session was created | `detached` |
| `failed` | A record exists and could not be used | `orphaned` |
| `lost` | No record exists for the session | `lost` |

An owner that finished reading its store returns one of these four for every session the core holds
in its index for that owner. `full` and `degraded` are the fidelities of a restore; `failed` and
`lost` are the two ways there is no restore.

`full` is about the stored state, never about a process. A restored session always has a new
process, at every outcome.

A `failed` record is not removed. Removing it discards the only evidence of what was lost, and a
later attempt against a repaired reader may succeed, which is why the session stays `orphaned`
rather than becoming `lost`.

The core keeps the index entry of a `lost` session. Removing it would drop the count to zero by
deletion rather than by correctness, and the entry is what names the session the gate counts.

### S6-2. What a restore returns

A process is process state (S3) and no store returns one. The shell that runs after a restore is a
new shell, started from the creation facts.

A restore therefore returns the screen and not the program that painted it. A full-screen program's
alternate screen comes back as the grid it left; that program is not running, and the next key goes
to the new shell.

This holds for every session, with no per-owner exception. Machine power-off and process exit are
the same case here: both end the process, and neither touches a stored record.

### S6-3. When the owner restarts while a session is attached

A session that is `live` when its owner restarts is notified. The core delivers the notification to
whatever is attached; the response to it is that component's.

The notification states the session id and the outcome of the restore. A consumer that resumed
against a degraded restore without knowing it would report state the session does not have.

One notification per session. A view attached to a pair receives one for each, and the two outcomes
can differ: a mirror restores its grid in whole while the shell under it is new.

### S6-4. When the application restarts

Sessions are not created or destroyed by an application restart. The core reads its index and
queries every owner that is running for the outcome of each session the index records for that
owner, including the ones that owner does not hold. It starts no owner to answer a query. A
session whose owner is not running stays `orphaned`, and the core reports it as awaiting its
owner.

An `orphaned` session is not attachable. It becomes `detached` when its owner restores it, and
attachable then. The core offers every `detached` session.

A session is offered regardless of which window, workspace or pane last showed it. A person who
closed the window their session was in still finds that session.

## S7. Layers

The application's structure is application → window → workspace → space → panel → view. A session
attaches to a view and is owned by none of the layers above it.

Closing any layer detaches the sessions shown inside it. It does not close them. They are
`detached` while their owner runs and `orphaned` when the owner is not running, and neither is a
close.

Closing a session is an explicit act on that session.

## S8. Consumers

A session's consumer is a person or a program. The two are not distinguished by the session, its
storage, or its recovery.

A program attaches with the same `session.attach` a view uses and reads the session's content
through the same contract that view's plugin declares. There is no second path for a program.

## S9. What the core exposes

The core exposes what the state model above defines, and no more. A command exists because a state
in S5 can be observed or changed, not because a screen wants it.

| Fact | Command |
| --- | --- |
| Which sessions exist, their state, owner, last attachment, and last restore outcome | `session.list` |
| Attach a session to a view | `session.attach` |
| Detach a session from its view | `session.detach` |
| Close a session | `session.close` |

There are four states and one way to read them. `session.list` returns every session in every
state, including `orphaned`, and a caller filters. A second command for one session's state would
read the same fact through a second path.

`session.close` requires the owner to be running. Closing removes the owner's record, and the core
does not write that store. A close aimed at a session whose owner is not running is refused and
reports that the owner is not running.

The restore outcome in a listed session is the outcome of its last restore. A session that was never
restored has none, and the field is absent rather than defaulted to `full`.

The core reads each fact from the owner through the contract that owner's plugin declares. It does
not read an owner's store.

## S10. Gates

| Claim | Gate |
| --- | --- |
| The core records no id it derived from a coordinate | Core test over the index writer |
| An owner's id does not repeat across its restarts | Owner repository test per owner |
| A session survives its window closing | Core test: close the window, `session.list` reports `detached` |
| A session survives its owner's process exiting | Core test with a fake owner: kill it, `session.list` reports `orphaned` |
| A session survives an application restart | Core test over a fixture index |
| A session whose owner is not running reports `orphaned`, never `lost` | Core test with no owner process |
| A close aimed at a session whose owner is not running is refused | Core test |
| A partial record is never read | Owner repository test per owner |
| One session's record is not written by another session | Owner repository test per owner |
| A degraded restore is reported as degraded | Contract conformance test per owner |
| A lost session is counted | Core test: the count is a number, and it is zero |

The execution order is in [`SESSION-TASK.md`](SESSION-TASK.md).

## S11. Subordinate documents

| Document | Relation |
| --- | --- |
| [`COMPONENT-HANDOFF.md`](COMPONENT-HANDOFF.md) | How a process is replaced without losing the sessions it holds. Subordinate: handoff serves S6 |
| [`RESTORE.md`](RESTORE.md) | Window and workspace layout across a restart. A layout names attachments; it does not hold session state |
| [`TERMINAL-RESTORE-CONTRACT.md`](TERMINAL-RESTORE-CONTRACT.md) | The terminal owner's restore sequence. One owner's implementation of S6 |
| [`SIDECARS.md`](SIDECARS.md) | The process an owner runs in |
