---
kind: guide
status: active
canonical: tech/COMPONENT-HANDOFF.md
scope: workspace
---

# Component handoff execution

Execution order for [`COMPONENT-HANDOFF.md`](COMPONENT-HANDOFF.md). Each item states the repository
that owns it, the red that must fail first, and the check that closes it. An item is closed only
after its check runs and reports the stated result.

## Rules for this work

- Establish a mechanical red before implementation and confirm it fails for the stated reason.
- One repository per commit. A change in `soksak-core` and a change in a contract are two commits in
  two repositories.
- The core reads a declaration and a count. It does not read a sidecar's descriptors, its
  serialization, or its plugin's commands.
- No compatibility path. A manifest without `handoff` reads as `none`; there is no second reader.
- A capture is not a pass. Every item closes on a command result or a test.

## State

| # | Item | Repository | Red | Implementation | Check |
| --- | --- | --- | --- | --- | --- |
| 1 | Record removal follows process exit | `soksak-core` | [x] | [x] | [x] `018ee6a` |
| 2 | S4 and S5 state the reporting rule | `soksak-core` | — | [x] | [x] `3f085b1` |
| 3 | `handoff` manifest field | `soksak-spec` | [ ] | [ ] | [ ] |
| 4 | `sidecar.status` covers every live process in this home | `soksak-core` | [ ] | [ ] | [ ] |
| 5 | `sidecar.mismatch` | `soksak-core` | [ ] | [ ] | [ ] |
| 6 | `sidecar.restart` at level `none` | `soksak-core` | [ ] | [ ] | [ ] |
| 7 | Mismatch surface in the window | `soksak-core` | [ ] | [ ] | [ ] |
| 8 | `pty.handoff` request and response | `soksak-contract-pty` | [ ] | [ ] | [ ] |
| 9 | fd exchange in the PTY sidecar | `soksak-sidecar-pty` | [ ] | [ ] | [ ] |
| 10 | `sidecar.restart` at level `fds` | `soksak-core` | [ ] | [ ] | [ ] |
| 11 | Handoff serialization in the terminal contract | `soksak-contract-terminal` | [ ] | [ ] | [ ] |
| 12 | State exchange in each terminal sidecar | each sidecar repository | [ ] | [ ] | [ ] |
| 13 | `sidecar.restart` at level `state` | `soksak-core` | [ ] | [ ] | [ ] |

---

## 1. Record removal follows process exit — done

`Stop` removed the record before ending the process. When `end` failed the process kept running
with no record: adoption read none, `Started` returned nothing, and the next start would create a
second process for the same unit name.

Red: `core/sidecar/stop_record_unix_test.go`. An adopted unit whose process ignores the signal; the
wait ends at its deadline and the process is running when `Stop` returns.

Check: the red failed at `stat run/sidecar-fake-unit.json: no such file or directory`, passed after
the change, failed again when the change was reverted, and passes with it restored. Package green.

Measured 2026-09-03: `soksak-sidecar-terminal-alacritty` 0.0.38 ran for 17 minutes with no record
while `environment.json` selected 0.0.47. `sidecar.status` returned one unit; two were running. A
terminal view failed to open and reported `unknown surface command`.

## 2. S4 and S5 state the reporting rule — done

S4 required the core to end a unit serving another version before starting the selected one. That
ends the sessions the unit holds, and `soksak-contract-pty` states the split process exists so
those sessions outlive an application generation. The two rules contradicted.

S4 now states that the core reports the mismatch and starts no replacement. S5 states that a record
is removed after the process exits, never before. Both halves and their Korean translations are
updated.

## 3. `handoff` manifest field

Owner: `soksak-spec`.

Add `handoff` to the sidecar manifest with values `none`, `state`, `fds`. Absent reads as `none`.

Red: a manifest declaring `handoff: "partial"` is accepted by the current validator. Confirm the
acceptance before changing the parser.

Check: `parseSidecarManifest` refuses an unknown value and accepts each of the three; a manifest
without the field parses with `none`.

## 4. `sidecar.status` covers every live process in this home

Owner: `soksak-core`.

