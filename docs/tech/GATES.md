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
| `min-median-max/soksak-terminal-tests` installed UI suite | released plugins are installed through Core; steady-state alignment, coverage, capture, and recording are verified |

Contracts: [`ARCHITECTURE.md`](ARCHITECTURE.md), [`CONTROL-PROTOCOL.md`](CONTROL-PROTOCOL.md),
[`MESSAGE-PROTOCOL.md`](MESSAGE-PROTOCOL.md), [`NAMING.md`](NAMING.md),
[`IDENTITY.md`](IDENTITY.md), [`REPO-LAYOUT.md`](REPO-LAYOUT.md),
[`PLUGIN-CONTRACT.md`](PLUGIN-CONTRACT.md), [`SIDECARS.md`](SIDECARS.md),
[`NATIVE-LAYER.md`](NATIVE-LAYER.md), [`I18N.md`](I18N.md), [`UI-GEOMETRY.md`](UI-GEOMETRY.md).

## G0a — the arrangement, before anything is measured about it

Every other question about a layout — how long a motion takes, whether a page
travels with its pane, whether a frame blinks — is a question about a window that
is already the right window. None of them was asked first, and on 2026-08-17 a
person looked at a window these gates had left and said the sidebar was gone,
while every reading passed.

So the window is stated before it is measured, and each of the nine ways focus can
move between its three panes is a test of its own, run by name. What it refuses:

| Judged by | Answered 2026-08-18 |
| --- | --- |
| the section standing | the one linked to the focused view's plugin, by key, read off the screen |
| where the sidebar stands | to the left of the view that was clicked, an inset away, nearer it than anything behind |
| the band it holds | the panes' band — it held 45..617 where the panes held 87..612 |
| what it looks like | the same card as the view it stands against: rgb(14,15,21) beside rgb(21,22,30) failed |
| the three panes | the shape they were built in, whatever the sidebar does |
| every address | one node each — two places had written their cells under the same name |
| the evidence | a picture per case, kept from the recording of that case |

Each of those was added the day a person saw what the gate did not ask. Installed-product checks
belong to `min-median-max/soksak-terminal-tests`, not this core repository.

It waits on the window's own events, not on a clock. Each click stamps a `causeTraceId` and
`layout.transaction.wait` waits for that one transaction after the journal sequence the click was
issued at; a click that moves nothing opens none, and `tab.activate` answers `moved` so the wait is
not asked for where there is nothing to wait on. What was there read the arrangement every 250ms
and called the window settled when two readings agreed — true of a window that has finished, of one
whose motion the readings straddled, and of one that had not begun. It failed three runs in six and
the failure named the socket rather than the reason, because the application's output was thrown
away; the gate keeps it now and reports the last of it when the process stops answering.

## G1 — one terminal

A real login shell in a pane, driven from outside. `sok term.exec` round-trips
bytes. The terminal is a plugin — the core names no engine, held by
`internal/repositorygate/coupling_gate_test.go`.

The application has no shell to leave behind: since 2026-08-20 the shell is a
child of the PTY sidecar, which is a separate process precisely so a shell survives
an application generation. Closing a window therefore ends nothing by itself.
The window publishes that it is going, the surviving plugin instances hear it,
and the terminal plugin asks its PTY sidecar to let that window's sessions go — which
is where "no child process" now lives, one process further out.

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
| `sok layout.transition.journal` | 2026-08-16: every travelling record held 0 rail surfaces and every settled record exactly 1. The rule changed 2026-08-17 — a place that owns width stays on the screen while the panes travel, so a travelling record now holds 1 as well. Removing it left 165 points belonging to nobody for 183–194ms on every move that changed which pane the rail follows, measured over all six moves in the named three-pane window and seen in the recorded frames |
| `sok layout.arrangement` under PIN | a focus change wrote no arrangement record — nothing moved |
| `sok layout.arrangement` under FLOW | four focus changes, each landing the station on the focused pane's left clean line |
| `sok ui.focus.state` | the aperture's target is the focused pane |

Contract: [`SIDEBAR.md`](SIDEBAR.md).

## G5 — persistence and restore

| Judged by | Answered 2026-08-16 |
| --- | --- |
| `sok state.fingerprint` across six cold restarts | digest `54f43f70` every time — a three-pane layout with a browser tab and a pinned rail |
| the ledger | steady at 3 slots; the snapshot sweep forgets 0 records on the final run |

Contract: [`RESTORE.md`](RESTORE.md).

---

# The gates that hold the rules

Every one of these has been shown to fail on a planted violation. A gate nobody
has watched fail is a claim, not a gate.

