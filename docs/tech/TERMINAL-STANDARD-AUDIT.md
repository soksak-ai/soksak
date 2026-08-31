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
| Xterm renderer 6.0.0 | live at 59×29 and 39×29 after an away/back tab switch | exact `#123456/#234567/#345678`, ANSI 1 `#456789` | GREEN; current light base restored | GREEN | GREEN for this row |

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
object graph, so the Xterm renderer exposes a read-only `effectiveTheme` snapshot.
The engine still parses, applies and resets every OSC color. The renderer also preserves active OSC
overrides when the host base theme changes; reset reveals that new base. Its owner gate passes 2,324
unit tests, API lint and a real Chrome set/reset test. The renderer is built as `@soksak/xterm@6.0.0`,
published through the Registry, and consumed as the `@xterm/xterm` npm alias; consumer Git prepare,
codeload locators and private API access are absent. Xterm Plugin 0.0.54 then passed the same runtime
state, dark→light, reset, tab-switch and pixel checks as the native providers.

## Pointer reporting row — 2026-08-29

| Provider | Engine API | Owner bytes | Installed PTY | Pixel | Verdict |
| --- | --- | --- | --- | --- | --- |
| Alacritty 0.0.37 | `alacritty_terminal` modes plus provider encoder | SGR press/drag/release/free-motion; legacy modifiers and release | exact down/drag/up hex, sequence 3 | GREEN | GREEN for this row |
| Ghostty 0.0.34 | provider `GhosttyMouseEncoder` and `GhosttyMouseEvent` | SGR press/drag/release/free-motion | exact down/drag/up hex, sequence 3 | GREEN | GREEN for this row |
| Kitty 0.0.31 | provider `Screen` mouse encoder through provider ABI | SGR press/drag/release/free-motion | exact down/drag/up hex, sequence 3 | GREEN | GREEN for this row |
| Shitty 0.0.30 | provider `encodeMouseProtocol` through provider ABI | SGR press/drag/release/free-motion | exact down/drag/up hex, sequence 3 | GREEN | GREEN for this row |
| VT100 0.0.33 | provider `Screen::encode_mouse_event` | SGR press/drag/release/free-motion; legacy and UTF-8 | exact down/drag/up hex, sequence 3 | GREEN | GREEN for this row |
| WezTerm 0.0.33 | existing `TerminalState::mouse_event` and synchronous raw writer tap | SGR press/drag/release/free-motion; legacy and UTF-8 | exact down/drag/up hex, sequence 3 | GREEN | GREEN for this row |

Ghostty does not copy a terminal mouse encoder. Its owner keeps one engine encoder and reusable
event, refreshes mode and format from the live `GhosttyTerminal`, and submits action, button,
modifiers and position through the provider C API. The immutable v7 release digests are Ghostty
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

Kitty follows the same ownership rule. Provider revision
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

Shitty follows the same engine-owner contract. Provider revision
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

VT100 keeps the protocol implementation in its provider. Provider revision
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

WezTerm required no provider change. Its existing `TerminalState::mouse_event` owns live mode, button
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

## Native selection and scroll matrix — 2026-08-30

Vision 0.0.35 consumes Contract 0.0.19, Plugin Kit 0.0.94 and six Sidecars built from Sidecar Kit
0.0.30. Every release was attested by its owner and the local store returned `published` followed by
`unchanged`. A renderer reload initially exposed a stale compositor sequence; compositor commit
`5fe697e` adopts the backend sequence floor from the refusal and replays the full current inventory.
The installed hot reload advanced composition sequence 18→38 with seven surfaces, `worst=0`, and no
unapplied or undeclared surface.

The first native drag exposed a missing `focused` value. Vision 0.0.33 now focuses the input and
awaits the exact `surface.focus {focused:true}` transaction before pointer delivery. Alacritty then
selected `SELECT_ALACRITTY_1234567890`; `selection`, `copy`, and an independent clipboard read all
returned the same 27 characters, and the capture visibly showed the engine-owned range.

