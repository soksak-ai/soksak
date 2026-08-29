---
kind: guide
status: active
canonical: self
scope: workspace
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

Run `make prepare REGISTRY=http://host:port/` and then `make preflight` before a baseline or product
test; `make verify REGISTRY=http://host:port/` owns the full Core gate. The commands delegate to scripts/ci/prepare-frontend-dependencies.sh and
scripts/ci/check-build-toolchain.sh. Prepare alone materializes
the frozen lockfile under the cross-process dependency-owner lock. Check is read-only: it derives
the Node selector from `.node-version`, verifies its `frontend/package.json` projection and pnpm
declaration, and verifies the selected native frontend package. It separately reports the required,
Node, Go and Wails architecture axes and prints the lock SHA-256. `go tool wails3 task verify` runs
prepare and check in that order before any product test. `BUILD-TOOLCHAIN.md` owns the general
toolchain rule.

The preflight result determines whether product evidence exists:

| Result | Classification | Action |
| --- | --- | --- |
| TOOLCHAIN_MISMATCH, exit 78 | Environment precondition failure | Select the declared toolchain and rerun the preflight. Do not change product code and do not record RED. |
| DEPENDENCY_STATE_INVALID, exit 79 | Dependency materialization failure | Repair the repository-owned dependency state with the exact lockfile. Do not delete caches manually, force a package install or record RED. |
| Test cannot reach or execute its acceptance action | Test-harness failure | Fix the fixture, observation interface or test ownership first. The product result is unknown. |
| An unrelated accumulated gate fails before the target assertion | Existing regression | Stop the new work and restore the accumulated gate with its own RED and commit history. Do not relabel it as the target RED. |
| The declared environment is ready, the baseline path executes, and the target acceptance assertion fails | Product RED | Record the measured failure and begin implementation. |

Every evidence record includes source commit, required platform, Node/Go/Wails versions and runtime
architectures, pnpm version, dependency lock digest, test command, exit code and first failing named
assertion. A second run with a different environment is not the same baseline.

The first valid baseline can pass or fail. If it passes, add a focused scenario that reproduces the
reported defect without weakening the acceptance rule. If it cannot reproduce the report, record
the missing condition as an investigation result; do not edit implementation on an assumed RED.

Every active source repository exposes its existing operations through Make. Make owns commands,
not versions or dependency identities. Node, pnpm, Go, Rust and Python versions stay in their
ecosystem owner files; external SDK repositories, commits, tools and target outputs stay in
`build-dependencies.json`. A workflow selects the native runner, injects those owners and calls the
same Make target. It does not contain a second implementation of the build. No source file records
an installed executable path or searches the workstation for an alternate tool.

## Local cross-repository candidate verification

An unpublished dependency is never connected by editing its consumer repository. The following
locators are forbidden in a canonical source manifest, lockfile, component manifest, workflow,
candidate or release archive, and registry metadata:

- `file:` and `file://`;
- `link:` and `workspace:`;
- a parent-relative path that leaves the repository;
- an absolute local path, including `<local-evidence>`, a user directory or a drive path;
- a symlink or injected workspace root that resolves another checkout.

`file:../../../../../...` is not safer than `file:<local-evidence>/...`. A package manager merely serialized the
same external local dependency relative to the lockfile. Both are repository-topology coupling and
fail the same gate.

The canonical source checkout remains unchanged during candidate composition. In particular, a
candidate materializer must not edit or regenerate the source `package.json` or lockfile to select
an unpublished dependency. It must record and compare the source worktree before and after the run;
any difference invalidates the run.

One candidate closure is declared under `local/candidates/<closure-id>/`:

~~~text
candidate-plan.json
contracts/<artifact>
kits/<artifact>
plugins/<artifact>
sidecars/<artifact>
~~~

Paths in the plan are confined to that closure and identify regular files. Each entry records kind,
id, version, source repository, source commit, artifact size and SHA-256, dependency commits and,
where applicable, platform target. Contracts and specs are validation inputs; they are not inserted
into the runtime plugin/sidecar component list.

Build-time composition uses one canonical materializer and a disposable staging checkout. The
materializer verifies the plan and digests, snapshots a clean source commit, supplies candidate
artifacts through its content-addressed staging transport, builds, and finalizes the staging state.
Staging metadata is not source, is not committed, and is never copied into a candidate archive.
Neither a developer nor an ad-hoc script edits dependency metadata to imitate this operation. If
the canonical materializer cannot express a dependency edge, that is a missing product tool: add a
RED and implement the materializer before continuing.

`soksak-spec` commits `9de8149` through `25c58b7` provide the canonical stage and archive-exit
commands:

~~~sh
node <spec-package>/release-template/stage-node-candidate.mjs \
  --source <clean-absolute-repository-root> \
  --out <empty-absolute-staging-directory> \
  --plan <absolute-candidate-stage-plan.json>

node <spec-package>/release-template/build-node-candidate.mjs \
  --stage <absolute-staging-directory> \
  --out <empty-absolute-candidate-output-directory> \
  --kind <portable-or-plugin> \
  [--generated <declared-output-path> ...]