| Gate | What it holds |
| --- | --- |
| `internal/repositorygate/coupling_gate_test.go` | the core names no plugin and no rendering engine (C1) — `frameworks/` is scanned too, with a per-file allowlist that states a reason for each; and no **domain concept** (C6), comments stripped, exemptions empty |
| `internal/repositorygate/history_gate_test.go` | the core does not act on a browser's history, and writes down no surface kind |
| plugin `manifest_gate_test.go` | a source writing `data-native-surface` has a manifest declaring it, and the reverse |
| `prose_gate_test.go` | comments and bundle values stay out of the banned register (§6-3) |
| `korean_gate_test.go` | Hangul stays in bundles or paired `.ko.md` translations; unpaired translations fail |
| `record_language_gate_test.go` | the record is English, commit messages included (6-1) — the floor is zero, no allowlist |
| `internal/repositorygate/i18n_gate_test.go` | a sentence a person reads comes from a key |
| `reader_language_gate_test.go` | a refusal from a window is a key, rendered where the caller is known |
| `plural_gate_test.go` | an English sentence that counts declares both forms; a Korean one declares none |
| `contentview_gate_test.go` | the core and the page name content view events identically |
| `bindings_gate_test.go` | the generated bindings say what the Go says |
| `internal/repositorygate/provenance_gate_test.go` | the record names no preceding implementation |
| `sweep_gate_test.go` | a translation sweep changes no code |
| `internal/repositorygate/observation_gate_test.go` | what the build claims to observe, it serves |
| `docs_carried_gate_test.go` | a carried document is not cited as contract before its review |
| `min-median-max/soksak-terminal-tests` inventory | the environment declares the fleet manifest's exact plugin and sidecar versions, with absolute paths and regular manifests |
| `min-median-max/soksak-terminal-tests` command suite | every terminal plugin opens, reads, writes, resizes, handles Unicode and 256 KiB output, exposes DOM/accessibility, and produces capture and recording files |
| `min-median-max/soksak-terminal-tests` lifecycle suite | every terminal preserves its shell PID and detached output across restart, restores a durable archive, and rejects archived input |
| `min-median-max/soksak-terminal-tests` UI suite | plugin rejection count is zero, `ui.verify` passes, surface coverage is zero, and steady-state surface drift is at most 2px |
| `min-median-max/soksak-terminal-tests` resize evidence | every resize records DOM pixels, requested PTY size, PTY observation, recovery observation, rendered frame, and the first boundary that did not advance |

---

# Not done

Written here so it is not rediscovered (L2).

- The external installed-product suite does not yet reproduce the former frame-by-frame rail and
  section-placement scenarios. It currently verifies steady-state alignment and coverage. The
  motion stimulus and `layout.trace.native` verdict must be added there before claiming those
  interaction cases are restored.

- **A commit the compositor never answers stalls `ui.layout.wait-settled`.** The deadline releases
  the observer and names an unanswered commit, but the installed interaction suite does not yet
  reproduce and classify the pending presentation boundary. Completion requires a released fleet
  scenario whose native trace distinguishes delivery, compositor commit, and presentation receipt.

- **A sidecar stream and sidecar lifetime were one command, and a release ended shells.** Fixed
  2026-08-20 the day it was written: `sidecar_close` signalled the process, and a plugin being
  disabled called it — so disabling a terminal plugin ended the shells somebody was working in,
  which is the exact thing a sidecar process exists to prevent. Releasing a channel and ending
  a sidecar are `sidecar_release` and `sidecar_stop` now, and nothing on the plugin path calls the
  second.

  Found by a review of the tree rather than by a gate. What would have caught it is a reading of
  whether a shell outlives a disable, and there is none: every test here starts a sidecar and ends it
  inside one run.

- **Host and sidecar are only checked where they share a type.** The contract module they both import
  makes a shape mismatch a compile error, and nothing measures the rest: a host that greets wrongly,
  a sidecar that answers a command it declared and does nothing for, an address one binds and the other
  cannot reach.

  Such a test belongs in `min-median-max/soksak-terminal-tests`, which owns the installed host and sidecar
  pair without making either owner repository depend on the other.

- **The i18n ownership rule is stated and unenforced.** `REPO-LAYOUT.md` L1b says a message is owned
  by whatever it is about, and no gate holds it. Each plugin or sidecar owner test must enforce it.

- **Whether a distributed build may load a third-party module is unmeasured.**
  This build ad-hoc signs and carries no entitlements, so nothing stops a load
  today. A distributed one is notarised, notarisation wants the hardened
  runtime, and the hardened runtime validates what a process loads — there is an
  entitlement named for turning that off, which is a decision about the whole
  application's posture rather than about one module.

  Measure it before the engine host ships. A host built without that answer is a
  host that works until the day the application is signed for release.

