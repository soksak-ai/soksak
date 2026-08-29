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
| soksak-core/ | Current Wails application, control CLI, renderer, framework adapters, application lifecycle and Core gates. This handoff is owned here. |
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
frame evidence identifies the producer or transport. Installed-product behavior is placed in the
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

## Current authoritative status — 2026-08-28

The current local closure is Contract `0.0.13`, browser Kit `0.0.71`, Sidecar Kit `0.0.16`, PTY
Sidecar `0.0.13`, six recovery Sidecars and seven terminal Plugins. The selected runtime versions
are:

| Provider | Recovery Sidecar | Plugin |
| --- | --- | --- |
| Alacritty | 0.0.23 | 0.0.29 |
| Ghostty | 0.0.23 | 0.0.30 |
| Kitty | 0.0.19 | 0.0.29 |
| Shitty | 0.0.18 | 0.0.29 |
| VT100 | 0.0.22 | 0.0.29 |
| WezTerm | 0.0.22 | 0.0.29 |
| Xterm | uses the selected recovery Sidecar | 0.0.45 |

The canonical local composer wrote the plan once and returned `unchanged` on the second run. Its
SHA-256 is `a6234d0a49c0377f72e60cd22ff2549c80fdae848d7e0611767ace50518242eb`.
The plan selects Core `f0b39ff9dc01d13a39dfa50e956e50eb58333110` and terminal-system test
`0788e45`. All selected Plugin and Sidecar owner releases returned `created` then `unchanged`, and
the local release store verified all 52 entries.

The installed seven-provider `system-restore` gate is GREEN on Darwin arm64. It proved both
application-only warm restart and replacement of the PTY daemon. Warm restart retained the exact
shell/session owner; PTY replacement preserved each archived marker in history and accepted fresh
typed shell input. Application logs contain no `already renders`, `INPUT_WRITE_FAILED`, or hung
request. Capture-only windows remained non-key and alpha-zero. Cleanup reported `open=[]`,
`recorded=[]`, graceful application exit, and no process under the test identity. The seven
archived-restart captures were inspected directly and each shows a live prompt and its
`SOKSAK_ARCHIVED_RESTART_n` marker.

Checkpoint generation is an identity, not an ordering number. A new observation explicitly claims
the pane. Only that generation may advance its checkpoint sequence; a late worker from another
generation is refused. A new PTY generation moves the prior viewport into scrollback, clears and
homes a new viewport, then applies fresh shell output. Numeric comparison of random generation IDs
is forbidden.

File drops follow the same ownership rule. Core issues opaque Plugin/window-bound one-shot grants
and returns the authorized raw path only on redemption. Terminal Kit owns login-shell quoting. Core
does not name shell families or produce `shellText`.

| Defect | Current evidence |
| --- | --- |
| hang / orphan render ownership | GREEN for the exact v3 closure: seven-provider warm restart, PTY replacement, input and cleanup. |
| 1 — latency | Open. Owner and restore throughput evidence exists, but the current closure has not rerun the complete installed performance matrix. |
| 2 — focus | Open. Capture-only DOM focus is not native AppKit focus; the unattended native gate remains required. |
| 3 — active cursor | Open. Engine state is exposed, but native pointer-to-active-cursor certification remains required. |
| 4 — keyboard input | Partial. Command/DOM input and post-restart shell input are GREEN; unattended AppKit key-to-PTY remains required. |
| 5–7 — picker, modal and sidebar visibility | Partial. The installed v7 browser↔Vision glide is gap-free in both directions; picker/modal/sidebar occlusion and border/dim remain open. |
| 8 — colour parity | Open. The v3 restore captures are readable and consistent by inspection, but the complete computed-style/ANSI matrix has not rerun on v3. |
| 9 — macOS traffic-light close | Core owner gate remains GREEN, including repeated native clicks. |
| 10 — test interference | GREEN for the current capture-only restore gate: non-key, no focus transfer, exact identity cleanup, zero owned Sidecars. |