Native scroll exposed two shared defects. Vision returned before the asynchronous surface reply,
and Sidecar Kit interpreted positive lines toward the bottom. Plugin Kit 0.0.94 awaits remote
renderer scroll; Vision 0.0.34 returns the applied reply; Sidecar Kit 0.0.30 defines positive lines
as history and negative lines as bottom. Fresh installed rows produced:

| Provider | Selection | `scroll(lines=10)` | Status/read/pixel | Verdict |
| --- | --- | --- | --- | --- |
| Alacritty 0.0.39 | RED in the final closure: two fresh panes advanced PTY output but canonical frames contained no runs | RED/unknown | blank surface with cursor/selection overlay only | provider RED |
| Ghostty 0.0.37 | exact `SELECT_GHOSTTY_24680`; copy and independent clipboard read matched 20 characters | `10/52/pinned` | `GROW042..071`, selection and scroll pixels inspected | selection/copy/scroll GREEN |
| Kitty 0.0.34 | exact `SELECT_KITTY_24680`; copy and independent clipboard read matched 18 characters | `10/54/pinned` | `KROW042..071`, selection and scroll pixels inspected | selection/copy/scroll GREEN |
| Shitty 0.0.33 | exact `SELECT_SHITTY_24680`; copy and independent clipboard read matched 19 characters | `10/54/pinned` | `SROW042..071`, selection and scroll pixels inspected | selection/copy/scroll GREEN |
| VT100 0.0.36 | exact `SELECT_VT100_1234567890`; copy and independent clipboard read matched 23 characters | `10/54/pinned` | selection pixels inspected; scroll state matched command/status | selection/copy GREEN; scroll state GREEN, viewport regression OPEN |
| WezTerm 0.0.36 | exact `SELECT_WEZTERM_24680`; copy and independent clipboard read matched 20 characters | `10/136/pinned` | `WZROW042..071`, selection and scroll pixels inspected | selection/copy/scroll GREEN |

The initial five GREEN scroll rows returned the same offset and `followMode` through command and
status; their captured viewports showed rows 42 through 71. VT100 selection became GREEN after a provider
commit `d557ec1` exposed signed logical-row text without moving the viewport and Sidecar 0.0.36
owned the selection endpoints and ranges. Its later 80-row run returned `10/54/pinned` but painted
an empty viewport, so that scroll pixel row remains OPEN. The six native selection rows are GREEN;
the Alacritty frame regression must be fixed before its current closure can be judged.

Ghostty Sidecar 0.0.37 uses libghostty-vt selection gestures, terminal-owned tracked selection,
selection formatting and native containment. Kitty Sidecar 0.0.34 uses the selected Kitty provider's
`Screen` selection modes, text and row-range methods through its provider SDK. Shitty Sidecar
0.0.33 uses the selected Vterm and Screen selection surface for logical rows, including history.
Each owner RED first failed at its explicit unimplemented refusal. The same owner gates now cover
simple, semantic, line and extend behavior; none of the three substitutes a generic Kit range.

Vision 0.0.49 selects those exact releases. Installed public DOM drags, selection commands, copy
commands and independent clipboard reads returned the marker lengths in the table. The focus-free
captures showed each engine-owned selection. Each exact process then produced 80 numbered rows;
the scroll command and public status agreed on `offset=10/pinned`, Plugin read returned rows 42
through 71, and the three composed native captures showed the same rows. The immutable local release
digests are `58cebbd9ed083e5aa53ed3697dcc332c0bc0a7c7ebfef9fed6689d3acd0a64bd`
for Ghostty, `255447965971867b0f62d382ccefa3d40031b2c6de4ba410eb95eb7f2cf43c85`
for Kitty, `884679ae72e877e674b95df9371b1dde6504fb41236ae1fb0ffe638f6b0f58d6`
for Shitty and `2a7be50dfab36ae3db06bbfe7acb2bb9b503f6c7280194e8ce23a54dde1acdd0`
for Vision 0.0.49.