- **Four things about loading a module are unmeasured.** A host loaded a module
  built in the same language and both ran at once — two schedulers, two garbage
  collectors, two timers, a panic recovered inside the module (measured
  2026-08-20, macOS, 300ms). What that reading does not cover:

  - **Signal handlers.** Each runtime installs its own for faults and profiling.
    What the second installation does to the first is unknown, and a fault is
    where it would show.
  - **The other two targets.** Building a module needs a C toolchain for its own
    platform; this machine has one for itself only, so Windows and Linux were
    not reached.
  - **Unloading.** Whether a module can be closed, or whether a load is for the
    life of the process.
  - **A long-lived module.** Three hundred milliseconds is not a session.

  Each is a reading to take before the host ships, not a risk to accept.

- **Windows and Linux are compile-only.** Every driver fails by name. Their
  runtime and visual behaviour is unverified, and no green is recorded for them.
- **Windows terminal needs ConPTY.** `creack/pty` does not cover it.
- **Four product capabilities have no owner.** Each remains a feature under C6
  (`ARCHITECTURE.md`):
  bookmarks, opening a file in a tab, a natural-language console, and a media
  proxy. The seams they need are all in place — a plugin view, a registered
  command, `app.data`, the activity stream.
- **Nothing measures a plugin's status-bar item.** The bar draws only registered
  items now, and no gate refuses a core-drawn one coming back.
- **Plugin loading beyond these two plugins is untried.** The terminal and the
  browser are installed and driven; nothing has exercised a third.
- **The application dies inside Wails' asset server during a recording.** Twice
  on 2026-08-18 and not since: once with the arrangement gate running alone and
  once in a full suite. `window.record` answered `the backend closed without
  answering: EOF` and the socket was gone. Both were in a recording; nothing
  else has produced it.

  Counted against everything that ran after: more than a dozen full suites and
  a dozen runs of that gate alone, none of them crashed.

  The stack was captured once, in the second of the two, and points into the
  pinned upstream Wails release's request path:
  `internal/assetserver/assetserver_webview.go:50`, a goroutine created by
  `AssetServer.ServeWebViewRequest`. That reading also arrived truncated — the
  gate kept the tail of the log and a crash states its reason on the first line
  — so the reason itself has never been seen. It is kept from the reason now,
  and nothing has crashed since to test that.

  Read rather than guessed at, 2026-08-18: Wails catches the scheme-task
  exception whose reason is exactly `"This task has already been stopped"` and
  re-throws every other one — its own comment there says "this is very bad to
  detect a stopped schemeTask". An ObjC exception leaving cgo is a fatal signal,
  which is the register dump that was captured. The task is retained and
  released around the call, so it is not a dead object. That is where the crash
  is; which exception reaches it is not established. A probe that logged the
  reason before re-throwing ran six full suites and never fired, so the probe is
  gone: it measured nothing and a modification to the pinned checkout that
  measures nothing is not kept.

- **A capture can refuse without words.** Measured 2026-08-18 in a run that did
  not crash: a recording stopped with `frame 0 could not be captured: ` and the
  colon was the whole reason. The native layer had filled its error field with
  an empty string. Both halves are named now — the ObjC side substitutes a
  sentence rather than passing nothing on, and the Go side refuses to build an
  error out of no words. Why that path produced an empty message is not
  established; what is fixed is that the next one says so.

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
- **A pane holding a page is drawn by a picture while the layout moves.** The
  page steps aside so the document can draw over its place, and what travels is
  its picture — one instant old, no scrolling, no click. A page that changes while
  a layout moves is a page a person watches change a beat later. Nothing measures
  how stale it looks; what is measured is that the pane is never blank.
- **A covered window is not drawn at the display's rate, and that is not this
  application.** Measured 2026-08-17 with `layout.trace` in the named window,
  covered: a focus change stopped it drawing for 68 to 234ms while JS ran
  throughout — the timer readings never missed a beat — and in front, on the same
  build and the same six moves, it never stopped at all. What was reported here
  first as a stall was the environment. A future installed motion gate must ask it only of a
  window someone is looking at.

  Where it goes is half answered. The paths this build owns are timed and cost 1
  to 4ms of it (`panes.flush`, `rail.flush`, and the plugin reflow, which does not
  reach a millisecond). The rest is the engine's own render and paint, which
  nothing here measures yet — a focus change re-renders a workspace whose panes,
  rail, tab strips and plugin hosts all read the workspace object.

  The external suite does not yet reproduce this frame-by-frame scenario, so this remains not
  done. Completion requires that suite to own the stimulus and native trace verdict.
