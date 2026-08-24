---
kind: guide
status: active
canonical: self
---

# Terminal UX execution directive

This directive applies the repository accumulation gate to TERMINAL-UX-HANDOFF.md. Execute by
contract group, not by reported item number.

## Non-negotiable rules

- Establish a mechanical RED before implementation and confirm the intended failure.
- Apply one matrix test to Xterm, Alacritty, Ghostty, Kitty, Shitty, VT100 and WezTerm.
- Expose missing command, status, event and DOM facts before using private DOM, paths, timing or
  load order.
- Use events, subscriptions, watchers or callbacks. Do not add polling.
- Do not increase timeouts, add retry loops, skip tests or hide terminals during an overlay.
- Do not unmount and remount views during modal or sidebar motion.
- Do not copy focus, input, color or performance behavior into individual providers.
- Do not add backward-compatibility paths, fallbacks or temporary implementations.
- Do not terminate or reuse user-owned applications or sidecars.
- Do not report UI completion without inspecting current screenshots and recordings.

If a requirement is technically wrong, stop before changing its RED criterion. Record the conflict,
propose the corrected rule, and update the rule, RED and document together after approval.

## Phase 1 — observation surface

Add durable public facts only where the current interfaces cannot judge a defect.

| Concern | Required fact |
| --- | --- |
| Renderer | byte or frame, mount sequence, ready sequence, render sequence |
| Startup | open time, first visible frame time, first focusable input time |
| Input | focused input node, cursor visible and active, accepted input sequence, PTY write sequence |
| Output | received output sequence, rendered output sequence |
| Visibility | desired visibility, applied visibility, reason, overlay count |
| Layout | sidebar and layout transaction phase, committed geometry sequence |
| Window | native close-request receipt, cleanup completion sequence |
| Test ownership | presentation mode, owner identity, owned process and window inventory |

Provide each relevant fact through command, status and exposed DOM. Emit transitions as events.
Names and schemas describe domain state and contain no provider implementation name. Do not create a
fact with no acceptance check in later phases.

RED: every matrix row fails with a named missing or incorrect fact. Empty values, silent absence and
inferred values are failures.

## Phase 2 — renderer parity

Use one provider-matrix scenario:

1. Open one terminal tab for the provider.
2. Wait for an explicit ready event, not an interval loop.
3. Perform a real pointer click on the exposed terminal-screen or terminal-input node.
4. Confirm the browser active element and public focus status identify the input owner.
5. Dispatch actual keyboard input through the UI path.
6. Confirm the input sequence becomes one PTY write and one shell marker output.
7. Confirm a visible active cursor in the captured frame.
8. Measure open to visible frame, open to focusable input, click to input owner, key to PTY write,
   and PTY output to rendered frame.
9. Apply one ANSI fixture covering default foreground and background, 16 named colors, bright
   colors, inverse, bold and reset.

plugin.send proves the command path only. It is not keyboard-input evidence. A successful focus()
call is not pointer-focus evidence. Xterm is a comparison baseline, not the theme source of truth;
canonical theme tokens define expected semantics.

Record existing Xterm and frame-provider timing distributions before selecting numeric product
thresholds. Commit thresholds to the RED test before changing implementation. Every provider must
meet the same semantic contract. A renderer-specific numeric tolerance requires measured evidence.

Inspect screenshots for cursor and color results. Convert each visual property to a pixel or token
assertion. A screenshot supplements that assertion and never replaces it.

## Phase 3 — view visibility transaction

Use one window containing multiple terminal providers. Record every transition frame for:

- tab plus picker open and close;
- settings modal open and close;
- consent modal open and close;
- left and right sidebar open, close and resize;
- tab switch during sidebar motion.

For every frame, assert:

- each retained terminal rectangle has nonzero width and height;
- no retained terminal enters display none, hidden visibility, zero opacity or an empty frame;
- modal content blocks pointer input while underlying content remains visible and inactive;
- sidebar motion produces one committed composition without a blank intermediate frame;
- closing an overlay preserves renderer mount identity, session identity and previous pixels;
- DOM and native-surface renderers use the same declared visibility result.

One visibility transaction owns overlay occlusion and layout motion. Remove every older path that
computes conflicting visibility. Do not retain a compatibility branch.

## Phase 4 — native macOS close

Create RED evidence from an actual macOS traffic-light click. Do not substitute window.close.

GREEN requires one native request to close one target window, application of the documented
last-window policy, complete workspace claim and native-surface cleanup, one cleanup contract for
native and command input paths, no change to another window, and externally observable request and
cleanup sequences. Inspect before and after screenshots and window inventories.

## Phase 5 — test process and window ownership

Keep a user-owned Soksak window active while running the full gate in an isolated environment. RED
must demonstrate current interference without changing or terminating the user instance.

Assert before, during and after the gate:

- the user input owner does not change;
- no visible test window is added to the user's desktop;
- user PID, socket, home and workspace state remain unchanged;
- every test-owned application and sidecar terminates, including failure paths;
- cleanup selects only identities issued by the test owner.

First determine whether the platform can render and capture the required view while hidden. If it
cannot, record the verified limitation and implement a separate test session or runner. Do not
delete, skip or weaken visual tests.

## Execution environment

Use the soksak-dev skill and inspect the resulting pixels. Current Core binaries are
soksak-core/bin/sok and soksak-core/bin/soksak; do not use the obsolete CLI path in older generated
skill text.

An isolated run requires a distinct SOKSAK_HOME, a short runtime directory under <local-evidence> on Darwin, a
unique identifier, an explicit --socket <local-evidence>/<run>.sock for every CLI call, an explicit window field
for window-scoped requests, and targetWindow only for window_renderer_wait. Cleanup stops only
test-owned sidecars and then calls app.shutdown.commit.

Discover command schemas from the running binary. Do not infer them from old examples. Discover
repository roots with Git; do not join repositories through guessed sibling paths.

| Tool | Pinned version and path |
| --- | --- |
| Node | 26.7.0 — <workspace-root>/local/runtime/node-v26.7.0-darwin-arm64/bin |
| pnpm | 11.22.0 — <machine-path>/Library/pnpm/.tools/pnpm/11.22.0/bin |
| Task | 3.53.1 — <workspace-root>/local/runtime/task-v3.53.1 |
| Wails | 3.0.0-beta.12 — <workspace-root>/local/runtime/wails3-v3.0.0-beta.12/wails3 |

## Evidence and commits

For each phase:

1. Add and run the RED test.
2. Commit verified RED as test:.
3. Implement the smallest complete contract and run the same test GREEN.
4. Run all accumulated gates.
5. Capture screenshots; use window.record for motion; inspect every relevant frame.
6. Update canonical and Korean documents.
7. Commit implementation as fix: or feat:, then documentation as docs:.

Store generated visual evidence outside repositories at ~/soksak/wails3beta/evidence/<gate>. Do not
commit generated images or recordings.

## Final acceptance

The final gate reports these values mechanically for all seven providers and listed transitions:

- open to first visible frame;
- open to first focusable input;
- pointer click to active input owner;
- key event to PTY write;
- PTY output to rendered frame;
- overlay open and close blank-frame count equals zero;
- sidebar motion blank-frame count equals zero;
- active cursor visible in every required frame;
- canonical theme semantic and pixel checks pass;
- user input owner unchanged across the test run;
- test-owned process and window leak count equals zero.

Run the Core exit gate, every affected plugin and kit gate, macOS visual and native-input checks,
Linux checks, and the Windows cgo-free cross-build. A phase is incomplete if a later phase breaks
its accumulated gate.
