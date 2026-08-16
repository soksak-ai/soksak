---
kind: canonical
status: active
canonical: self
---

# Restore — what comes back, and how that is judged

A window that was open when the process ended comes back when it starts again,
holding the same layout. **The judgement is one number**: `sok state.fingerprint`
before and after, and the two are equal.

## Scope

This says what is stored, what comes back, and what is deliberately not carried
across. The store itself is `core/store`; this is the shape written into it and
the boot that reads it.

---

# P. Persisted

## P1. Two keys, and what each is for

| Key | What it holds |
| --- | --- |
| `windows` | the ledger — one slot per window that should come back, with its roots and frame |
| `window/<label>` | one window's layout: its workspaces, spaces, split trees, active pane, rail placement |

The ledger is the record of **what comes back**. A snapshot is the record of
**what it looked like**. They answer different questions and a window needs both.

## P2. The ledger is written on close, not on exit

Closing a window removes its slot: without that the next boot revives a window
the person closed. Exiting does not, because exit closes every window and
emptying the ledger then opens nothing on the next run.

A window that has never been closed is therefore legitimately absent from the
ledger while it is open.

## P3. A snapshot with no slot is forgotten

Measured 2026-08-16: the ledger held 3 slots and the store held 24 snapshots.
Every run that opened a window and closed it left its record behind for good.
That is unbounded growth, and it is also how a record written by a build that no
longer exists was still there to be tripped over (K1).

The main boot forgets every `window/<label>` no slot names and no live window
holds. Live matters: sweeping by the ledger alone deletes the record of the
window a person is looking at. **Without a window census nothing is swept** — an
unreadable census makes every open window look absent.

Measured: the run after this landed forgot 21 records and kept 12 keys; the next
run forgot 0.

---

# R. Restored

## R1. A record this build cannot read costs that record only

Measured 2026-08-16, a cold restart brought nothing back. The ledger held 23
restorable slots and the boot facts read

```
respawn:slots:23:live:1:restorable:23
respawn:error:TypeError: undefined is not an object (evaluating 'a.workspaces.length')
```

Two snapshots predated the project → workspace rename and carried `projects`
where this build reads `workspaces`. The throw left the loop and all
twenty-three windows stayed closed — including the twenty-one this build had
written itself.

Every snapshot now goes through a shape check that names what is wrong with it,
and the loop continues. **The record is left where it is**, not rewritten: this
build keeps no old paths (L11c), and one it cannot read is not one it may
reshape on its author's behalf.

## R2. Unread is not empty

A snapshot that could not be read is reported unread. Written as 0 workspaces it
equals a window that was never used, and the save guard then opens and
overwrites a record this build simply could not parse.

## R3. Every identifier is kept

An identifier is issued to be unique, and it is kept so that state can hang off
it. A terminal session's key is `windowLabel + "|" + paneId`
(`soksak-plugin-terminal-xterm`, `command/session.go` — `paneKey`): a pane that
came back under a new id cannot reattach to the shell it had. The session is
still running, still holding its scrollback and its working directory, and
nothing addresses it any more.

The same holds for anything else keyed by a pane, a view or a workspace —
plugin state, an address a person or an agent wrote down, a projection seed.
Keeping the id is what makes those durable.

**With no exception.** The split node was the one this build minted again, on the
ground that nothing references it — and it was not in the snapshot at all,
measured 2026-08-16, nor in `state.tree` or `ui.tree`. That left one kind of id
whose name a restore changed, so a reader had to know which kind it was holding
before it could tell whether the name would still be there.

A record written before that field is refused rather than mended. No fallback
mints the name and no migration rewrites the record: this build carries no old
paths, and a fallback there would make a restore rename part of itself in
silence, which is the shape that cost a day that same date. The refusal names
what is missing, the record is left where it is, and it costs that record only
(R1). The generator the deserializer took for this is gone with it — there is
nothing left for it to do.

Uniqueness and durability are not in tension here. They were only in tension
while an id was a counter — `t1` was the workspace id of three separate window
snapshots at once because a counter restarts at the same value, not because it
was kept. An identifier from the issuer (N1: six base32 characters from
`crypto.getRandomValues`) stays unique for as long as it is kept.

Measured 2026-08-16, and this is why it is written down: a change that minted
every id on restore passed the digest check and broke the reattach key.
`state.fingerprint` holds no id — that is correct for what it judges, which is
the shape of the layout — so the digest cannot see this and is not the whole
verdict.

Gate: `frontend/src/state/restoreKeepsIds.test.ts`.

---

# V. Verdict

## V1. `sok state.fingerprint`

```
digest                 one number over everything below
workspaces[].root      the workspace's identity (P4), not an id
             mode      flow | pin
             station   the effective rail line
             cleanLines[]
             spaces[].panes[].{ rect, active }
```

**GREEN: the digest before a restart equals the digest after.** The parts are
carried beside it so a mismatch names which one moved.

Rectangles are rounded to the ninth place — two runs of the same solve differ in
the last bits of a double, and a digest counting those would never match twice.
Workspaces are ordered by root, so restoring the same workspaces in another
order is not reported as a difference.

Gate: `restore_gate_test.go`, run by `task verify:restore`. It builds the two binaries, starts the
application against a home of its own, opens a workspace window, reads the digest, quits through
`app.shutdown.commit`, starts again and reads it a second time. It also asserts that every id
changed — a digest that matched because nothing moved would prove nothing about R3.

Quitting through the command rather than killing the process is the whole reason this gate can
exist. A kill skips the drain and the save, and what came back would be the measurement of a crash.
Until 2026-08-16 quitting was not a command this build served, so this verdict was read by hand and
written here: true on the day someone looked, and unowned every day after.

## V2. One cold restart is not the measurement

Measured 2026-08-16, six cold restarts of a three-pane layout with a browser tab
and a pinned rail: digest `54f43f70` every time, the ledger steady at 3 slots,
and the sweep idempotent — 21 forgotten on the run after it landed, 0 on the
next.

---

# K. Known, and not fixed

- **K1. Records from before the rename are still in this developer's store.**
  They are skipped by name and left alone. No migration is written: L11c says
  old paths are deleted rather than bridged, and a personal store is not a
  reason to add one. A fresh install has none of them.
- **Native surfaces are not part of the fingerprint.** `surface.composition` is
  judged on its own (NATIVE-SURFACES V1) and a surface is rebuilt from its
  declaration after the panes come back, so it is a consequence of the layout
  rather than a separate thing to compare.
