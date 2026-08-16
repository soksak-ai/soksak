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

## R3. Every id is minted again, and that is the contract

An identifier is a name for one run. A restore rebuilds the workspace, its
spaces, its panes, its tabs and its split nodes under freshly issued names, and
rewrites every reference between them so nothing points at a name that is gone.

Anything judging a restore therefore judges the shape, not the names — which is
why `state.fingerprint` holds no id. A workspace is identified across a restart
by its **root** (V1), a window by the key `window/<label>`, and the ledger names
its slots by root as well.

Only split ids were minted until 2026-08-16; everything else was carried across
verbatim. That is how `t1` — a counter with no prefix, from before the issuer
existed — was the workspace id of three separate window snapshots at once,
months after nothing could mint it. A store is where a retired shape outlives
the code that made it, and reuse was the way in.

Minting the workspace alone would be worse than minting none. A native surface
label pairs a window name with a view id, the window name is issued fresh at
every open, and a stale view id beside it makes one value with two lifetimes.

**A stored id is not repaired, it is replaced.** A snapshot this build cannot
read is left where it is (R1); an id it can read is still not the name the
restored thing takes.

Two references outlive the names and are rewritten with them, because each fails
quietly if it is not: the **active workspace** — matched on the stored name it
falls through to the first workspace every time, and a person finds the wrong
one open — and the **projection seed**, which keyed by the stored name seeds a
workspace that does not exist, so a pinned rail comes back unpinned.

Measured 2026-08-16 on the running application, one restart of a three-pane
layout: every id changed (`pan-672zkd` → `pan-76o76o`, `spc-rspwsl` →
`spc-wmx7kp`, and `t1` gone for good) and `state.fingerprint` answered
`b2745219` both times.

Gate: `frontend/src/state/restoreMintsIds.test.ts` — every id minted, every
reference following. `frontend/src/state/windowPersistence.test.ts` holds the
two references above.

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

- **K1. Records from before two retired shapes are still in this developer's
  store.** Two window snapshots predate the project → workspace rename, and one
  slot is labelled `w-9c38739854301c21` — the one-letter window prefix N1
  retired, which `validWindowName` no longer accepts.

  All three are reported by name and left alone. Measured 2026-08-16, one boot:
  `respawn:spawned:win-8ed56cd7d9305935`,
  `respawn:unreadable:win-a2824af5b4a84873`,
  `respawn:unreadable:w-9c38739854301c21`. Each costs its own record and nothing
  else (R1), and the slot stays rather than being deleted on its author's
  behalf.

  No migration is written: L11c says old paths are deleted rather than bridged,
  and a personal store is not a reason to add one. A fresh install has none of
  them. This is different from R3 — an id inside a snapshot is replaced on the
  way in because it names nothing outside that snapshot, while a window label
  **is** the store key and cannot be replaced without losing the record it
  keys.
- **Native surfaces are not part of the fingerprint.** `surface.composition` is
  judged on its own (NATIVE-SURFACES V1) and a surface is rebuilt from its
  declaration after the panes come back, so it is a consequence of the layout
  rather than a separate thing to compare.
