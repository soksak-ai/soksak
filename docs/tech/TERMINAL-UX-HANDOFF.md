---
kind: reference
status: active
canonical: self
scope: workspace
---

# Terminal UX defect handoff

This document records the ten reported defects, their current evidence on 2026-08-25, and the
remaining release boundary. TERMINAL-UX-EXECUTION.md defines the required execution order and
evidence. A local candidate GREEN is not an immutable-release or unrun native-platform GREEN.

## Reported defects

All ten items are acceptance requirements. A result that fixes only one provider or one trigger is
incomplete.

1. Every terminal except Xterm is slow.
2. Every terminal except Xterm fails to receive focus.
3. Every terminal except Xterm has no active input cursor.
4. Every terminal except Xterm rejects keyboard input.
5. Opening the tab plus picker blanks each tab view until the picker closes.
6. Opening settings or another modal blanks each tab view until the modal closes.
7. Sidebar motion blanks each tab view during the transition.
8. Xterm and the other terminals use different colors despite using the terminal kit.
9. The macOS traffic-light close button does not close the window.
10. Tests repeatedly open and close visible application windows and interrupt the user.

## Workspace map

The authoring workspace root is ~/soksak/wails3beta. Each component directory below contains
independent repositories. The workspace layout is not a runtime lookup mechanism; installed
components are resolved from environment.json.

| Path from workspace root | Responsibility |
| --- | --- |
| soksak-core/ | Current Wails application, control CLI, renderer, framework adapters, application lifecycle and Core gates. This handoff belongs here. |
| soksak-plugins/ | One repository per installable plugin. The seven terminal provider repositories are here. |
| soksak-kits/ | Shared component implementation. soksak-kit-plugin-terminal owns the common terminal lifecycle and frame presenter; soksak-kit-sidecar-terminal owns the recovery-sidecar runtime. The old terminal-common and engine-as-judge conformance repositories have no consumers and are retired. |
| soksak-sidecars/ | One repository per plugin process. PTY and six frame-producing terminal sidecars are here. |
| soksak-contracts/ | Public contracts and acceptance packages for composition, control, PTY, registry and terminal boundaries. |
| soksak-specs/ | Canonical public schemas and validators. A public state or command shape changes here before consumers. |
| soksak-plugin-registry/ | Published plugin release references. It receives release metadata after implementation and release; it owns no terminal behavior. |
| wails-services/ | Wails host services. Native compositor and webview-surface ownership is here. |
| forks/ | Maintained upstream forks. `origin` is the owned fork, `upstream` is the original, and the maintained branch names the upstream version. Product builds still use the public repository and exact commit, never this path. |
| libraries/ | Independently authored reusable libraries such as xterm-addon-webkit-ime. They are not upstream forks. |
| externals/ | Unmodified third-party comparison source. |
| tests/ | Product-specific system and acceptance repositories. |
| local/ | Developer-only pinned runtimes, source checkouts, test inputs and work state. Product code and tests must not discover dependencies here. |
| evidence/ | Generated screenshots and recordings. It is not product source and is not committed as implementation. |
| backup/ | Retained source that no build or gate may reference. |
| soksak-tauri/ | Archived Tauri application source history. It is not an input to the current Wails build or release. |
| worktrees/ | Temporary Git worktrees. Automation must discover them through Git and must not depend on this path. |
| bin/ | Workspace-local executable convenience directory; currently contains Wails tooling. Product binaries are owned by soksak-core/bin/. |
| frameworks/ | Currently empty and not an ownership category in REPO-LAYOUT.md. Do not place product code here without first defining ownership. |
| .task/ and .claude/ | Local tool state and local agent settings. Neither is a product source boundary. |

No repository may locate another repository with a parent-relative path, injected workspace root or
symlink. Cross-repository consumption uses published packages or the declared environment.

### Terminal repositories in scope