~~~

The plan contains only `packagePath` and `dependencies`; each dependency records package
name, absolute artifact path and SHA-256. The command archives one clean exact source commit,
verifies and copies dependency artifacts under the disposable checkout, and writes staging-local
`pnpm.overrides`. It refuses a dirty source, digest mismatch, path escape, symlink and nonempty output.
It does not edit the canonical source. Both output directories must already exist and be empty.

The exit command installs only inside staging, invokes the repository's
`make verify REGISTRY=http://host:port/` from the staged repository root, restores canonical package and lock bytes, rejects every undeclared source
change, retains only declared generated outputs, removes `.candidate-inputs` and staging control
metadata, rejects local locators, builds and validates the candidate archive, and writes
`candidate-build.json`. A staging-local locator is not source metadata but is invalid if it survives
finalization. The caller disposes the finalized staging checkout after evidence extraction.
Publishing every development iteration is not a replacement; the release train starts only after
the complete candidate and installed-product matrix are GREEN.

The canonical `soksak-spec` release builder rejects local dependency locators in source metadata,
lockfiles and produced archives. The system-test candidate plan verifies candidate identity,
digests and validation inputs independently. A downstream candidate is valid only when both gates
pass.

Any local dependency found in canonical metadata invalidates:

1. the modified lockfile or manifest;
2. every archive created from it;
3. every downstream candidate built from that archive;
4. every test result, screenshot and recording produced from that closure.

Remove the contamination, rebuild the entire closure from the recorded source commits, and rerun
the same gates. Reverting the visible manifest alone does not restore evidence already produced.
Development candidate evidence is provisional. Final evidence is regenerated after the dependency
release train uses exact immutable release URLs and digests.

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

An exposed native surface is one input realm regardless of whether it presents a browser or a
terminal. The exact owner label is `data-native-surface-id` in its DOM declaration.
`ui.input.click`, `ui.input.drag` and related commands must route the surface-relative sequence to
that label's registered input owner and report the label in their result. Dispatching host DOM mouse
events over that placeholder, reporting success without an owner call, or reconstructing the label
from a provider name is RED. Selection GREEN requires the engine selection status, the public DOM
selection status and the selection command to agree; copy additionally requires a write followed by
an independent public clipboard read of the exact text.

Wheel rows preserve `point`, `deltaX`, `deltaY`, `deltaMode` and all four modifiers through the
owner route. GREEN requires three independent cases: primary-screen history changes offset without
a PTY write; active mouse reporting writes the engine-encoded bytes exactly once; alternate screen
with alternate-scroll writes the matching cursor-key bytes exactly once. The public DOM route,
written count and sequence must agree with the shell-received hex. A Plugin or Core escape encoder,
loss of fractional pixel delta, or reporting two effect routes is RED.

## Phase 2 — renderer parity

Use the same provider rows in two explicitly different matrices. The local capture-only matrix
must preserve the user's foreground application. It uses exposed DOM addresses and records that
`ui.input.click` and `ui.input.key` are browser-event routes, not operating-system evidence. The
native-input matrix runs only on an unattended native runner with an isolated interactive test
application.

The active defect order is `color (8) → native focus (2) → active cursor immediately after the
pointer (3) → native keyboard-to-PTY (4) → throughput (1)`. A candidate-workflow test fixes this
order so a later RED cannot prevent an earlier certification.

For each provider in the native-input matrix:

1. Open one terminal tab for the provider.
2. Wait for an explicit ready event, not an interval loop.
3. Resolve the exposed terminal-screen rectangle and send an AppKit mouse down/up pair through
   `window.input.pointer.click`.
4. Confirm the browser active element and public focus status identify the input owner.
5. Send AppKit key down/up pairs through `window.input.key.press`.
6. Confirm the input sequence becomes one PTY write and one shell marker output.
7. Confirm a visible active cursor in the captured frame.
8. Measure open to visible frame, open to focusable input, click to input owner, key to PTY write,
   and PTY output to rendered frame.
9. Apply one ANSI fixture covering default foreground and background, 16 named colors, bright
   colors, inverse, bold and reset.

`plugin.send` proves the command path only. `ui.input.key` proves the exposed browser-event route
only. Neither is native keyboard evidence. A successful `focus()` call is not native pointer-focus
evidence. Xterm is a comparison baseline, not the theme source of truth; canonical theme tokens
define expected semantics.

Record existing Xterm and frame-provider timing distributions before selecting numeric product
thresholds. Commit thresholds to the RED test before changing implementation. Every provider must
meet the same semantic contract. A renderer-specific numeric tolerance requires measured evidence.

Inspect screenshots for cursor and color results. Automated pass/fail comes from public status and
DOM computed-style assertions. Default foreground/background, cursor/selection and all 256 ANSI
values are read from the public `terminal-screen` surface. A screenshot is a human observation and
never replaces the automated assertion.

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
- `contentVisible` keeps the active DOM slot mounted and visible;
- `surfaceVisible` is false while an overlay occludes an out-of-document live surface; layout motion
  keeps the live surface in the compositor transaction;
