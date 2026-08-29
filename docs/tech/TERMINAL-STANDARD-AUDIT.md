---
kind: canonical
status: active
canonical: self
---

# Terminal standards audit

This report resets every previous terminal-standard completion claim. A feature is GREEN only when
one run proves the selected engine source/API, owner conformance test, installed command/status/event
surface, numeric state transition, and captured pixels. Source presence or a unit test alone is not
completion.

The terminal contract defines required control-sequence behavior and optional image-protocol
capabilities. Each provider proves its declared subset in its own repository; Core does not inspect
or test provider implementation.

## Theme row — 2026-08-29

The runtime assertion emits OSC 4/10/11/12 from the shell, reads engine `surface.state`, reads plugin
presentation status, and inspects the captured surface. OSC 104/110/111/112 must clear overrides.
A host dark/light change must update the base, preserve non-null overrides, and reveal the current
base after reset.

| Provider | Baseline | OSC set/status | Reset | Pixel | Verdict |
| --- | --- | --- | --- | --- | --- |
| Alacritty | live, frame/output advancing | exact `#123456/#234567/#345678`, ANSI 1 `#456789` | GREEN | GREEN | GREEN for this row |
| Ghostty | live at 42×30 across immediate input and an away/back tab switch | exact values | GREEN | GREEN | GREEN for this row |
| Kitty | live at 42×30 across output and an away/back tab switch | exact `#123456/#234567/#345678`, ANSI 1 `#456789` | GREEN; all overrides null and current base restored | GREEN | GREEN for this row |
| Shitty | live at 42×30; output 270+, frames consumed 7+, paint 6+ | exact `#123456/#234567/#345678`, ANSI 1 `#456789` | GREEN; all overrides null and current base restored | GREEN | GREEN for this row |
| VT100 | live at 42×30 across immediate input and an away/back tab switch | exact values | GREEN | GREEN | GREEN for this row |
| WezTerm | live at 42×30 across immediate input and an away/back tab switch | exact values | GREEN | GREEN | GREEN for this row |
| Xterm.js 6.0.0 fork | live at 59×29 and 39×29 after an away/back tab switch | exact `#123456/#234567/#345678`, ANSI 1 `#456789` | GREEN; current light base restored | GREEN | GREEN for this row |

Alacritty additionally passed dark→light with overrides retained, then reset to the light base. Two
defects were required to make status truthful: the frame-event limiter now emits one trailing event,
and effective themes are compared structurally rather than by JSON property order.

Shitty's earlier `cell size failed: -1` was not an unsupported engine feature. The native surface
grid started painting before the terminal resize observation reached the mirror. Kit 0.0.24 now
waits on that existing resize event until both grids match; it neither polls nor reads out-of-range
cells. All six native Sidecar owners pass the same new Kit gate. The installed Shitty 0.0.28 closure
then rendered shell output, exposed the cursor, applied and reset OSC colors, and reported no surface
error.

Kitty then exposed a second shared lifecycle defect: compositor remove/create notifications ran on
independent goroutines without declaration generation ownership, so a late old remove could close
the newly opened surface while the DOM still declared it. `wails-service-terminal-surface` now
serializes lifecycle operations per pane and passes declaration generation to Start, Remove and drop. A
stale removal performs no Sidecar call. With that service pinned by Core, Kitty retained its live
42×30 surface and shell output across an away/back tab switch, then passed the same OSC set/reset
state and pixel checks.

Ghostty exposed a readiness measurement defect rather than an engine defect: `waitForText` read the
surface before the first successful native state event. Vision 0.0.14 gates reads on that event.
VT100 then exposed the same missing gate on input: an immediate write reached the opening session's
zero value before the service published session 25. Vision 0.0.15 queues input until the same event
and sends it exactly once; disposal before readiness refuses the queued input. With those two event
gates, Ghostty, VT100 and WezTerm retained their 42×30 grids and cursor across tab switches and
passed marker-ordered OSC set/reset plus direct pixel inspection. A reset marker is emitted after the
escape sequence; matching the shell's echoed command text is not accepted as an execution barrier.

Xterm.js 6.0.0 had no public effective-color surface: `options.theme` is the host base and its
OSC-updated `ThemeService.colors` was private. Reading `_core` would couple the Plugin to an internal
object graph, so the `min-median-max/xterm.js` fork exposes a read-only `effectiveTheme` snapshot.
The engine still parses, applies and resets every OSC color. The fork also preserves active OSC
overrides when the host base theme changes; reset reveals that new base. Its owner gate passes 2,324
unit tests, API lint and a real Chrome set/reset test. The fork is built as `@soksak/xterm@6.0.0`,
published through the Registry, and consumed as the `@xterm/xterm` npm alias; consumer Git prepare,
codeload locators and private API access are absent. Xterm Plugin 0.0.54 then passed the same runtime
state, dark→light, reset, tab-switch and pixel checks as the native providers.

## Pointer reporting row — 2026-08-29