~~~text
~/soksak/wails3beta/
├── soksak-core/                                  application and host integration
├── soksak-plugins/
│   ├── soksak-plugin-terminal-xterm/             byte renderer and comparison baseline
│   ├── soksak-plugin-terminal-alacritty/         frame-provider adapter
│   ├── soksak-plugin-terminal-ghostty/           frame-provider adapter
│   ├── soksak-plugin-terminal-kitty/             frame-provider adapter
│   ├── soksak-plugin-terminal-shitty/            frame-provider adapter
│   ├── soksak-plugin-terminal-vt100/             frame-provider adapter
│   └── soksak-plugin-terminal-wezterm/           frame-provider adapter
├── soksak-kits/
│   ├── soksak-kit-plugin-terminal/               shared plugin lifecycle and frame presenter
│   └── soksak-kit-sidecar-terminal/              shared terminal-sidecar implementation
├── soksak-sidecars/
│   ├── soksak-sidecar-pty/                       PTY process
│   ├── soksak-sidecar-terminal-alacritty/        Alacritty frame producer
│   ├── soksak-sidecar-terminal-ghostty/          Ghostty frame producer
│   ├── soksak-sidecar-terminal-kitty/            Kitty frame producer
│   ├── soksak-sidecar-terminal-shitty/           Shitty frame producer
│   ├── soksak-sidecar-terminal-vt100/            VT100 frame producer
│   └── soksak-sidecar-terminal-wezterm/          WezTerm frame producer
├── soksak-contracts/
│   ├── soksak-contract-plugin-terminal/          plugin behavior contract package
│   ├── soksak-contract-terminal/                 terminal data contract
│   ├── soksak-contract-pty/                      PTY contract
│   ├── soksak-contract-contentview/              content-view contract
│   ├── soksak-contract-control/                  command and event envelope contract
│   └── soksak-contract-registry/                 Registry authentication and continuity contract
├── soksak-specs/soksak-spec/                     public schemas and validators
├── wails-services/wails-service-native-compositor/ native composition application
├── soksak-plugin-registry/                       released plugin references
├── forks/shitty/                                  maintained upstream-version-13 provider fork
├── libraries/xterm-addon-webkit-ime/              independently authored WebKit IME library
└── tests/soksak-terminal-tests/                   installed-product system tests
~~~

The frame-provider plugin repositories are adapters, not seven copies of terminal behavior. Shared
behavior first enters the appropriate kit or contract. A provider repository changes only when its
adapter has a measured provider-specific defect. A sidecar repository changes only when timing or
frame evidence identifies the producer or transport. Installed-product behavior belongs in the
external system tests only after the owning repository has a focused RED.

## Defect ownership

| Defects | Primary owner | Conditional owners |
| --- | --- | --- |
| 1–4 and 8: speed, focus, cursor, input, color | soksak-kits/soksak-kit-plugin-terminal | The Xterm plugin is the comparison renderer. A sidecar changes only if measurements identify frame generation or transport as the cause. Contracts or specs change only for a required public observation surface. |
| 5–7: picker, modal and sidebar blanking | soksak-core frontend visibility and layout state | wails-service-native-compositor changes only where native-surface application differs from the declared Core state. |
| 9: macOS close button | soksak-core/frameworks/wails and Core window lifecycle | A Wails service changes only if the native event boundary is owned there. |
| 10: test interference | soksak-core/internal/application gates and application ownership | External system tests change only if they launch a user-visible application outside the Core-owned isolated runner. |

Terminal plugin repositories must not receive copied focus, input, theme or performance fixes. They
receive only provider-specific adapter changes proven necessary by the shared matrix, plus truthful
dependency and release metadata after the shared implementation is released. Registry updates are
the final publication step, never a way to repair runtime behavior.

## Verified architecture

The terminal kit shares lifecycle, session and status behavior. It does not provide one shared
presentation implementation.

| Providers | Input and presentation path |
| --- | --- |
| Xterm | PTY bytes enter the Xterm parser, presentation, textarea, IME and theme in soksak-plugins/soksak-plugin-terminal-xterm/frontend/src/xterm-renderer.ts. |
| Alacritty, Ghostty, Kitty, Shitty, VT100, WezTerm | A recovery sidecar frame enters the pre and cell-span presenter with a hidden one-pixel textarea in soksak-kits/soksak-kit-plugin-terminal/src/provider-frame-presenter.ts. |

