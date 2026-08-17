---
kind: canonical
status: active
canonical: self
---

# G0–G5 — which criteria stand, and the number that says so

G0 to G5 are completion criteria, not implementation steps. Each names a point
where a working product stands. **This records which of them stand today, the
command that judges each, and what that command actually answered.**

A gate is only listed as standing when a command answered it on a running
build, with the date. A test passing is not the same claim and is noted as such.

## Scope

This is the state of the criteria. The rules are in `AGENTS.md`; each gate's
contract is in its own canonical document, linked below.

---

# Standing

## G0 — the substrate: contracts, window, control plane, capture, DOM address

| Judged by | Answered |
| --- | --- |
| `go test ./...` · `go vet ./...` | clean |
| `CGO_ENABLED=0 GOOS=windows go build ./...` | builds — Windows stays pure Go (NATIVE-LAYER N3) |
| `go test ./core/...` | the core answers commands with no window |
| `sok ui.tree` | every reachable node carries `data-node` |
| `sok window.snapshot` | writes a PNG without taking focus |
| `task verify:drawn` | what a link names is what the window draws, and an open modal leaves no surface above it |

Contracts: [`ARCHITECTURE.md`](ARCHITECTURE.md), [`CONTROL-PROTOCOL.md`](CONTROL-PROTOCOL.md),
[`MESSAGE-PROTOCOL.md`](MESSAGE-PROTOCOL.md), [`NAMING.md`](NAMING.md),
[`IDENTITY.md`](IDENTITY.md), [`REPO-LAYOUT.md`](REPO-LAYOUT.md),
[`PLUGIN-CONTRACT.md`](PLUGIN-CONTRACT.md), [`SIDECARS.md`](SIDECARS.md),
[`NATIVE-LAYER.md`](NATIVE-LAYER.md), [`I18N.md`](I18N.md), [`UI-GEOMETRY.md`](UI-GEOMETRY.md).

## G1 — one terminal

A real login shell in a pane, driven from outside. `sok term.exec` round-trips
bytes; closing the window leaves no child process. The terminal is a plugin —
the core names no engine, held by `coupling_gate_test.go`.

## G2 — n-ary recursive split

| Judged by | Answered 2026-08-16 |
| --- | --- |
| `splitTreeScale.test.ts` | 64 same-direction splits give 65 siblings and one split node; 64 alternating; closing newest-first back to the single leaf; the last leaf refuses |
| `sok layout.verify` | 69 panes, worst 0.0125px against a 0.5px tolerance, nothing missing, nothing unexpected |

`layout.verify` subtracts the declared rect from the measured one for every
pane. Read `settled` first: during a layout transition the numbers describe a
frame. See [`UI-GEOMETRY.md`](UI-GEOMETRY.md) R5a.

A cell smaller than the chrome that has to fit inside it is refused —
`pane.split` answers `TOO_SMALL` with the measurement and the floor, and the
rail's share of the row is part of that arithmetic.

## G3 — the native browser surface

| Judged by | Answered 2026-08-16 |
| --- | --- |
| `sok surface.composition` | worst 0 through a split, a gutter resize, maximize and restore, at 999×535 and 1200×800 |
| the five verbs | navigate to iana.org gave title "Example Domains"; back returned to example.com with the title following |
| `sok window.snapshot` | the page is in the image — the capture is finished with each surface's own pixels |

Contract: [`NATIVE-SURFACES.md`](NATIVE-SURFACES.md).

## G4 — the rail

| Judged by | Answered 2026-08-16 |
| --- | --- |
| `sok layout.transition.journal` | 2026-08-16: every travelling record held 0 rail surfaces and every settled record exactly 1. The rule changed 2026-08-17 — a region that owns width stays on the screen while the panes travel, so a travelling record now holds 1 as well. Removing it left 165 points belonging to nobody for 183–194ms on every move that changed which pane the rail follows, measured over all six moves in the named three-pane window and seen in the recorded frames |
| `sok layout.arrangement` under PIN | a focus change wrote no arrangement record — nothing moved |
| `sok layout.arrangement` under FLOW | four focus changes, each landing the station on the focused pane's left clean line |
| `sok ui.focus.state` | the aperture's target is the focused pane |

Contract: [`SIDEBAR.md`](SIDEBAR.md).

## G5 — persistence and restore

| Judged by | Answered 2026-08-16 |
| --- | --- |
| `sok state.fingerprint` across six cold restarts | digest `54f43f70` every time — a three-pane layout with a browser tab and a pinned rail |
| the ledger | steady at 3 slots; the snapshot sweep forgot 21 records on the run after it landed and 0 on the next |

Contract: [`RESTORE.md`](RESTORE.md).

---

# The gates that hold the rules

Every one of these has been shown to fail on a planted violation. A gate nobody
has watched fail is a claim, not a gate.

