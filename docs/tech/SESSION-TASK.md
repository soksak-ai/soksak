---
kind: guide
status: active
canonical: tech/SESSION.md
scope: workspace
---

# Session execution

Execution order for [`SESSION.md`](SESSION.md). Each item names the repository that owns it, the
red that must fail first, and the check that closes it. An item closes only after its check runs
and reports the stated result.

One session is made correct before any work on several. Item 5 is the boundary: nothing after it
starts until items 1 to 4 close. Every item leaves a working product — a later item adds a state or
a command to what already runs, and none replaces a working path with an unfinished one.

## Rules for this work

- Establish a mechanical red before implementation and confirm it fails for the stated reason.
- One repository per commit.
- Use the primitive or the dependency the repository already has. Read its documentation before
  concluding it lacks what the item needs.
- The core reads the index and queries owners. It does not read an owner's store or classify an
  owner's facts.
- No compatibility path. A record without the current shape is refused, not repaired.
- A capture is not a pass. Every item closes on a command result or a test.

## State

| # | Item | Repository | Red | Implementation | Check |
| --- | --- | --- | --- | --- | --- |
| 1 | Session state and process state are separated per owner | each owner repository | [x] pty | [x] pty | [x] pty `066e3be` |
| 2 | The owner's id form does not repeat across its restarts | each owner repository | [x] pty | [x] pty | [x] pty `14a664c` |
| 3 | The owner writes at creation, at stop and at close, atomically | each owner repository | [x] pty | [x] pty | [x] pty `66bf962` `1e50f0d` |
| 4 | One session's record is isolated from every other | each owner repository | [x] pty | [x] pty | [x] pty `71a0b13` |
| 5 | One session survives its owner's process exiting | owner + core | [x] pty | [x] pty | [x] pty `7fc12af` |
| 6 | The core records every session id of a view beside its coordinate | `soksak-core` | [x] | [x] | [x] `9bc431b` |
| 7 | `session.list` | `soksak-core` | [x] | [x] | [x] `70c3060` `14bfe6d` |
| 8 | `session.attach`, `session.detach`, `session.close` | `soksak-core` | [x] | [x] | [x] `be7fdaa` `65e39b4` `8699c40` `7c0321b` |
| 9 | The restore outcome is reported | contract + owner | [x] pty | [x] pty | [x] pty `b850f86` `0ab78e6` |
| 10 | A session survives its window closing | `soksak-core` | [x] | [x] | [x] `9bc431b` |
| 11 | A session survives an application restart | `soksak-core` | [x] | [x] | [x] `9bc431b` |
| 12 | An owner restarting notifies its live sessions | contract + core | [ ] | [ ] | [ ] |
| 13 | The lost-session count is exposed and is zero | `soksak-core` | [ ] | [ ] | [ ] |
| 14 | The mirror reports the modes a replay cannot rebuild | contract + owner | [ ] | [ ] | [ ] |
| 15 | The owner records the program that was running | each owner repository | [ ] | [ ] | [ ] |
| 16 | Handoff is rewritten as a subordinate of S6 | `soksak-core` | [ ] | [ ] | [ ] |

---

## 1. Session state and process state are separated per owner

Owner: each owner repository.

List every fact the owner holds per session and classify each as session state or process state
under S3. A fact recomputable from another fact is neither and is not stored.

A terminal view has two owners (S1-3), so this item runs twice for it: once in the PTY daemon over
the shell, once in the terminal mirror over the screen. Neither classifies the other's facts.

Red: no such list exists, so the store's contents cannot be judged.

Check: the list is in the owner's repository, every stored field appears in it, and no stored field
is classified as process state.

## 2. The owner's id form does not repeat across its restarts

Owner: each owner repository.

`soksak-sidecar-pty` issues its session id from `reg.next`, a counter that starts at zero on every
boot. Its generation number is seeded from `crypto/rand` in the same file for this reason. Seed the
id space the same way rather than adding a dependency for it.

Red: start a daemon, open a session, restart the daemon, open a session. The two ids are equal.

Check: the two ids differ. A record written under the first id is refused by the second session
rather than adopted.

## 3. The owner writes at creation, at stop and at close, atomically

Owner: each owner repository.

Write the creation facts at creation, append the output as it arrives, and write the final state
when the owner is told to stop or when the session closes. The record's name states its format
version, and the stop write is the only one that marks the record cleanly ended.

The stop write is what a machine power cycle recovers from, and it is the one an owner is most
likely to omit: quitting the application closes no session (S7), so the close write never fires for
it. `soksak-sidecar-pty` already handles SIGTERM at `main.go:121` and ends its sessions there; the
write goes in that path, ahead of the ending. A drain past its deadline leaves the record unmarked.

The append never pauses the read loop. It is a subscriber like any other and loses bytes loudly
rather than blocking the session that feeds it.

Measured 2026-09-03: `soksak-sidecar-pty` writes one file, an auth token at `main.go:176`. Its ring
is memory only. Nothing a terminal session holds survives its process today.

Red: stop the owner with a session open, start it again. The session is absent, or returns with the
creation facts alone.

Check: after a stop and a start the session returns at `full`, and the screen a replay rebuilds is
the screen it had. After a kill the record exists, is unmarked, and holds the output up to the last
append. A reader never observes a partial record. A record whose name states an older version is
not found. Item 5 covers the uncontrolled exit; this item covers the controlled one.

## 4. One session's record is isolated from every other

Owner: each owner repository.

Derive each record's path from the session id. Take a lock per session id, never one for the whole
store: a write through one lock pauses every other session for the length of a disk write.