`Started` reads `host.open`, so a process a previous generation left is absent from the result. The
2026-09-03 measurement is that absence.

Red: with a record present and no entry in `host.open`, `sidecar.status` omits the unit. Write the
red against a host whose map is empty and whose run directory holds a record for a live process.

Check: the unit appears with its recorded version and pid; a record whose process is gone is removed
and omitted.

## 5. `sidecar.mismatch`

Owner: `soksak-core`.

Compare the running version of each unit against the version `environment.json` selects. Read the
declared level from the manifest of the selected artifact. Ask the unit for its count through the
contract its plugin declares.

Red: with a running version different from the selected version, no command reports it.

Check: an entry `{ name, running, selected, handoff, attached }` per differing unit; an empty array
when every version agrees. The command starts no unit and ends none — assert the process set is
unchanged across the call.

## 6. `sidecar.restart` at level `none`

Owner: `soksak-core`.

End one named unit and start the selected version. Refuse a name absent from `sidecar.mismatch`.

Red: no command performs the replacement.

Check: the unit runs the selected version afterwards; the command refuses an unknown name and a
name whose versions agree.

## 7. Mismatch surface in the window

Owner: `soksak-core`.

Show each mismatch and offer the restart. The surface states the count the unit reports, because at
level `none` the restart ends those resources.

Red: `sidecar.mismatch` returns entries and no window surface shows them.

Check: an exposed DOM node per entry with an addressable restart control; `ui.tree` lists them and
`ui.input.click` performs the restart. A capture confirms the layout and is not the pass.

## 8. `pty.handoff` request and response

Owner: `soksak-contract-pty`.

`CommandHandoff` exists as a name. Specify the request, the response, the acknowledgement, and the
deadline. State that target descriptor numbers sit above every source and acknowledgement
descriptor, and that the successor's ring continues from the coordinates it receives.

Specify how the successor applies a size to a descriptor it adopted, and that the successor reports
the version of its own artifact rather than a version inherited from the environment it was started
with.

Red: the specification names the command and defines no wire.

Check: the specification defines both messages; the conformance suite covers the acknowledgement,
the deadline, a size applied to an adopted descriptor, and the version the successor reports.

## 9. fd exchange in the PTY sidecar

Owner: `soksak-sidecar-pty`.

Implement the exchange and change the reported level from `HandoffNone` to `HandoffSafeFDs`. The
level is reported only after the conformance suite passes; a level a build cannot keep is a defect.

Red: `pty.status` reports `handoff: 0`.

Check: a session survives the replacement — the shell process id is unchanged, the ring coordinate
continues, and the output the session produced up to the replacement is readable after it. A size
applied after the replacement takes effect in the shell. `sidecar.mismatch` is empty after the replacement.

## 10. `sidecar.restart` at level `fds`

Owner: `soksak-core`.

Order the exchange, wait for the acknowledgement, and report the count carried. A successor that
fails or does not acknowledge leaves the predecessor serving.

Red: `sidecar.restart` performs the `none` path for a unit declaring `fds`.

Check: the sessions are unchanged across the restart; a successor that fails leaves the predecessor
serving and the selected version unused.

## 11. Handoff serialization in the terminal contract

Owner: `soksak-contract-terminal`.

§5 defines `rehydrate` as the live serialization and §7 defines the degraded path. Specify the
handoff request that takes that serialization once, at replacement, for every session the mirror
holds, and the successor's restore acknowledgement.

Red: the specification defines no request that serializes every session at one instant.

Check: the specification defines both messages; the conformance suite covers a restore that reports
failure.

## 12. State exchange in each terminal sidecar

Owner: each terminal sidecar repository.

Implement the exchange and declare `handoff: "state"`.

Red: the manifest declares no level, so the core reads `none`.

Check: the declared reference state is reproduced after the replacement, per the conformance suite
each unit already runs.

## 13. `sidecar.restart` at level `state`

Owner: `soksak-core`.

Order the serialization, start the successor, wait for the restore acknowledgement, and report.

Red: `sidecar.restart` performs the `none` path for a unit declaring `state`.

Check: the screen is unchanged across the restart; a restore that reports failure leaves the
predecessor serving.
