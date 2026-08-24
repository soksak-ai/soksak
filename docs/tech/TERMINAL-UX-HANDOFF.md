---
kind: reference
status: active
canonical: self
scope: workspace
---

# Terminal UX defect handoff

This document records unresolved defects and the verified starting point on 2026-08-24. It is not
a completion report. TERMINAL-UX-EXECUTION.md defines the required execution order and evidence.

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
and owner. SOKSAK_PRESENTATION=capture-only keeps test windows off the desktop. The current Wails
runtime admits one test application owner at a time through a blocking file lock.

## Facts and hypotheses

Verified facts:

- Xterm and the six frame providers use different presentation and input implementations.
- The frame presenter replaces the presented frame DOM and uses a hidden textarea.
- The previous visibility expression hid active DOM content during overlays and layout motion.
- The Core visibility tests and Xterm/VT100 development captures pass, but no seven-provider
  installed-product visibility matrix exists yet.
- Existing system tests primarily exercise command-based send, read, status and restore paths.
- Existing tests do not prove pointer focus, real keyboard entry, cursor pixels, overlay and sidebar
  motion, native traffic-light input, or an undisturbed user desktop.
- The installed-product matrix reaches the Kitty sidecar artifact and remains at `staging 1/2`.
  A SIGQUIT stack captured the blocked test-owned process in `HTTPFetcher.Fetch`, inside the Go
  HTTP/2 response-body read. Registry locking, archive extraction and the renderer bridge were not
  on the blocked goroutine.

Current unpublished candidates:

- The unpublished terminal contract package 0.0.7 defines terminal behavior interface 0.0.6, one
  256-color palette and one presentation status for byte and frame renderers.
- The kit candidate preserves row/run DOM nodes, exposes input/focus/cursor/render sequences and
  timestamps, and passed its typecheck and 33 source tests against the packed contract candidate.
- Xterm uses `@xterm/xterm` 6.0.0 and `@xterm/addon-fit` 0.11.0. Its WebKit IME dependency is one
  exact package.json/lockfile Git archive; the release workflow no longer checks out a conflicting
  older source commit.
- A clean candidate closure now exists for the contract, kit and all seven renderer plugins. The
  source manifests and lockfiles retain their public HTTPS dependencies and contain no local
  locator. Candidate provenance records the exact source commit and dependency archive digests.
- The seven-provider blank-frame verdict remains unproven. Do not classify defects 5–7 as complete.

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
| kit-plugin-terminal 0.0.18 | e8754fc | 0587a1fb44d19da0e8dacffa1f51471fd67c76adccb6eb1c240d0dc5e6418950 |
| plugin-terminal-alacritty 0.0.15 | 16c71ce | 2b02a19dc298ad8170f6787468b531640f238536df306da7c05b92411ae1cc43 |
| plugin-terminal-ghostty 0.0.16 | 8bd4805 | a388ac2f267ea41c98a58d4a54e19f7c16851b839f59942f1314a5c6dce908ba |
| plugin-terminal-kitty 0.0.15 | ecb6479 | 43e18e5c157e52018b641e689eb172d80aafb30cca3cd62289685551ac633b99 |
| plugin-terminal-shitty 0.0.15 | 8a30c15 | a2678e89a44bb1cfe9b26c227d932f846384909b6c053768c0c5ec1afdcead8c |
| plugin-terminal-vt100 0.0.15 | bc56b75 | 301ae9fee054101a44a00db0941faff8b8cd50da24bfbfe95a04ef9e1159434e |
| plugin-terminal-wezterm 0.0.15 | ba744e8 | 55e41f83907f6476baa5a20810b886cccfca25435adbb4bb0cf50b833c73dcc6 |
| plugin-terminal-xterm 0.0.22 | 91a724e | 6ae01661d5a1d82ef0ab0b1a114a81713d3d6594fa872cbfc22acea2b805dfcf |

This table validates renderer package composition only. It does not replace sidecar candidates,
installed-product parity, screenshots or motion evidence.

The allowed local build-time verification path is defined in
TERMINAL-UX-EXECUTION.md under “Local cross-repository candidate verification.” Direct consumer
manifest or lockfile editing is not a development mode.

`soksak-spec` commits `9de8149` through `25c58b7` own the complete candidate transaction: clean exact
source staging, dependency SHA-256 verification, staging-only workspace override, repository-owned
Make verification, canonical package and lock byte restoration, declared generated-output
projection, local-locator rejection and verified archive exit with `candidate-build.json`. Current
spec source `db47a94` also runs package installation from the package directory and Make from the
staged repository root. Staging metadata and `.candidate-inputs` do not enter the archive.

## Current progress and blockers

| Defect | State on 2026-08-24 |
| --- | --- |
| 1 — latency | Not complete. Owner-report schema is corrected, but the existing six reports use the retired demand fields and are invalid. Installed seven-provider timing thresholds have not run. |
| 2 — focus | Not complete. Public focus/input facts exist in candidates; no seven-provider real-pointer matrix exists. |
| 3 — active cursor | Not complete. Cursor state is exposed; no seven-provider pixel assertion exists. |
| 4 — keyboard input | Not complete. Input sequence facts exist; no real-keyboard-to-PTY matrix exists. |
| 5–7 — picker/modal/sidebar blanking | Shared visibility state and parked-picture rules have focused GREEN tests. The new clean closure has not run the installed seven-provider frame/motion matrix. |
| 8 — color parity | The contract palette is consumed by candidates; semantic and pixel parity across all providers is unproven. |
| 9 — macOS traffic-light close | Focused Core application gate is GREEN for an actual native close request. It remains part of the final accumulated gate. |
| 10 — test interference | Core capture-only identity and application ownership are implemented. External system workflows still use a fixed Darwin runtime path, and test-owned process/window leak count has not reached zero. |

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

Hypotheses that require RED evidence:

- Frame DOM replacement may contribute to the reported latency; the candidate removes replacement,
  but the performance threshold has not run on the installed provider matrix.
- Hidden-textarea focus transfer causes the focus, cursor and keyboard failures.
- Separate default and named-color mappings may cause the renderer color difference; the candidate uses
  the contract palette, but installed Xterm/provider parity has not run.

Do not record a hypothesis as a cause before the corresponding RED measurement identifies it.

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