The 2026-08-29 v7 compositor increment removed duplicate presentation ownership rather than adding
a provider exception. Browser 0.0.8 keeps a mounted webview intrinsically visible. Terminal Kit
0.0.77 separates Workbench intrinsic visibility from Core host presentation and Vision 0.0.16 writes
only the intrinsic axis to `data-native-visible`. Their owner gates passed; both Plugin releases
returned `created` and then `unchanged` through the immutable local release command. In v7 revision
39, `surface.inventory` showed the inactive Vision and active Browser declarations both
`declaredVisible=true`, with ghosts, unowned, unapplied and orphans empty. Two 20-frame
`tab.switchScan` runs (Browser→Vision and Vision→Browser) each reported eight completed journeys,
zero cancelled/incomplete journeys, and empty blank, overlap and native-mismatch frame lists. The
recorded frames were inspected directly without focusing the window; no white gap or stale native
surface was present. This closes the tab-switch compositor ownership defect, not the remaining
overlay, border or focus-input matrices.

The 2026-08-29 Alacritty selection slice is GREEN only for its named row. Surface Contract 0.0.5
defines the owner-bound selection transaction; Render Kit 0.0.26 and Alacritty Sidecar 0.0.35 own
the gesture state, engine selection and rendered range. Vision 0.0.19 routes both DOM pointer events
and the owner `SurfacePointerInput` sequence through that transaction. Its immutable v7 local
release digest is `bf62dff8926271ca813a48f04320d0db35a0236de69110dfc3e978de1551d64f`
and a second publication returned `unchanged`. Core resolves an exposed native declaration by the
exact `data-native-surface-id`; it no longer synthesizes a host-DOM drag over a native surface.
In the rebuilt v7 application, `ui.input.drag` returned
`surface=terminal.win-vug6zo.tab-ms2k2p-1`, selection command and exposed DOM both returned
`SELECT_FINAL_13579`, and the 24-frame recording visibly showed the same selected range without
focusing the window. The Wails host now serves `clipboard_read` and `clipboard_write` through its
injected framework clipboard; Vision copy returned `copied=true` and the independent read returned
the same 18 characters. Clipboard change subscription, mouse-reporting arbitration, scroll and the
other five native engines remain open and this row must not certify them.

The 2026-08-29 Alacritty wheel slice is also GREEN only for its named row. Surface Contract 0.0.6
preserves the surface point, pixel/line/page unit and four modifiers and requires one effect route.
Render Kit 0.0.27 owns fractional accumulation and mode routing; Alacritty Sidecar 0.0.36 owns
legacy, UTF-8, SGR and alternate-scroll byte encoding; the terminal-surface service validates that
answer and remains the single PTY writer. Vision 0.0.20 routes DOM and generic owner wheel input
through one serialized `surface.wheel` path and exposes route, written byte count and sequence.
The immutable v7 release digests are `d5a04200d2f5857bd3364cf9e5c0ffda6685e129f7ba2a69445abbc3d71106af`
for Alacritty, `0833136c4c24a8d6f62522449843fc3cea5920c1e87cc0fcbb2cb2e457f30411`
for Vision and `c7f7ddaf39f0df849bcf0a86c4a1b8c118cf6f8136c201779be5e940de448bad`
for the closure-aligned Xterm Plugin; every second publication returned `unchanged`, and batch plan
`cb54a4815700710b5a2557fc65580953a9dc63eada3687992ff28a5d2bd5f252` installed nine components.
In v7, line wheel `-3` over 53 history rows returned `scrollback`, `written=0`, `offset=3`; the
captured viewport moved from line 80 to line 78. With 1000+1006 active, wheel-up returned
`mouse-report`, `written=12`, and the shell received hex `1b5b3c36343b31363b31334d`
(`ESC[<64;16;13M`). With alternate screen+1007 active, the same wheel returned
`alternate-scroll`, `written=3`, and the shell received `1b4f41` (`ESC O A`). Ghostty, Kitty,
Shitty, VT100 and WezTerm remain open; no evidence in this paragraph certifies their wheel path.

