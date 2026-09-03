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
| 2 | The owner's id form does not repeat across its restarts | each owner repository | [ ] | [ ] | [ ] |
| 3 | The owner writes at creation, at stop and at close, atomically | each owner repository | [ ] | [ ] | [ ] |
| 4 | One session's record is isolated from every other | each owner repository | [ ] | [ ] | [ ] |
| 5 | One session survives its owner's process exiting | owner + core | [ ] | [ ] | [ ] |
| 6 | The core records every session id of a view beside its coordinate | `soksak-core` | [ ] | [ ] | [ ] |
| 7 | `session.list` | `soksak-core` | [ ] | [ ] | [ ] |
| 8 | `session.attach`, `session.detach`, `session.close` | `soksak-core` | [ ] | [ ] | [ ] |
| 9 | The restore outcome is reported | contract + owner | [ ] | [ ] | [ ] |
| 10 | A session survives its window closing | `soksak-core` | [ ] | [ ] | [ ] |
| 11 | A session survives an application restart | `soksak-core` | [ ] | [ ] | [ ] |
| 12 | An owner restarting notifies its live sessions | contract + core | [ ] | [ ] | [ ] |
| 13 | The lost-session count is exposed and is zero | `soksak-core` | [ ] | [ ] | [ ] |
| 14 | The terminal contract defines where a screen is stored | `soksak-contract-terminal` | [ ] | [ ] | [ ] |
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

Write the creation facts at creation, the final state of every held session when the owner is told
to stop, and the final state of one session when that session closes. Write to a temporary file in
the same directory and rename over the target.

The stop write is what a machine power cycle recovers from, and it is the one an owner is most
likely to omit: quitting the application closes no session (S7), so the close write never fires for
it. `soksak-sidecar-pty` already handles SIGTERM at `main.go:121` and ends its sessions there; the
write goes in that path, ahead of the ending.

Measured 2026-09-03: `soksak-sidecar-pty` writes one file, an auth token at `main.go:176`. Its ring
is memory only. The terminal mirrors serialize `cold_paint`, and no component in this workspace
stores the result. Nothing on either side of a terminal view survives its process today.

Red: stop the owner with a session open, start it again. The session is absent, or returns with the
creation facts alone.

Check: after a stop and a start the session returns at `full`, and the screen it returns with is
the screen it had. A reader never observes a partial record — assert by reading concurrently with a
write. Item 5 covers the uncontrolled exit; this item covers the controlled one.

## 4. One session's record is isolated from every other

Owner: each owner repository.

Derive each record's path from the session id. Serialize writes per session id.

Red: two sessions writing concurrently produce one record holding the other's field, or a write to
one path while another session's write is in flight.

Check: concurrent writes for two sessions leave two records, each stating its own id. A record
whose id does not match its path is refused.

## 5. One session survives its owner's process exiting

Owner: owner repository and `soksak-core`.

This is the boundary item. Everything after it assumes one session is correct.

Red: create one session, kill the owner, restart the owner. The session is not restored.

Check: the session is restored at `full` when the close write ran, at `degraded` when only the
creation facts exist. The state before the kill and after the restore are compared by a value the
owner exposes, not by a capture.

## 6. The core records the session id beside the coordinate

Owner: `soksak-core`.

The core records `{ sessionId, viewId }` when a session attaches. One view holds one row per
session (S1-3), so a terminal view records two. A lookup by coordinate that finds nothing falls to
the recorded ids.

Red: a coordinate that changed leaves the session unaddressable, while the owner still holds it.

Check: change the coordinate, then reach both sessions of a terminal view by their recorded ids.
Measured 2026-08-16 is the case this closes.

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

## 14. The terminal contract defines where a screen is stored

Owner: `soksak-contract-terminal`.

`coldPaint` returns the flattened screen and names no destination for it. §7 falls to a seal path
where the plugin fetches a sealed blob from the daemon, and the active contract states that the
daemon stores no terminal checkpoint or blob; the mechanism §7 depends on is in the removed draft.
So the contract defines a serializer with no writer.

Specify where the screen is stored, by whom, and what a reader receives when the store holds
nothing. The daemon is not the store: it parses no output and owns no grid (S1-3).

Red: the specification defines a serialization and no destination, and §7 depends on a mechanism
the same specification marks removed.

Check: the specification names one store and one owner for it; §7 depends on no removed mechanism;
the conformance suite covers a screen written, the owner stopped, and the screen read back. A
screen read back with no process behind it is presented flattened.

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
