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

## Who owns sessions

"Each owner repository" is this list and nothing else. An item spanning it is closed when every row
is, and a row that is not done leaves the item open.

| Component | Owns sessions | Why |
| --- | --- | --- |
| `soksak-sidecar-pty` | Yes | It runs the shell, holds the output, and outlives the application generation |
| `soksak-sidecar-terminal-*` | No | A mirror turns output into a grid and stores nothing (S1-3). Measured 2026-09-03: none of the six writes a file |
| `soksak-plugin-terminal-*` | No | Every one declares `soksak-sidecar-pty` as its runtime dependency and shows that owner's sessions |
| `soksak-plugin-browser-wails3` | No | A page has nothing running behind it once its view is gone, so its address, scroll and history are view state and go in the view's own record (S1-4) |
| `soksak-plugin-file-tree`, `soksak-plugin-process-monitor` | No | Reconstructed from the filesystem and from the process table (S1-1) |

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
| 1 | Session state and process state are separated per owner | each owner repository | [x] | [x] | [x] `066e3be` |
| 2 | The owner's id form does not repeat across its restarts | each owner repository | [x] | [x] | [x] `14a664c` |
| 3 | The owner writes at creation, at stop and at close, atomically | each owner repository | [x] | [x] | [x] `66bf962` `1e50f0d` |
| 4 | One session's record is isolated from every other | each owner repository | [x] | [x] | [x] `71a0b13` |
| 5 | One session survives its owner's process exiting | owner + core | [x] | [x] | [x] `7fc12af` |
| 6 | The core records every session id of a view beside its coordinate | `soksak-core` | [x] | [x] | [x] `9bc431b` |
| 7 | `session.list` | `soksak-core` | [x] | [x] | [x] `70c3060` `14bfe6d` |
| 8 | `session.attach`, `session.detach`, `session.close` | `soksak-core` | [x] | [x] | [x] `be7fdaa` `65e39b4` `8699c40` `7c0321b` |
| 9 | The restore outcome is reported | contract + owner | [x] | [x] | [x] `b850f86` `0ab78e6` |
| 10 | A session survives its window closing | `soksak-core` | [x] | [x] | [x] `9bc431b` |
| 11 | A session survives an application restart | `soksak-core` | [x] | [x] | [x] `9bc431b` |
| 12 | An owner restarting notifies its live sessions | contract + core | [x] | [x] | [x] `ed039ac` |
| 13 | The lost-session count is exposed and is zero | `soksak-core` | [x] | [x] | [x] `b2c938f` |
| 14 | The mirror reports the modes a replay cannot rebuild | contract + owner | [x] | [x] | [x] `3d8cbe1` `3cc396d` |
| 15 | The owner records the program that was running | each owner repository | [x] | [x] | [x] `f16ec9e` |
| 16 | Handoff is rewritten as a subordinate of S6 | `soksak-core` | [x] | [x] | [x] `61ed75c` |
| 17 | A browser view keeps its address in its view record | `soksak-plugin-browser-wails3` | [x] | [x] | [x] `7c2af28` |
| 17-1 | Every view declares what its restore needs | core, every plugin with a view | [x] | [x] | [x] `8ef6402` |
| 17-2 | The recorded modes have a producer and a consumer | `soksak-kit-plugin-terminal`, `soksak-kit-sidecar-terminal` | [x] | [ ] | [ ] |
| 17-3 | The command a session owner's view calls is named by the contract | `soksak-contract-control` | [x] | [ ] | [ ] |
| 17-4 | A plugin's failure is observable from outside the renderer | core | [x] | [x] | [x] `2653847` |
| 17-5 | A terminal pane registers with the mirror that renders it | `soksak-kit-sidecar-terminal` | [x] | [ ] | [ ] |
| 18 | A plugin can take back what it stored | `soksak-core` | [x] | [x] | [x] `361032f` |
| 19 | The session question goes wherever the owner runs | `soksak-core` | [x] | [x] | [x] `899a792` |

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

## 17. A browser view keeps its address in its view record

Owner: `soksak-plugin-browser-wails3`.

A browser view is not a session (S1-4). Nothing runs behind the page once the view is gone: going to
the address is what brings it back, and the scroll position and the navigation history are of the
same kind — observed about the view, meaningless without it.

The core already does that. `setRestoreState` writes a plugin's observed state into the view's
record, the window snapshot puts that on disk, and the view gets it back as `restore.state` when it
mounts again — the same record and the same file that bring the layout back. Its declaration names a
browser URL as the example and rules out plugin kv, because a view id is the only key a plugin has
and the core does not promise one is unique across restarts.

Two things were built before that was checked. A process of its own, whose whole job was to hold a
small record and answer two questions about it — taken out again. Then a store inside the plugin,
keyed by session id, which is a second copy of what the view record already holds. Both rested on a
premise nobody checked: that a browser page has state which outlives its view. It does not.

So this item is the removal of that store and of this plugin's session ownership, leaving the
address, the scroll position and the history in the view record where the core already keeps them.

Red: close the window a browser view is in and open it again. The page is a fresh one at the same
address, with no history behind it and no scroll position.

Check: a view restored from a snapshot loads the address it was left at, with its history and its
scroll applied; a view with no recorded state opens blank rather than failing; this plugin declares
no session command and answers none.

## 17-1. Every view declares what its restore needs

Owner: the core, and every plugin that contributes a view.

Restoring is not one thing. A terminal is the involved one — a process, the output it produced, the
modes a program set — and it is the only session, because the shell keeps running with nothing
drawing it. An editor keeps the path it had open. A browser keeps the address. A file tree keeps
nothing and reads the filesystem.