The 2026-08-29 Alacritty pointer slice is GREEN only for its named row. Surface Contract
0.0.7 defines strict down/move/up, button, click count, point and modifier facts. Render Kit 0.0.28
owns mouse-mode arbitration and Alacritty Sidecar 0.0.37 owns SGR, legacy and UTF-8 encoding. The
terminal-surface service validates the one-effect answer and remains the only PTY writer. Vision
0.0.21 serializes pointer and wheel delivery through one input queue, routes grabbed input to
`surface.pointer`, and keeps Shift-drag in the engine selection transaction. Core commit
`8f5b3fc1d16756994c35f402b5d737b8df2ae25c` preserves middle/right buttons and all four modifiers
through the public DOM command surface. The immutable v7 release digests are
`ef283aa66c60838ede3126fd9e536fae1ceaffabecc82d48fec8dfdde02c8346` for Alacritty,
`0ab2f49472f0071f5a59f25da04d1316b9ba44c90edd8437b7179e7e30dbce0d` for Vision and
`1c7c9cfac285e0ce089b3879e296b1efcad4733f0244ec897d97d8f3dfb2ad4a` for Xterm. Every second
publication returned `unchanged`; batch plan
`29878a3bfcdb03a0575ed31ed8e96076070d74e283eb7d52841b686a7c19eef7` installed nine components at
environment revision 49. With 1002+1006 active, one down/drag/up produced pointer sequence 3 and
shell hex `1b5b3c303b323b324d1b5b3c33323b363b324d1b5b3c303b363b326d`, exactly
`ESC[<0;2;2M`, `ESC[<32;6;2M`, `ESC[<0;6;2m`. A Shift drag kept pointer sequence 3, advanced
selection sequence to 4, and returned `IFT_MODE_READY_2468`.

The first capture isolated a separate ownership defect rather than weakening the pixel gate. The
non-key capture-only window kept `windowFocused=false`, but `window.snapshot` returned only the main
document and therefore left native panes blank. The new public `surface.snapshot` read the same
terminal owner directly and returned a 112,642-byte PNG containing its glyphs, cursor and selected
range, proving that engine paint was not the missing layer. Core commit
`81e33ca35549233bbaf3b4658a33f78218a7515c` now composes every visible applied native surface over a
document-only capture in applied layer order, clipping by the requested region and preserving
alpha; a visible surface that returns no PNG fails by name. The rebuilt v7 window snapshot returned
588,815 bytes with `nativeComposed=true`, `surfaces=2`, `drawn=2`, `documentOnly=false`; direct pixel
inspection showed the dim left terminal, active right terminal, cursor and
`SHIFT_MODE_READY_24680` selection, while input state remained `windowFocused=false` before and
after capture.

The first consent run also exposed a Core lifecycle race: Vision's enabled write returned before
its environment-triggered reload drained, so the following Xterm enable raced that reload and
reported `already registered program: terminal-xterm` even though its renderer was active. Core
commit `df255a6c19f8820f980896758e5a58b8d37f6de2` makes every enabled-state write await the shared
revision coordinator. In the rebuilt v7, disabling both terminal Plugins and then enabling Vision
followed by Xterm returned four successful transactions; both installed Plugins reported enabled
with no error. The finite `window.record` path now uses the same native composition per frame. A
three-frame v7 run returned `frames=3`, wrote three 589,723-byte PNGs with the same SHA-256 because
the screen was static, visibly retained both terminals and the selection, and kept
`windowFocused=false` before and after.

Ghostty 0.0.34 passed the same named pointer row through the forked libghostty-vt mouse encoder,
not a copied protocol implementation. The v7 batch and exact PTY hex are recorded in
`TERMINAL-STANDARD-AUDIT.md`; its 536,524-byte composed capture kept the window non-key and visibly
showed the result and cursor. Ghostty selection and wheel remain open.

Kitty 0.0.31 then passed the same pointer row through its forked live `Screen` encoder exposed by
the provider ABI. Exact closure identity and PTY evidence are in `TERMINAL-STANDARD-AUDIT.md`; the
289,925-byte composed capture kept the window non-key and showed the result and cursor. Kitty
selection and wheel remain open.

Shitty 0.0.30 passed the pointer row through the fork's existing live `encodeMouseProtocol` path
exposed by its provider ABI. Its exact closure, PTY bytes, and non-key composed capture are recorded
in `TERMINAL-STANDARD-AUDIT.md`. Shitty selection and wheel remain open. The first-run render loss
was caused by Core discarding the selected sidecar version during name-based startup. Core now
resolves name, version and process together and publishes process-generation events for held-pane
recovery. The rebuilt v7 retained exact Shitty 0.0.30 from first start and repeated the pointer row.
VT100 0.0.33 then passed the same row through the fork's live `Screen` mouse encoder. Exact closure,
PTY and capture evidence are in `TERMINAL-STANDARD-AUDIT.md`. VT100 selection, wheel and the failed
first hot-install start remain open. WezTerm 0.0.33 then passed the pointer row through its existing
`TerminalState::mouse_event` API without a fork change. All six native pointer rows are GREEN;
selection, wheel and the remaining standard rows stay open.