| Provider | Engine API | Owner bytes | Installed PTY | Pixel | Verdict |
| --- | --- | --- | --- | --- | --- |
| Alacritty 0.0.37 | `alacritty_terminal` modes plus provider encoder | SGR press/drag/release/free-motion; legacy modifiers and release | exact down/drag/up hex, sequence 3 | GREEN | GREEN for this row |
| Ghostty 0.0.34 | forked libghostty-vt `GhosttyMouseEncoder` and `GhosttyMouseEvent` | SGR press/drag/release/free-motion | exact down/drag/up hex, sequence 3 | GREEN | GREEN for this row |
| Kitty 0.0.31 | forked Kitty `Screen` mouse encoder through provider ABI | SGR press/drag/release/free-motion | exact down/drag/up hex, sequence 3 | GREEN | GREEN for this row |
| Shitty 0.0.30 | forked Shitty `encodeMouseProtocol` through provider ABI | SGR press/drag/release/free-motion | exact down/drag/up hex, sequence 3 | GREEN | GREEN for this row |
| VT100 0.0.33 | forked vt100-rust live `Screen::encode_mouse_event` | SGR press/drag/release/free-motion; legacy and UTF-8 | exact down/drag/up hex, sequence 3 | GREEN | GREEN for this row |
| WezTerm 0.0.33 | existing `TerminalState::mouse_event` and synchronous raw writer tap | SGR press/drag/release/free-motion; legacy and UTF-8 | exact down/drag/up hex, sequence 3 | GREEN | GREEN for this row |

Ghostty does not copy a terminal mouse encoder. Its owner keeps one engine encoder and reusable
event, refreshes mode and format from the live `GhosttyTerminal`, and submits action, button,
modifiers and position through the fork's C API. The immutable v7 release digests are Ghostty
`ed39380c51cdd09ae499d56b728b8c09aa1b24f975eb7f4db8ae8a11ed961225`, Vision
`f38eed4cfcf2c55b33e724490fe928a80b0791c850f8bf634d7f00b597dc3ed3`, and Xterm
`d863e11c3c253d53f780be9c11d1d9655b14a03e006f7392e2453ebe7120a601`. Batch plan
`f81c5f078add204e2093fd60a73aedda9a754bc36d0df49888e3d50e1bbf0b66` installed nine components
at environment revision 55. In the installed Ghostty pane, 1002+1006 down/drag/up produced
`1b5b3c303b323b324d1b5b3c33323b363b324d1b5b3c303b363b326d`, route `mouse-report`, sequence 3,
and final write count 9. A 536,524-byte composed snapshot visibly contained the echoed sequences,
result hex, prompt and cursor; capture kept `windowFocused=false` before and after.

This row does not certify Ghostty selection or wheel. Those engine APIs remain explicit owner
refusals and stay in the open selection/scroll matrix.

Kitty follows the same ownership rule. Fork commit
`9df1e0b7c5b93e933e877c36ee45ae62935c9b48` exposes the existing live `Screen` mouse encoder through
`kitty_provider_pointer`; the Sidecar supplies normalized facts and contains no protocol encoder.
The immutable v7 release digests are Kitty
`3954fe6fcfd63dc7afa1bea2305c46d19b2a119d61cfec4276c195724791614b`, Vision
`ace05568fafeecb34725ab40cc57c2d32e9b42e1bd810776c107f2dae0c0e828`, and Xterm
`d259f19c31b4051fd04cddcee1dcde47aa3fce8eb886998a8d119124922470ce`. Batch plan
`d6d0d0932045151281e926a2da85852dc83546e7a42a4606a526e2a0457feed4` installed nine components at
environment revision 57. The installed Kitty pane produced the same exact down/drag/up hex, route,
sequence, and final write count as the preceding rows. A 289,925-byte composed snapshot showed the
result, prompt, and cursor while `windowFocused=false` remained unchanged. Kitty selection and wheel
remain open.

Shitty follows the same engine-owner contract. Fork commit
`dbc42af98907fadd5b057d2922b890b2725c016c` exposes the existing live
`encodeMouseProtocol` path through `soksak_shitty_terminal_pointer`; the Sidecar maps normalized
facts into that ABI and contains no terminal protocol encoder. The immutable v7 release digests are
Shitty `01c6621658afe703d2e17e14f77117753b850ff49142e615eba326615d2ee925`, Vision
`55dc94b7a14763405d4c974d011fe427a64cf54761d8d7c26e00a3cdc3f5f3bd`, and Xterm
`c5626b60fb0af8933de2d50fbbc893921786810f1c93a16e49b9bc091e8b30af`. Batch plan
`d8d9b1f8fe46864028b68af1b4079c799ccd6b51319576f116b8eda717b08fc2` installed nine components at
environment revision 59. In pane `tab-espq62.1`, one public `ui.input.drag` transaction produced
pointer sequence 3 and shell hex
`1b5b3c303b323b324d1b5b3c33323b363b324d1b5b3c303b363b326d`, exactly matching the preceding
provider rows. The 138,685-byte composed snapshot visibly contained the result, prompt and block
cursor; `windowFocused=false` remained unchanged before and after capture. Shitty selection and
wheel remain open.