soksak-kits/soksak-kit-plugin-terminal/src/provider-terminal-plugin.ts owns the common provider
lifecycle. Defects 1–4 and 8 therefore require one renderer-parity contract. Provider-specific
copies of focus, input, color or performance fixes are prohibited.

The view visibility boundary spans soksak-core/frontend/src/state/ui.ts,
soksak-core/frontend/src/lib/viewPark.ts, soksak-core/docs/tech/NATIVE-SURFACES.md and
soksak-core/docs/tech/UI-GEOMETRY.md. It now separates active DOM content, live out-of-document
surface visibility and parked pixels. Overlay and layout motion never hide active DOM content. A
live native surface may be hidden while its parked picture preserves the last applied pixels.
Picker, modal and sidebar exceptions are prohibited.

The native close boundary spans soksak-core/frameworks/wails/host.go,
window_host_wails.go, window_commands.go, frontend/src/commands/catalogWindow.ts and
frontend/src/state/windowBoot.ts. A successful window.close command does not prove that an actual
macOS close request performs persistence, registry cleanup and window destruction.

Test window ownership spans soksak-core/internal/application/restore_gate_test.go,
capture_focus_gate_test.go and run.go. Each run receives a unique home, runtime, identifier, socket
and owner. On Darwin, `SOKSAK_PRESENTATION=capture-only` keeps a window compositor-resident,
transparent, mouse-transparent and non-key. Capture reads document pixels without activating the
application. The current Wails runtime admits one test application owner at a time through a
blocking file lock.

## Facts and hypotheses

Verified facts:

- Xterm and the six frame providers use different presentation implementations behind one terminal
  behavior contract and one shared provider lifecycle.
- The corrected frame presenter preserves row/run DOM identity and exposes input, focus, cursor,
  render and PTY-write sequences and timestamps.
- The previous visibility expression hid active DOM content during overlays and layout motion. One
  visibility transaction now keeps DOM content mounted and separates live surface visibility from
  its parked pixels.
- The clean installed-product candidate matrix covers all seven providers. Its capture-only parity
  path uses the public DOM input commands, reports `windowFocused=false`, and proves terminal-to-PTY
  input, cursor state, timing and pixel palette parity without disturbing the foreground app.
- `ui.input.click` and `ui.input.key` dispatch browser events through exposed DOM addresses. They are
  not operating-system input and must not be cited as native pointer or keyboard evidence.
- AppKit does not deliver WebKit keyboard input to an inactive non-key window. Core therefore exposes
  `window.input.pointer.click` and `window.input.key.press`, which require an already active key
  window and never activate the application themselves. The separate `system-native-input` gate
  runs only on an unattended native runner and proves AppKit NSEvent to terminal to PTY delivery.
- The capture-only visibility matrix produced 21 reports and 840 frames across picker, settings and
  sidebar transitions, with zero blank frames and zero violations. The inspected contact sheets
  preserve every terminal image.
- The actual native macOS traffic-light close gate is GREEN three times in the current accumulated
  Core verification.
- Every system run records its process, home, runtime, identifier, socket, windows, input state and
  both open and recorded sidecar ownership. Cleanup leaves both sidecar sets empty and the
  application exits gracefully. Two historical test-owned sidecars were reclaimed through their
  recorded identity; the user-owned application was not changed.

Current unpublished candidates:

- The unpublished terminal contract package 0.0.7 defines terminal behavior interface 0.0.6, one
  256-color palette and one presentation status for byte and frame renderers.
- The kit candidate preserves row/run DOM nodes, exposes input/focus/cursor/render sequences and
  timestamps, and maps bold ANSI foregrounds to the shared bright palette.
- Xterm uses `@xterm/xterm` 6.0.0 and `@xterm/addon-fit` 0.11.0. Its WebKit IME dependency is one
  exact package.json/lockfile Git archive; the release workflow no longer checks out a conflicting
  older source commit.
- A clean candidate closure now exists for the contract, kit and all seven renderer plugins. The
  source manifests and lockfiles retain their public HTTPS dependencies and contain no local
  locator. Candidate provenance records the exact source commit and dependency archive digests.