No release train has started. Theme, native focus/cursor/keyboard, visibility, performance and the
remaining product goals must use this exact or a later fully recomposed closure.

## Superseded 2026-08-25 snapshot

The material below is retained only as historical context. It is not current closure identity or
completion evidence and does not authorize skipping a current gate.

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
  input, cursor state and timing without disturbing the foreground app. Automated colour verdicts
  read the public `terminal-screen` computed foreground/background, cursor/selection properties and
  all 256 ANSI properties. Screenshots and recordings remain human-inspected observations.
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

- The unpublished terminal contract package 0.0.7 defines terminal behavior interface 0.0.7, five
  semantic theme roles, one 256-color palette and one presentation status for byte and frame renderers.
- The kit 0.0.19 candidate preserves row/run DOM nodes, exposes input/focus/cursor/render sequences
  and timestamps, and solely owns host-theme resolution and the public computed-style surface for
  both frame renderers and Xterm.
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
closure included that contaminated kit archive. The following clean renderer closure passed defect
8 colour certification in run 32779972490. The later focus fix advances the kit to commit `075a31a`;
do not describe this colour closure as the current focus closure.

| Artifact | Source commit | SHA-256 |
| --- | --- | --- |
| contract-plugin-terminal 0.0.7 | 18c8261 | 3e9fd042b497cb7d44d736e597c56e0279412b134f098458d883277915733356 |
| kit-plugin-terminal 0.0.19 | 017f63c | ddac758f0234d780ccd5a6e13c72f425e81e193000e9f2970dddfcf026703a7b |
| plugin-terminal-alacritty 0.0.16 | e0f01ea | 7e22211b76a671f91596bd077529324a2923668178a7a90c2d6f47525c053c8c |
| plugin-terminal-ghostty 0.0.17 | 46182d6 | 331f5deb89f5a31a58bb8d15599d0bbe19bb245041b6663f7228bb3249cdfd5c |
| plugin-terminal-kitty 0.0.16 | 7a50962 | 781e9237632624912a9b1b548cfd18f93756568adb745baf177e09bc7f2e382f |
| plugin-terminal-shitty 0.0.16 | 48ad712 | a2c469cde29ec54837d87d7a6ea0f811d52c07f80f3d2ac215269ce688b13240 |
| plugin-terminal-vt100 0.0.16 | 40fb549 | b5956da65d10ba3d10bf5c70f2e1a01088c2981d7d729de9bb30f5d2105b4558 |
| plugin-terminal-wezterm 0.0.16 | 24797a1 | 670e0af3e178398817d1184775d2c1dc827e488e4ca077d42be09f156be06e43 |
| plugin-terminal-xterm 0.0.23 | 29d26a8 | 28a1bca790fc6835ec8a3e0c356f342d0ecedd5d935c0fe7ca0a43f06143ccf5 |

The candidate plan SHA-256 is
`630486414dd0a83cdd7d4cb54d78c1f6a2a6d7295293d35f13fdf27836a5c51b`. It also pins PTY and the six
frame-sidecar archives. This table and digest identify the closure; the installed-product reports,
public state/DOM assertions are automated verdict evidence, while screenshots and recordings are
directly inspected observations.

The allowed local build-time verification path is defined in
TERMINAL-UX-EXECUTION.md under “Local cross-repository candidate verification.” Direct consumer
manifest or lockfile editing is not a development mode.

`soksak-spec` commits `9de8149` through `25c58b7` own the complete candidate transaction: clean exact
source staging, dependency SHA-256 verification, staging-only workspace override, repository-owned
Make verification, canonical package and lock byte restoration, declared generated-output
projection, local-locator rejection and verified archive exit with `candidate-build.json`. Current
spec source `0a1e217` also supports long ustar paths while preserving those boundaries. Staging
metadata and `.candidate-inputs` do not enter the archive.

## Superseded 2026-08-25 progress table