The first installed attempt exposed an exact-selection defect. The generic sidecar resolver read
the selected process path from `environment.json` but discarded its version, so the 0.0.30 binary
started as `version:null`. A later exact 0.0.30 selection replaced that process and left the held
surface without a renderer. Core commits `fc20078` and `058e453` publish process-generation events
and reopen held declarations; commits `9028c0b` and `b52da36` remove the path-only resolver and make
name resolution return `{name, version, path}` as one selection. The complete Core gate passed 321
files and 2,333 tests. In the rebuilt v7 from Core `9a2a61c`, the Shitty process record started and
remained at version 0.0.30 and PID 39484. Pane `tab-nljljd.1` repeated the exact pointer hex and
sequence 3. Its 156,257-byte composed snapshot retained the result, prompt and block cursor while
`windowFocused=false` remained unchanged. The unnecessary process replacement is removed; the
generation-reopen fallback is owner-tested and is not a runtime certification of arbitrary
multi-pane process replacement.

VT100 keeps the protocol implementation in its engine fork. Fork commit
`c5cc944741d422f94ef898d7efe79edff609feb2` adds `Screen::encode_mouse_event`, which reads the
parser's live mode and encoding; the Sidecar maps normalized facts and contains no mouse encoder.
The immutable v7 release digests are VT100
`318f1024cb0fd481d7bf96203657e0fc6a2f42802fb9b24aedd334db26d0ad89`, Vision
`e3bc1b2101ba3e3d6e7c51d873a7100523e2e799b5154fc38e8097c38962b7b4`, and Xterm
`0ef0422a179d423c240c346fc815c3d16f3d0ee923d6cbcd98d591a728393d1e`. Batch plan
`f175d07742fd7aa31e48bed2bcb4b85a1c43c1b7457637e3f866445c87eda833` installed nine components at
environment revision 62. Exact VT100 0.0.33 process PID 63849 served pane `tab-3yhreg.1`; one public
drag produced pointer sequence 3 and shell hex
`1b5b3c303b323b324d1b5b3c33323b363b324d1b5b3c303b363b326d`. The 140,613-byte composed snapshot
showed the result, prompt and block cursor while `windowFocused=false` remained unchanged. VT100
selection and wheel remain open. The first live-install start did not create a process and blocked
shutdown; a clean application boot started exact 0.0.33. Hot-install startup remains OPEN and this
pointer row does not certify it.

WezTerm required no fork change. Its existing `TerminalState::mouse_event` owns live mode, button
state and SGR, UTF-8 and legacy encoding. The Sidecar sends normalized `MouseEvent` values and reads
only the raw writer bytes produced by that synchronous call. The immutable v7 release digests are
WezTerm `aa67ee9711b82d2507dc30572e7300d91db667dcdb5cfc50c9414c3ae869147f`, Vision
`b8cabda9238208c40eea572d990eeeea3de79321f124c393e25dda4d2c296cf2`, and Xterm
`2092a6fd0ac246377aec003d6ebcddfc1628fc6c6e2b180e6ec2d51ef710d7d4`. Batch plan
`ae464754b166f2acdc01dc42044419d53365cf2596667cd2794f0c012ed765ac` installed nine components at
environment revision 65. Exact WezTerm 0.0.33 process PID 83318 served pane `tab-r64m3b.1`; one
public drag produced pointer sequence 3 and shell hex
`1b5b3c303b323b324d1b5b3c33323b363b324d1b5b3c303b363b326d`. The 143,836-byte composed snapshot
showed the result, prompt and block cursor while `windowFocused=false` remained unchanged. WezTerm
selection and wheel remain open. All six native pointer rows are GREEN; this does not certify the
remaining terminal-standard rows.

## Remaining rows

Cursor, CSI/OSC/DCS/APC coverage, bracketed paste, mouse modes, drag selection, copy, wheel/trackpad
scroll, file/image drop, clipboard images, Kitty graphics, iTerm2 OSC 1337, Sixel, TUI host split,
latency, damage and gap gates remain UNVERIFIED until their own matrix runs.

## Selection, copy and scroll status — 2026-08-30

The selected renderer owns selection text and scrollback position. Core supplies one coherent
pointer transaction: primary-button detail on down, held buttons on move, and move/up events through
the source document. Kit publishes the renderer's exact selection and scroll state. Copy writes the
selection through the granted host clipboard and an independent clipboard read must return the same
text.

The installed xterm Plugin 0.0.69 closes selection, copy, and basic scroll for its row:

- a public drag over `SELECT_ME_1234567890` returned that exact 20-character selection and painted
  the selected range;
- `copy` returned the same text and an independent `clipboard.read` returned the same 20 characters;
- after 80 output rows, `scroll(lines=10)` and status both returned `{historySize:85, offset:10}`;
- the scrolled viewport read `64..71`, and `scroll(edge=bottom)` returned offset zero.

The complete matrix remains RED until status publishes follow/pinned state, wheel gestures select
exactly one local-scroll or PTY route, mouse-reporting conflicts are verified, and every installed
provider passes the same drag/copy/scroll assertions. A command name, source presence, or screenshot
alone is not a pass.