- The clean candidate closure has passed capture-only parity and visibility matrices. Native AppKit
  pointer/keyboard certification remains separate because it must activate an unattended runner.

Candidate evidence created from the temporary terminal-contract and terminal-kit archives is
invalid. The kit source manifest was temporarily changed to an external local archive and pnpm
serialized that dependency into its lockfile as both an absolute temporary locator and a
parent-relative locator. Reverting the source files did not restore archives or downstream evidence
already created from the contaminated metadata.

Do not reuse any candidate archive or parity, visibility, screenshot or recording result whose
closure included that contaminated kit archive. The clean replacement renderer closure is:

| Artifact | Source commit | SHA-256 |
| --- | --- | --- |
| contract-plugin-terminal 0.0.7 | 0f573cd | 1fd332609d141617372112b43827fc24f30a78f3b8118b3cb1ffe6e5b2bc228d |
| kit-plugin-terminal 0.0.18 | 4620a35 | 32b204a8d48846c0e1b5568f438f49645b172f1f3baf3490369c952b61885f8c |
| plugin-terminal-alacritty 0.0.15 | 16c71ce | d143716752d791395cf5e2e60c2bd190fc39419f051c1efda7992efa734ba914 |
| plugin-terminal-ghostty 0.0.16 | 8bd4805 | 7615dc19649f6647db27c57ff29ed764341b29c0ef29ffcf9adfd60a5e87bbdd |
| plugin-terminal-kitty 0.0.15 | ecb6479 | 38b8001cd610f1a8e6e5bb95f0d1404d42309983d4166501c58d015b05756264 |
| plugin-terminal-shitty 0.0.15 | 8a30c15 | 174a121b6a1fcb84e3360fc40280aae79b06621316d4023145a8494da38eb78d |
| plugin-terminal-vt100 0.0.15 | bc56b75 | 4ab5fbbea8b62b267ca25538b15eb0ebd8283d27dee6a1d0c5f68e4a0c4723e4 |
| plugin-terminal-wezterm 0.0.15 | ba744e8 | b14d3211e6438f909f9af9eb293c60132f7dfcd944731165696d749e9a1d5ce3 |
| plugin-terminal-xterm 0.0.22 | dd3febc | caec620c0cded48fb1082186a532995657a55b154684d4bdf077fdc989f2c30f |

The candidate plan SHA-256 is
`ab94f623ad0e167ee396e91f69bd6249fb0fc98fcb9055c4c2369c9864da35d6`. It also pins PTY and the six
frame-sidecar archives. This table and digest identify the closure; the installed-product reports,
screenshots and recordings remain the behavioral evidence.

The allowed local build-time verification path is defined in
TERMINAL-UX-EXECUTION.md under “Local cross-repository candidate verification.” Direct consumer
manifest or lockfile editing is not a development mode.

`soksak-spec` commits `9de8149` through `25c58b7` own the complete candidate transaction: clean exact
source staging, dependency SHA-256 verification, staging-only workspace override, repository-owned
Make verification, canonical package and lock byte restoration, declared generated-output
projection, local-locator rejection and verified archive exit with `candidate-build.json`. Current
spec source `0a1e217` also supports long ustar paths while preserving those boundaries. Staging
metadata and `.candidate-inputs` do not enter the archive.

## Current progress and blockers

| Defect | State on 2026-08-25 |
| --- | --- |
| 1 — latency | Local Darwin candidate GREEN. Seven providers render within 1–3ms against a 16.67ms budget; input-to-PTY is 2–8ms against a 50ms budget. |
| 2 — focus | Capture-only public DOM route GREEN for seven providers. Final AppKit native pointer matrix is implemented but not yet run on the unattended native runner, so native certification remains open. |
| 3 — active cursor | Local candidate GREEN for exposed active/visible cursor state and inspected pixels. It remains coupled to the pending native pointer certification for user-input acceptance. |
| 4 — keyboard input | Capture-only terminal-to-PTY round trip GREEN for seven providers. Final AppKit key-to-PTY matrix is implemented but not yet run on the unattended native runner. |
| 5–7 — picker/modal/sidebar blanking | Local Darwin candidate GREEN: 21 reports, 840 frames, blank 0, violations 0, with direct contact-sheet inspection. |
| 8 — color parity | Local Darwin candidate GREEN. Exact base and bright RGB regions are present for all seven providers. |
| 9 — macOS traffic-light close | Current accumulated Core gate GREEN for three actual AppKit close-button mouse down/up sequences. |
| 10 — test interference | Local GREEN. Capture-only windows are transparent/non-key, readiness is event-driven with polling count zero, every run has unique ownership, cleanup reaches zero open/recorded sidecars, and the user app remains untouched. |