- when `contentVisible` is true and `surfaceVisible` is false, a parked picture preserves the last
  applied pixels until the live surface returns; inactive chains retain no picture.

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

On Darwin, capture-only windows remain compositor-resident with alpha zero, ignore mouse input and
stay non-key. `window.snapshot` captures their document without changing the foreground process.
WebKit rejects native keyboard input while its application is inactive and its window is non-key;
do not work around that limit by focusing the developer desktop or by relabelling DOM events as
native. `system-native-input` uses an isolated interactive application only on an unattended native
runner. Do not delete, skip or weaken either matrix.

## Execution environment

### v7 isolated candidate boundary

The v7 observation run is a local release transaction isolated from the public Registry and the
user's `soksakv3`. Its candidate store is an explicit persistent boundary outside source checkouts:

`<local-release-store>/soksakv7`

The store contains only the complete contract-to-kit-to-sidecar-to-plugin release closure. The
runtime/home is `<isolated-home>`, the identifier is `com.soksakv7.core`, and materialized
processes use the `soksakv7` prefix. Source checkouts, the user's `soksakv3` home/runtime/environment,
and the public Registry are neither inputs nor outputs. `<local-evidence>` is permitted only for short Darwin
Unix-socket runtime paths; release artifacts, configuration, and evidence never live there.

Use the soksak-dev skill and inspect the resulting pixels. Current Core binaries are
soksak-core/bin/sok and soksak-core/bin/soksak; do not use the obsolete CLI path in older generated
skill text.

An isolated run requires a distinct SOKSAK_HOME, a short runtime directory under <local-evidence> on Darwin, a
unique identifier and owner, an explicit --socket for every CLI call, an explicit window field for
window-scoped requests, and targetWindow only for window_renderer_wait. Local and visual matrices
use `SOKSAK_PRESENTATION=capture-only`. Only the unattended `system-native-input` certification uses
`interactive`. Native GUI application gates, not user or project applications, hold a test-only
lock under the Core repository for their whole lifetime. It serializes those gates because the
current Wails runtime cannot host two test GUI processes safely. `soksak.host.ready` means the
process control plane is registered. `soksak.window.ready` includes the label of a framework window
that reached `WindowRuntimeReady`. A caller that needs renderer commands then calls the existing
event-driven `window_renderer_wait` barrier for that exact label. A caller waits for the narrowest
event or barrier its next operation requires; none of these paths polls. Cleanup inventories and stops exact test-owned open and
recorded sidecars, calls app.shutdown.commit, and proves graceful application exit.

Discover command schemas from the running binary. Do not infer them from old examples. Discover
repository roots with Git; do not join repositories through guessed sibling paths.

The repository never records a workstation tool path. The selected environment must satisfy the
owner file read by the addressed repository:

| Tool | Canonical owner |
| --- | --- |
| Node | `.node-version` and the matching package `engines.node` projection |
| pnpm | the addressed `package.json#packageManager` |
| Go and Wails | `go.mod`; invoke Wails with `go tool wails3` |
| Rust | `rust-toolchain.toml` |
| Python | `.python-version` when the repository directly owns Python operations; external SDK Python is placed in `build-dependencies.json` |
| Native target | explicit `TARGET=<target-triple>` Make command and the Actions runner matrix |

An Apple Silicon source-level gate requires the actual Node, Go, Rust and Python processes it uses
to be arm64. A Rosetta process is an exit-78 environment failure even when it can cross-compile an
arm64 file. Final native evidence additionally verifies the headers of every Core, sidecar, SDK and
test process artifact.

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

Native certification before publication uses owner-built, nonpublishing candidate artifacts:

1. Each changed component repository builds its own candidate through its repository Make target
   and canonical spec packager. It uploads an Actions artifact identified by source commit, target
   and SHA-256, but creates no tag or release.
2. The product configuration workflow declares those artifact identities and downloads only their
   bytes. It must not check out, inspect or build a component repository's source.
3. The product workflow constructs the candidate plan from those verified artifacts and runs the
   unattended native matrices.
4. Candidate-only metadata and artifact locators never enter source manifests, release archives or
   Registry state. A failed candidate run is discarded, not published.

Publishing a dependency first in order to make native certification possible reverses this order
and is prohibited. At 2026-08-25 the existing component workflows publish immediately after their
build path and do not yet expose this nonpublishing artifact boundary; that boundary must be added
and tested before the release train.

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
to users. It must never expose a partial train. A Local release remains update-blocked during
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
- same-pane tab activation reports `changed=true`, `layoutMoved=false`, a DOM-committed
  presentation receipt and no invented layout transaction;
- tab switching reports zero blank, overlap and native-receipt-mismatch frames;
- active cursor visible in every required frame;
- canonical theme semantic and pixel checks pass;
- user input owner unchanged across the test run;
- test-owned process and window leak count equals zero.

Run the Core exit gate, every affected plugin and kit gate, macOS visual and native-input checks,
Linux checks, and the Windows cgo-free cross-build. A phase is incomplete if a later phase breaks
its accumulated gate.