Red: two sessions writing concurrently produce one record holding the other's field, or a write to
one path while another session's write is in flight.

Check: concurrent writes for two sessions leave two records, each holding only its own output. A
record whose id does not match its path is refused. A write for one session completes while another
session's lock is held.

## 5. One session survives its owner's process exiting

Owner: owner repository and `soksak-core`.

This is the boundary item. Everything after it assumes one session is correct.

Red: create one session, kill the owner, restart the owner. The session is not restored.

Check: the session is restored at `full` when the close write ran, at `degraded` when only the
creation facts exist. The state before the kill and after the restore are compared by a value the
owner exposes, not by a capture.

## 6. The core records the session id beside the coordinate

Owner: `soksak-core`.

The core records `{ sessionId, owner, viewId, windowLabel }` when a session attaches. It is a record
of its own, not a field on the view: a view goes away with the window that held it, and a session
outlives both. A lookup by coordinate that finds nothing falls to the recorded id.

Red: a coordinate that changed leaves the session unaddressable, while the owner still holds it.

Check: change the coordinate, then reach the session by its recorded id. Measured 2026-08-16 is the
case this closes.

## 7. `session.list`

Owner: `soksak-core`.

`session.list` returns every session in every state, including `orphaned`, with its state, owner,
last attachment, and last restore outcome. It reads from a running owner through that owner's
plugin contract, and from the index alone for an owner that is not running.

Red: no command reports which sessions exist.

Check: a session in each of `live`, `detached` and `orphaned` appears; a session whose owner is not
running reports `orphaned` and never `lost`; a session that was never restored has no outcome;
the command starts no process and ends none — assert the process set is unchanged across the call.

## 8. `session.attach`, `session.detach`, `session.close`

Owner: `soksak-core`.

Red: no command changes a session's attachment.

Check: attach moves a `detached` session to `live`; detach moves it back; close removes the record
and the session leaves `session.list`. A close aimed at a session whose owner is not running is
refused and reports that the owner is not running.

## 9. The restore outcome is reported

Owner: contract repository and each owner.

Specify `full`, `degraded`, `failed` and `lost` on the wire. A `failed` record is kept, not
deleted. An owner that finished reading its store returns one outcome for every session the core
holds in its index for that owner.

Red: an owner restores from creation facts alone and reports success.

Check: a degraded restore is reported as degraded; a failed record still exists after the restore;
a session the owner finds no record for is returned as `lost`.

## 10. A session survives its window closing

Owner: `soksak-core`.

Red: close the window; the session is gone from `session.list`.

Check: the session reports `detached` and reattaches to a view in another window.

## 11. A session survives an application restart

Owner: `soksak-core`.

Red: restart the application; a session that was open is absent.

Check: the session appears in `session.list` after the restart and reattaches. The window it was in
does not have to be the one it returns to.

## 12. An owner restarting notifies its live sessions

Owner: contract repository and `soksak-core`.

The notification states the session id and the restore outcome.

Red: an owner restarts and the attachment continues without knowing the state changed.

Check: the attachment receives the notification with the outcome; a consumer that resumed against
a degraded restore can tell.

## 13. The lost-session count is exposed and is zero

Owner: `soksak-core`.

`lost` is the verdict an owner returns after reading its store at start. The core counts those
verdicts and derives none of its own. The count is a measured value.

Red: no command reports the count.

Check: the count is a number and it is zero. A non-zero count names each lost session's owner and
last coordinate. A session whose owner is not running is absent from the count.

## 14. The mirror reports the modes a replay cannot rebuild

Owner: contract repository and each terminal owner.

A mode set before the stored output begins is in no byte the store holds, so a replay alone cannot
rebuild it (S4-5). The mirror already tracks mode state apart from the byte window — the corpus
grades it on `private modes beyond the ring window` — and this item exposes that state so the
daemon can record it.

Specify what the report holds. A serializer that omits a mode a program negotiated is the failure
this closes, and it is invisible until a program misbehaves against it, so the set is enumerated
and graded rather than assumed complete.

Red: the mirror reports no mode state, so a replay from a truncated store rebuilds a screen whose
modes are the defaults.

Check: a session that entered a full-screen mode before the stored output's floor restores with
that mode set. The conformance suite covers each mode the report names.

## 15. The owner records the program that was running

Owner: each owner repository.

A screen read as history is not the work continued (S6-3). Record what was running in the session
so a person can start it again over the same files in the same directory.

`soksak-sidecar-pty` holds `command`, which is the login shell it started and not the program that
shell then ran. The program is what a continuation needs.

Red: after a restore nothing names the program that was running, so the only offer is a shell.

Check: a session that was running an editor reports that editor and its arguments. Starting it is a
separate command, and a restore starts no program on its own — assert the process set holds no new
child across the restore.

## 16. Handoff is rewritten as a subordinate of S6

Owner: `soksak-core`.

`COMPONENT-HANDOFF.md` treats process replacement as the subject. Rewrite it so the subject is the
session: handoff is one way S6 is met, and an owner that stores and restores correctly meets S6
without it.

State the limit plainly. Descriptor passing keeps a session across a process replacement on a
running machine and does nothing for a power cycle, because the reference that holds the descriptor
open is the kernel's. An owner that stores and restores covers both; handoff covers one.

Red: the handoff document states a rule the session document contradicts.

Check: every rule in the handoff document is derivable from `SESSION.md`, and the two documents
state no conflicting rule. `COMPONENT-HANDOFF-TASK.md` items are renumbered under this order.