Build and release command ownership is now Make-based for the active spec, contracts, shared kits,
seven renderer plugins, PTY, six deterministic frame sidecars, Core, Registry, terminal-tests and
the two Wails framework services. Tool versions remain in ecosystem owner files; Actions inject
them and call the same Make targets. Source-level arm64 gates are GREEN where recorded, but the full
Darwin arm64/x86_64/universal, Linux arm64/x86_64 and Windows x86_64 native matrices have not run.

The Shitty build dependency is the maintained fork branch
`min-median-max/shitty:soksak-provider-13`, which names upstream version 13. Commit `a5f8785f`
derives the embedded version from the source commit epoch, uses deterministic static archives and
removes node-work paths from debug data. The Sidecar `build-dependencies.json` owns that exact
commit and Python/LLVM/Ragel versions. Two independent arm64 SDK builds in different timezones were
byte-identical; canonical tree receipt `86f83d4c` and the Sidecar build, repeated stage and eight
conformance cases are GREEN. Other native targets and the new owner-only benchmark contract closure
remain unverified.

Release blockers outside implementation are also explicit: `soksak-terminal-tests` still lives
under the product-specific `min-median-max` module/reusable-workflow identity and needs a real
repository ownership decision before changing refs; `soksak-contract-registry` has no LICENSE and
requires an owner-selected license. Do not invent either value locally.

The remaining acceptance blocker is not a timeout or implementation fallback: WebKit requires an
active key window for native keyboard delivery. Local capture-only runs must not violate the user's
foreground session. The native matrix therefore belongs to the unattended final Darwin runner and
must not be replaced by DOM-event evidence or by focusing the developer's desktop.

The runner also needs unpublished candidate bytes without publishing them first. Existing component
release workflows do not expose owner-built nonpublishing artifacts, so the next release-infrastructure
increment is that explicit boundary. The product workflow may compose those artifacts by declared
identity and digest; it may not build sibling component source.

## Baseline

The Core baseline is release v0.0.3 at commit 1d140596d9a0c54f14ecb998ae0cce2c4a156f7e.
The release URL is https://github.com/soksak-ai/soksak/releases/tag/v0.0.3. Multi-platform run
32673034161 and release run 32673381309 passed.

| Component | Version |
| --- | --- |
| Alacritty terminal | 0.0.15 |
| Ghostty terminal | 0.0.16 |
| Kitty terminal | 0.0.15 |
| Shitty terminal | 0.0.15 |
| VT100 terminal | 0.0.15 |
| WezTerm terminal | 0.0.15 |
| Xterm terminal | 0.0.22 |
| PTY sidecar | 0.0.7 |
| Terminal plugin kit | 0.0.18 |
| Terminal behavior contract | 0.0.5 |
| Terminal contract package | 0.0.6 |

These successful runs are regression baselines only. They are not evidence that any reported UX
defect is fixed.

## User-session protection

The implementation must not close, reuse or modify a user-owned Soksak process, window, socket,
home or workspace. PID 41136 was user-owned at handoff and was deliberately left running; process
identity must be rediscovered rather than inferred from that number.

Test instances require a distinct home, short runtime path, unique identifier and explicit socket.
Darwin Unix socket length limits exclude long temporary runtime paths. Every test-owned sidecar and
application process must terminate on success and failure. Cleanup must never select a process by
executable name alone.

## Completion boundary

Completion requires all provider-matrix RED tests to become GREEN, all numeric visibility and
ownership checks to pass, and direct inspection of screenshots and motion recordings. A build,
command reply or previous CI run alone cannot close this handoff.