| Defect | State on 2026-08-25 |
| --- | --- |
| 1 — latency | Candidate parity is GREEN at 5–11ms render and 6–29ms input-to-PTY for all seven providers. Installed command throughput remains RED for Alacritty against 3MB/s, so the defect remains open. |
| 2 — focus | Native RED was `focusSequence=1` followed by `focusedInput=false` on Alacritty. Common kit fix `075a31a` cancels WebKit's default mouse action and is GREEN in its owner candidate; final native recertification remains open. |
| 3 — active cursor | Candidate public active/visible cursor state and inspected pixels are GREEN. Native post-pointer active-cursor acceptance follows defect 2. |
| 4 — keyboard input | Capture-only terminal-to-PTY round trip GREEN for seven providers. Final AppKit key-to-PTY acceptance follows defects 2 and 3. |
| 5–7 — picker/modal/sidebar blanking | Local Darwin candidate GREEN: 21 reports, 840 frames, blank 0, violations 0, with direct contact-sheet inspection. |
| 8 — color parity | Exact candidate run 32779972490 GREEN. All seven providers expose the same five theme roles, computed foreground/background and 256 ANSI values; all seven captures were inspected. Public releases and the user's current app are older, so the deployed product remains RED. |
| 9 — macOS traffic-light close | Current accumulated Core gate GREEN for three actual AppKit close-button mouse down/up sequences. |
| 10 — test interference | Local GREEN. Capture-only windows are transparent/non-key, readiness is event-driven with polling count zero, every run has unique ownership, cleanup arrives at zero open/recorded sidecars, and the user app remains untouched. |

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

Release blockers outside implementation are also explicit: `soksak-terminal-tests` still is defined
under the product-specific `min-median-max` module/reusable-workflow identity and needs a real
repository ownership decision before changing refs; `soksak-contract-registry` has no LICENSE and
requires an owner-selected license. Do not invent either value locally.

The remaining acceptance blocker is not a timeout or implementation fallback: WebKit requires an
active key window for native keyboard delivery. Local capture-only runs must not violate the user's
foreground session. The native matrix therefore is owned by the unattended final Darwin runner and
must not be replaced by DOM-event evidence or by focusing the developer's desktop.

The unpublished-candidate boundary is implemented. Each component owner workflow builds, verifies
and seals its own clean exact commit; the product workflow composes only 17 artifacts named by
declared identity and digest. The product workflow does not read or build sibling component source.

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

## Additional v7 observation defects

### Prompt absence classification

`INPUT_WRITE_FAILED: pane ... is not running` is not itself a rendering diagnosis. Read the
environment's PTY/engine versions, readiness records, and pane session state first. A live PTY can
outlive an engine whose render thread panicked; shell output then stops while input targets a closed
pane. Record the first engine assertion together with `terminal.status` session/generation, and
reproduce against the clean v7 closure. Never terminate or reinstall the user's app to investigate.

In the isolated `soksakv7` application, track these as named assertions rather than hiding them under
focus or input:

- After clicking a terminal pane, the next key may be lost until another tab is selected and returned.
  Record native/DOM click, focus state event, and PTY write as one sequence.
- On pane switch or restore, the previous prompt/branch text can appear as a ghost over the new pane.
  Assert frame sequence and surface generation ownership mechanically, then inspect final pixels.

Do not reproduce or modify the user `soksakv3` instance. Each assertion needs its own RED before a fix.

## Project-qualified sidecar identity

The installer passes the materialized process name, derived from `environment.json` `processRole` and
the project name, as `SOKSAK_SIDECAR_NAME`. PTY socket and token paths derive from that declared name;
Core also passes the complete selected component-id to materialized-process-name map as
`SOKSAK_SIDECAR_BINDINGS`. The PTY derives its own endpoint from its identity; terminal engines use
the `soksak-sidecar-pty` binding to find their peer. Neither role is inferred from the current
executable. Thus `soksak-sidecar-pty` and `soksakv7-sidecar-pty` cannot share endpoints under one
runtime root.

The terminal-surface service owns dependency-ordered startup because its source declares both the
PTY and engine unit. It requests `Start(exact PTY)`, then `Start(exact engine)`, before any session
command. Core resolves each request from `environment.json`; its link exposes distinct `Start` and
`Send` operations and never guesses a provider or hides startup inside `Send`. A fresh project home
and every later restart therefore follow the same `resolve -> PTY ready -> engine ready -> session`
transaction. Manually launching a sidecar or depending on a process left by an earlier run is
invalid evidence.

Completion requires all provider-matrix RED tests to become GREEN, all numeric visibility and
ownership checks to pass, and direct inspection of screenshots and motion recordings. A build,
command reply or previous CI run alone cannot close this handoff.