WezTerm Sidecar 0.0.36 owns simple, line, block and extend selection over the rows materialized by
its selected engine. Its owner RED first failed because the provider returned no selection; the
same named test now returns the exact text and row range without a generic Kit fallback. Vision
0.0.46 selects that immutable Sidecar. In the installed capture-only environment, a public DOM drag
selected `SELECT_WEZTERM_24680`; the selection command, copy command and independent clipboard read
returned the same 20 characters. The native selection pixels were inspected while the window
remained non-key. The same process then produced 80 numbered rows; `scroll(lines=10)` returned
`10/136/pinned`, Plugin read returned rows 42 through 71, and the composed native capture showed
those rows. The Sidecar PID remained unchanged across drag, copy, capture and scroll.

## Initial-output evidence — 2026-08-30

PTY Sidecar 0.0.20 exposes bounded `pty.tail` evidence from the existing output ring. The response
names the retained floor and through sequence, returned byte count, and base64 bytes; it neither
reads a private runtime file nor creates a second output owner. Sidecar Kit 0.0.31 makes the consumer
boundary equally observable through `terminal.status`: cumulative observed output bytes and the last
observation's source range, byte count, and SHA-256 are reported with the existing event and output
sequences.

The original Alacritty RED is now bounded precisely. The PTY ring retained 401 bytes containing the
shell prompt, while the same pane's first full `terminal.frame` reported output sequence 401 and 30
empty rows. Feeding the observed control-sequence shape directly to the Alacritty owner preserved
the prompt, including across a shrink-and-expand resize. A later command rendered normally in the
same pane. The defect is therefore an intermittent initial lifecycle or delivery failure, not proof
that the engine cannot parse the prompt and not a compositor paint failure.

A clean Vision 0.0.38 closure selected PTY 0.0.20 and Alacritty 0.0.40. Three fresh panes each
reported 401 observed bytes, zero gaps, matching final observation ranges, and a full frame containing
the prompt. Each pane accepted a distinct marker after tab activation. Three measured tab switches
were one clean frame with zero flicker, blank, overlap, or native-receipt mismatch. After application
restart, all three exact sessions reattached with their markers and prompts intact. Both composed
captures remained non-key and were inspected.

Alacritty initial output remains OPEN: 0.0.40 adds evidence and owner guards but no behavioral change,
so one clean run cannot erase the earlier RED. Completion requires a named lifecycle test that
deterministically reproduces the empty initial full frame and turns GREEN under the same scheduling
boundary.

VT100 0.0.37 consumes the same observable Sidecar Kit and adds an owner guard for an 80-row burst at
a shifted viewport. In a clean installed Vision 0.0.39 run, the terminal consumed 1,368 source bytes
with zero gaps, `scroll(lines=10)` returned `10/52/pinned`, the full provider frame contained rows
42 through 71, the Plugin read contained rows 43 through 71, and the non-key composed capture showed
those rows. This is a GREEN clean-run scroll row; the earlier blank lifecycle observation remains
relevant until the scheduling boundary is deterministic.

The same run exposed a truthful-label defect: commands executed by a VT100 pane were reported as
`alacritty terminal read/scroll`. Plugin Kit 0.0.95 derives static command descriptions from the
terminal Plugin label rather than its default engine. Vision 0.0.40 then returned `Vision Terminal
read/scroll` while public status continued to report `engineId=vt100`. Immediately after that hot
Plugin replacement, the first `scroll(offset=10)` returned offset zero; a following
`scroll(lines=10)` returned and published `10/52/pinned`. Hot-reload scroll readiness is therefore
OPEN and is not covered by the clean-run row.

## Native remount ownership — 2026-08-30

The hot-reload scroll RED had four independent causes, each fixed at its owner:

- Plugin Kit clamped an absolute offset against a renderer's not-yet-published history size. Kit
  0.0.96 sends the non-negative absolute request to the renderer, which owns the authoritative clamp.
- A mounted Plugin view did not expose its container generation. Core now publishes that generation
  in the public view context and Kit 0.0.97 passes that exact value to the renderer.
- A surface pane was reported live immediately at mount. Kit 0.0.98 waits for the surface presenter's
  generation-owned `ready` promise; no timer or polling loop participates.
- Vision disposed an old presenter by sending `surface.stop` through the shared surface id. That was
  a second lifetime writer: after a remount it could stop the new generation. Vision 0.0.45 sends no
  stop from presenter disposal; the compositor declaration removal is the sole teardown owner.