| Gate | What it holds |
| --- | --- |
| `coupling_gate_test.go` | the core names no plugin and no rendering engine (C1) — `frameworks/` is scanned too, with a per-file allowlist that states a reason for each; and no **domain concept** (C6), comments stripped, exemptions empty |
| `docs/tech/CORE-CENSUS.md` | every core surface counted and judged by C6 — the register the next addition is measured against |
| `history_gate_test.go` | the core does not act on a browser's history, and writes down no surface kind |
| plugin `manifest_gate_test.go` | a source writing `data-native-surface` has a manifest declaring it, and the reverse |
| `prose_gate_test.go` | comments and bundle values stay out of the banned register (§6-3) |
| `korean_gate_test.go` | Hangul stays in the bundles; the floor is 43 lines and every one accounted for |
| `record_language_gate_test.go` | the record is English, commit messages included (6-1) — the floor is zero, no allowlist |
| `i18n_gate_test.go` | a sentence a person reads comes from a key |
| `reader_language_gate_test.go` | a refusal from a window is a key, rendered where the caller is known |
| `plural_gate_test.go` | an English sentence that counts declares both forms; a Korean one declares none |
| `contentview_gate_test.go` | the core and the page name content view events identically |
| `bindings_gate_test.go` | the generated bindings say what the Go says |
| `provenance_gate_test.go` | the record names no preceding implementation |
| `sweep_gate_test.go` | a translation sweep changes no code |
| `observation_gate_test.go` | what the build claims to observe, it serves |
| `docs_carried_gate_test.go` | a carried document is not cited as contract before its review |
| `layout_scenarios_gate_test.go` | in the named window — a terminal top left, a browser under it, a terminal filling the right — every one of the six ways focus can move leaves no hole between a region and the panes, no stale declaration, and no page the native layer holds away from where the document put it. Read frame by frame inside the window (`layout.trace`), and a case whose window stalled is reported rather than judged: a page cannot follow a pane that jumped 160 points in one step |
| `surface_alignment_gate_test.go` | a person's click on the exposed region toggle leaves the page on its pane |

---

# Not done

Written here so it is not rediscovered (L2).

- **Windows and Linux are compile-only.** Every driver fails by name. Their
  runtime and visual behaviour is unverified, and no green is recorded for them.
- **Windows terminal needs ConPTY.** `creack/pty` does not cover it.
- **The transition journal's frame number is null.** `window.record` numbers its
  frames and that number is meant to be the clock every journal shares; the
  arrangement records are not stamped with it yet, so a record cannot be lined
  up with a saved picture.
- **`rail.settled` is a check, not a command.** It reports inside the validation
  surface.
- **Four things the core used to do, nobody does yet.** Each left as a feature
  under C6 (`CORE-CENSUS.md`), and no plugin has written its replacement:
  bookmarks, opening a file in a tab, a natural-language console, and a media
  proxy. The seams they need are all in place — a plugin view, a registered
  command, `app.data`, the activity stream.
- **Nothing measures a plugin's status-bar item.** The bar draws only registered
  items now, and no gate refuses a core-drawn one coming back.
- **Plugin loading beyond these two plugins is untried.** The terminal and the
  browser are installed and driven; nothing has exercised a third.
- **Two plugin types are still in the host's own signatures.** `register.go`
  types `HostDeps.Sessions` as `terminalcmd.Sessions`, and `terminal_sink.go`
  takes `terminal.Handle` and `terminal.InputTrace`. A second terminal plugin
  would need a second field. Both are entered in `couplingWiring` marked DEBT
  with the reason, so the gate refuses any *new* file in `frameworks/` that
  names a plugin. The core owns no session contract and no trace contract for
  them to be typed against yet.
- **One surface behind another is still unmeasured.** A DOM overlay is covered:
  `surfaceShown` takes the open-overlay count as a layer, and `verify:drawn`
  opens the plugin manager and reads `surface.composition` for anything still
  visible. A page against the *document* is covered too: `layout.alignment`
  answers `over`, how far a page is drawn into a region's band, and the scenario
  gate holds it at zero across all six moves. What no reading covers is surface
  against surface — two native rectangles in one window, where `presence` and
  `misparented` both answer about the window rather than about the order inside
  it.
- **A blank browser after a restart is reported and not reproduced.** A person
  reported 2026-08-17 that a restart comes up with the page empty until
  something else happens. Nine cold starts that day, read at t+2s, t+3s, t+4s,
  t+7s and out to t+16s, had every browser surface declared and applied visible
  and the page painted. The first attempt to reproduce it did fail — against a
  reading that parsed the wrong answer shape, before `CONTROL-PROTOCOL.md` C2a —
  so that attempt says nothing. It stays open with no reproduction.
- **A command that answers nothing** — found and fixed 2026-08-17.
  `workspace.region.toggle` was silent past the client's 20 seconds, one run in
  three. Its deadline was already there; what could not be reached was the check.
  The wait yielded on `requestAnimationFrame` alone, and a window the system has
  stopped drawing produces no frame, so the loop that would have looked at the
  clock never ran again. Every wait for a frame now goes through `nextFrame`,
  which resolves on the frame or on a 16ms timer, whichever comes first
  (`lib/nextFrame.ts`, with the test that hangs without it). Four consecutive
  runs of the gate that reproduced it are clean.

  What is still missing is a reading for "the renderer took the request and has
  not answered": the client's timeout is the only evidence, and it names the
  command rather than what it is waiting on.
- **The window does not draw at its own rate while the layout moves.** Measured
  2026-08-17 with `layout.trace` on a quiet machine: the frame clock ran every 18
  to 32ms rather than every 17, and one commit in a move cost 45 to 71ms on a
  loaded one. The declaration is exact (`lag` 0) and the native layer holds what
  it was given (0 age-corrected), so what a person sees as a page lagging its
  pane is set by those two numbers. The scenario gate reports a case whose window
  stalled rather than judging it — a page cannot follow a pane that jumped 160
  points in one step — so the stall is the open item, not the surface.