Which of those a view is cannot be worked out by looking. An absent record means one thing for a
view that keeps nothing and another for a view that failed to read what it kept, so every view
declares `none`, `view` or `session` (S1-5) and one that declares nothing is refused at
registration.

Red: a provider with no declaration registers, and a restore that brought nothing back is
indistinguishable from a view with nothing to bring.

Check: the three kinds are closed in one place, so a fourth leaves the branches on it visibly
incomplete; a view without a declaration is refused with a sentence from the bundle; the terminal
kit declares `session` and the browser declares `view` for its page and `none` for its list.

## 17-5. A terminal pane registers with the mirror that renders it

Owner: `soksak-kit-sidecar-terminal`.

Measured 2026-09-04 in a running application: a terminal view mounts, the core places eight native
surfaces with `displaced: 0`, the PTY opens a session and writes its record — and the pane closes
at once. The mirror answers `no surface renders <pane>`, so the pane is absent from its own map.
`supersede` is the only place that map is written and it did not run.

The session index stays empty as a result, which is what this looked like at first. The index write
is correct: a provider-level test covers the whole seam, and a probe in a released build showed the
writer constructed and `attach()` never called.

Red: open a terminal view. `plugin.<terminal>.status` reads `phase: closed` with `panes: []` while
`surface.inventory` holds the surface.

Check: a mounted pane is in the mirror's map before any render command is served; a pane the mirror
does not hold is reported rather than answered `NOT_FOUND` to every caller in turn.

## 17-4. A plugin's failure is observable from outside the renderer

Owner: the core.

The rule and what it cost are in [`AGENTS.md`](../../AGENTS.md) 3-3a. What remains here is the work:
a plugin's uncaught error and its refused command have nowhere to be read. The application log holds
the Go side alone, and `activity` records a command that ran rather than one refused before it ran.

Red: break one link of a plugin's wiring and run the application. Nothing reports it.

Check: both reach somewhere a person reads without rebuilding the plugin — the same place, whatever
the transport. A view that stops working reports it there.

## 17-3. The command a session owner's view calls is named by the contract

Owner: `soksak-contract-control`, and the two sides that read it.

Measured 2026-09-04: the terminal kit called `session_attach` with `viewId`. The command it can run
is `session.attach` with `view` — the first is the Go registry name and the kit runs catalog names,
and the parameter is spelled differently. Either mismatch alone leaves the index empty, and both
were invisible: the runner returns `{ok:false}` rather than raising, so a name nothing serves looks
like a success to a caller that only catches.

Done: `soksak-contract-control` defines the names and their parameters in
`session-command-vectors.json`, in the same form as `address-vectors.json`, with a test that the
file is well formed.

Open: neither side reads it yet. The core registers its catalog names from its own source, and the
kit spells them in its own. Each has to be graded against the file, and the core's dependency on the
contract has to move to a version carrying it.

Red: rename a parameter on either side. Nothing fails until a person opens the session listing and
finds it empty.

Check: the core's catalog registers exactly the declared names with exactly the declared parameters;
the kit's calls are the declared names; a side that spells a name of its own fails.

## 17-2. The recorded modes have a producer and a consumer

Owner: `soksak-kit-plugin-terminal`, and the host PTY capability between it and the session owner.

`pty.modes` is served by the PTY owner (`control.go`) and defined by the contract, and nothing
calls it in either direction. Measured 2026-09-04: the only occurrences across the repositories are
the definition, the handler and a comment. `record.Modes` is empty for every session that has ever
existed, so S4-5's second half has never happened.

Done: the terminal binding records a mode report and reads one back over `pty.modes`, which the
owner has served in both directions all along.

The pieces are all here. The mirror reports its modes — `soksak-kit-sidecar-terminal` answers
`modes()` and they travel in the frame — and `soksak-contract-terminal` encodes them as a
`ModeReport`. What is missing is the wire: the terminal binding has no modes call, so a mirror's
modes never reach the owner and nothing reads them back before a replay.

Why it matters: a mode set before the retained output begins is in no byte the store holds. A
rotation drops the half that set it, and the replay then draws into a mirror in the wrong mode —
the alternate screen being the visible one. That is the case the record exists for.

Red: set a mode, produce more than one segment of output, restart the owner, replay. The mirror is
in the mode it started in rather than the one the session was left in.

Check: the modes reach the record when they change and not on a cadence; a restore reads them and
applies them to a fresh mirror before any replayed byte; the owner still applies none of them
itself, because parsing output is the mirror's work.

## 18. A plugin can take back what it stored

Owner: `soksak-core`.

A plugin could write and read and never remove. A record then outlived the thing it was for and
nothing addressed it — a session that closed, a view that is gone, a key a build stopped writing —
and the store grew by everything that ever existed with no command able to shrink it.

Red: a session closes and its record stays in the plugin's store for the life of the home.

Check: `plugin_data_delete` removes one value; deleting what was never written is not a failure; a
key that would address another plugin's data is refused the way a read and a write refuse it.

## 19. The session question goes wherever the owner runs

Owner: `soksak-core`.

The question went to units and nowhere else, so a component that holds sessions and is not a unit
could not be asked. Where an owner runs is not what the core is asking: a unit answers over its own
socket, a plugin answers in the renderer that already delegates its command names to this registry,
and the command is the same either way.

One name, both places. A name per place would make the core hold where an owner runs before it
could ask.

Red: a plugin owns sessions and `session.list` cannot ask it about them.

Check: a unit owner is asked over the sidecar host and a plugin owner through the registry; both are
sent `system.sessions`; an owner that answers nowhere refuses rather than reporting an empty report,
because an empty report is a session counted lost.