The terminal-surface service now separates declaration generation from its internal lifecycle
generation. State and Plugin events carry declaration generation; stale remove protection uses
lifecycle generation. `terminal_surface_status` reports both, retains blocked generations and their
exact errors, and also reports a failed replacement beside a still-live owner. A successful Start
emits one generation-bearing lifecycle state event, so a remounted presenter does not wait for an
unrelated future output frame.

In the installed VT100 run, application restore reached declaration generation 2/lifecycle 1. A
same-version disable→enable then reached declaration generation 14/lifecycle 5, remained live, and
the first `scroll(offset=10)` returned `10/52/pinned`. Plugin read returned rows 43 through 71. The
composed capture visibly showed rows 42 through 71 and kept `windowFocused=false` before and after.
This closes the hot-remount scroll readiness row.

## Selection retirement on input — 2026-08-30

An installed Vision 0.0.50 reproduction selected and copied both an ASCII marker and a seven-syllable
wide-cell marker, pasted each value, and then sent Backspace through the
exposed terminal input node. Alacritty's engine frame removed exactly the final ASCII character and
the final wide Hangul cell, but `selection` still returned the copied text after paste and
Backspace. The stale engine-owned selection overlay was therefore the reproducible corruption
boundary; Backspace parsing and the underlying grid were not corrupt.

Vision 0.0.51 serializes an active `surface.selection {action:"clear"}` before the first confirmed
`surface.input`. Its named presenter RED observed only `surface.input`; the same test is GREEN with
the exact `selection clear -> input` transaction. The complete owner gate passes 32 tests. The
immutable local release was accepted as `published` and then `unchanged` with digest
`da557123859ee681f4de27c4d59098a10c3e3f8c75c113a0df585ac34638fec8`.

The installed capture-only environment selected Vision 0.0.51 through an eight-component local
closure. After the same Hangul copy and paste, `selection` returned an empty string before
Backspace. Backspace then removed exactly the final Hangul cell, the selected output row had no
selection overlay, and the composed before/after captures were inspected while
`windowFocused=false`.

## Prepared-observer retained prefix — 2026-08-30

PTY 0.0.21 makes adoption of a prepared observer atomic with the running session pump: the opened
frame names the retained floor, the retained prefix follows, and only then may live output follow.
The deterministic owner RED lost the retained prompt; GREEN receives its exact bytes before the
next live bytes. In an installed app restart, the preserved PTY reported 401 retained bytes and the
new Alacritty session reported the same 401 observed bytes, range `0..401`, SHA-256 and a full frame
containing the prompt. This closes retained-prefix delivery itself.

The composed restart capture also exposed a separate size-ordering defect: the shell emitted its
first prompt at the default 80 columns before the surface's measured 126-column resize, leaving the
prompt at column 80 after adoption. Surface Contract 0.0.9 now defines side-effect-free
`surface.measure`; Sidecar Kit 0.0.32 implements it from the same renderer font metrics used by
`surface.open`; terminal-surface service `b2d591b` orders a fresh pane as
`measure -> observer preparation -> PTY open -> engine subscription -> surface open`. The measured
grid is passed unchanged to every process-facing step, and a contradictory `surface.open` grid is
refused.

Vision 0.0.52 selects Alacritty Sidecar 0.0.41, whose immutable release digest is
`15be80bb6b199856446cbf2ea94bccd8acf4c991c5dba9b3c0825b6185adaba4`; the Vision release digest is
`2ebf654acc771ccc1ae12049339a50fdb08b8f7f259fa3121f28004daa7c89f6`. In a fresh isolated
installed product, three panes independently reported PTY, engine and surface grids of `126x30`,
352 observed bytes, zero gaps, and a first non-empty row exactly at row 0 with cursor `[0,14]`.
No row contained the former 80-column padding. The composed capture showed the prompt at the left
edge and kept `windowFocused=false` before and after. This closes initial-size ordering for the
Alacritty row; other providers must consume the same Kit before their rows inherit this result.
