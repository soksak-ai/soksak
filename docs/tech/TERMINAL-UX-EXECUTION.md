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

## Failure classification before RED

Run scripts/ci/require-frontend-toolchain.sh before a baseline or product test. It derives the exact
Node and pnpm versions from frontend/package.json, requires the Node runtime architecture to match
the host, materializes the frozen lockfile in non-interactive CI mode, and verifies the selected
native frontend package. task verify runs this preflight before any product test.

The preflight result determines whether product evidence exists:

| Result | Classification | Action |
| --- | --- | --- |
| TOOLCHAIN_MISMATCH, exit 78 | Environment precondition failure | Select the declared toolchain and rerun the preflight. Do not change product code and do not record RED. |
| DEPENDENCY_STATE_INVALID, exit 79 | Dependency materialization failure | Repair the repository-owned dependency state with the exact lockfile. Do not delete caches manually, force a package install or record RED. |
| Test cannot reach or execute its acceptance action | Test-harness failure | Fix the fixture, observation interface or test ownership first. The product result is unknown. |
| An unrelated accumulated gate fails before the target assertion | Existing regression | Stop the new work and restore the accumulated gate with its own RED and commit history. Do not relabel it as the target RED. |
| The declared environment is ready, the baseline path executes, and the target acceptance assertion fails | Product RED | Record the measured failure and begin implementation. |

Every evidence record includes source commit, host OS and architecture, Node version and
architecture, pnpm version, dependency lock digest, test command, exit code and first failing named
assertion. A second run with a different environment is not the same baseline.

The first valid baseline can pass or fail. If it passes, add a focused scenario that reproduces the
reported defect without weakening the acceptance rule. If it cannot reproduce the report, record
the missing condition as an investigation result; do not edit implementation on an assumed RED.

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

## Release gate and publication order

The five phases are implementation and evidence boundaries, not release boundaries. Do not publish
after an individual phase. Start one release train only after every phase is GREEN and the complete
candidate passes all accumulated gates, direct screenshot and recording inspection, the macOS
runtime gate, Linux checks, and the Windows cgo-free preflight.

Before the release train:

1. Build the final candidate bytes from the exact source revisions and source manifests.
2. Validate archives, manifests, versions, dependency references, digests, sizes and target matrices
   with the canonical validators.
3. Install the candidate closure into an isolated environment without sibling-repository discovery.
4. Run the provider matrix and installed-product tests against that exact closure.
5. Merge only the verified commits to each repository's main branch and repeat the deterministic
   source, manifest and candidate-byte gates from clean main checkouts.

GitHub Actions is the final native-platform certification and publication mechanism. It is not the
development loop. A native job may find a fact that macOS cannot execute, but all source-level,
cross-build, release-byte and composition failures must be eliminated before triggering it. Do not
rerun an unchanged failure. Add a focused RED, fix it, repeat the local gates, then start a new run.
Publish jobs must depend on all build and test jobs, so a failed certification creates no tag or
release asset.

Publish only repositories whose source or declared dependency changed. Use this dependency order:

1. Public specs and contracts, when their schemas or packages changed.
2. Shared kits, when their distributed implementation changed.
3. Sidecars, when their process or frame implementation changed.
4. Terminal plugins, after every referenced kit and sidecar release exists and the plugin manifests
   contain those exact immutable releases.
5. Core, after the released component closure and the Core release candidate pass the complete
   installed-product and visual gates together.
6. Registry, after the released Core and component bytes pass a final clean installation and smoke
   test through a validated unpublished registry candidate.

The registry is the last public commit and release because publication makes an update discoverable
to users. It must never expose a partial train. A development source remains update-blocked during
the work and is removed only in the isolated clean-install verification. The archived Tauri source
is not released.

After Registry publication, install from the public registry in a new empty identity home and run
the final smoke gate. This confirms publication integrity; it is not permission to repair the same
release in place. An immutable release that fails remains unregistered where possible. Establish a
RED and publish a new patch version. Never overwrite assets, move a tag, add a compatibility path or
lower an acceptance threshold.

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
