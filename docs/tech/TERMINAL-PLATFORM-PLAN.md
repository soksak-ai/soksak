---
kind: canonical
status: active
canonical: self
---

# Terminal platform

## Product result

Soksak restores a terminal by rebuilding its complete screen state and then attaching the same
shell process after the snapshot's source sequence. Output produced while the application is not
running is delivered once. A terminated process is represented as an input-disabled archived
screen. Retained raw output alone is a degraded result, not complete restoration.

The product keeps the xterm plugin and may add plugins backed by Alacritty, Ghostty, Kitty,
Shitty, vt100-rust and WezTerm after each implementation passes the state, recovery, presentation
and distribution gates.

## Public components

| Component | Version | Responsibility |
| --- | --- | --- |
| `soksak-spec-sidecar-pty` | `0.0.1` | Shell ownership, ordered source events, renderer and observer streams, absolute acknowledgements and snapshot leases |
| `soksak-spec-sidecar-terminal` | `0.0.1` | Terminal-state interpretation, complete snapshots, checkpoints and recovery outcomes |
| `soksak-spec-plugin-terminal` | `0.0.4` | Observable terminal-plugin lifecycle, presentation, input, commands, output-boundary status and exposed nodes |
| `soksak-kit-sidecar-terminal` | `0.0.7` | One shared PTY observation, recovery service and checkpoint runtime for all six engine providers |
| `soksak-kit-plugin-terminal` | `0.0.17` | Shared terminal-plugin implementation that serializes one renderer generation per pane and selects no engine |

`soksak-spec-plugin-terminal` is a public behavior contract referenced through `implements`. It is
not a manifest format. Every plugin manifest continues to use `soksak-spec-plugin@0.0.1`.

## Exact contract versions

Every public provider identity has one shape:

```ts
type ContractRef = { id: string; version: string }
```

`implements` uses an exact `{ id, version }`. `consumes` and `sidecars[].interface` use
`{ id, requirement }`. The PTY and terminal Sidecar interfaces remain exact `0.0.1`; the terminal
plugin behavior contract is exact `0.0.4`. A bounded range requires cross-version evidence.
Package dependencies remain separate and use exact remote commits or
immutable release assets in committed source. Local path overrides are development-only and are
never release inputs. Published bytes are not rewritten: `soksak-spec` advanced to `0.0.2` to
correct its package while continuing to validate component and interface version `0.0.1`.

## Ownership

### PTY sidecar

The PTY sidecar owns the shell, process generation, raw bytes and one total event order for output,
resize, clear and exit. It understands no terminal sequence and stores no terminal checkpoint.

An interactive renderer and a terminal-state observer use different attachments and absolute
source-sequence acknowledgements. A slow observer never blocks the shell. It receives a gap event
and may not publish a complete snapshot until it has been reseeded. Observer registration completes
before the child process can emit its first byte.

A snapshot lease retains every source event after the snapshot cursor until the renderer attaches,
the lease expires or retention fails. Failure is explicit.

### Terminal-state sidecar

The terminal-state sidecar owns parsing, the canonical screen projection, engine checkpoints,
portable snapshots, checkpoint scheduling, encryption, atomic storage and retirement. A renderer
view may be destroyed without destroying mirrored state. The singleton key is the installed
sidecar identity, so several engine sidecars may run simultaneously.

Every provider creates two products:

- an engine checkpoint for the most complete same-engine restore;
- a portable canonical snapshot for conformance, explicit cross-engine recovery and diagnostics.

ANSI restore data is one presentation encoding. It is not the canonical data model.

### Terminal plugin

A terminal plugin owns its renderer, input and IME behavior, selection, engine-specific settings,
translations and diagnostics. Mount and unmount own presentation resources only. Explicit close
ends the PTY and retires recovery state. Application shutdown releases connections and preserves
sidecar-owned processes.

Every plugin exposes commands, status and operable DOM or native-proxy nodes. An archived screen
rejects input until an explicit new-shell or provider-resume operation succeeds.

### Shared kit

The sidecar kit implements PTY observation, source ordering, recovery service transport, session
registry and checkpoint lifecycle exactly once. Six providers supply only their engine mirror
adapter and sidecar identity. Provider repositories do not copy this runtime.

The plugin kit may implement recovery coordination, pane topology, standard commands, status
publication, host I/O registration, input routing, theme projection and native-surface binding. It
does not define terminal semantics, checkpoint formats, renderers, engine settings, provider
selection or compatibility policy.

## Canonical terminal state

The canonical state describes observable terminal behavior: primary and alternate buffers,
scrollback, cursor, visible attributes, modes, margins, tab stops, protected cells, line
attributes, title, working directory, hyperlinks, graphics disposition and incomplete parser tail.
It excludes allocation, glyph-atlas and damage-tracking details.

The recovery provider stores the canonical state with the process generation and source cursor.
The same engine may additionally store an engine-specific checkpoint carrying state that cannot be
represented portably without loss.

## Conformance vocabulary and ownership

Normative documents use `canonical state`, `conformance case` and `reference state`. `Golden` is
not a normative term. Reference states cite an external specification or an explicit contract
decision. Candidate engine output is evidence and never authority.

A contract may contain its own schema, conformance cases, reference states and assertions when they
define only that contract. Reusable product implementation moves to a kit only after multiple real
consumers need the same code.

## Verification order

Implementation proceeds through complete vertical increments:

1. exact contract references;
2. ordered PTY observers, absolute acknowledgements and snapshot leases;
3. one end-to-end terminal proving same PID, complete snapshot, detached output and live input;
4. terminal-plugin behavior contract and the minimum shared kit required by xterm and a second plugin;
5. existing Alacritty, Ghostty, vt100 and WezTerm state providers;
6. Kitty and Shitty state providers;
7. Ghostty and vt100 presentation plugins;
8. generic native renderer hosting;
9. Shitty, Alacritty, Kitty and WezTerm presentation plugins;
10. the complete six-provider and seven-plugin fleet gate.

No later increment starts by replacing a working vertical path with unfinished infrastructure.

## Implementation status

This section records verified implementation state. A provider counts only after its shared-runtime
conformance and real-process gates pass. Engine SDK work alone does not count as a provider.

| Increment | Verified state |
| --- | --- |
| Exact contract references | Complete. Public references use exact `{ id, version }`. |
| Atomic PTY observation | Complete. The observer is ready before process output can begin. |
| Snapshot lease | Complete for warm attachment. Lease retention and explicit breakage are tested. |
| Shared recovery runtime | Warm recovery complete; encrypted checkpoint primitives pass owner tests, while complete archived recovery remains open. |
| Recovery providers | 6/6: Alacritty, Ghostty, Kitty, Shitty, vt100 and WezTerm pass common conformance and real PTY warm restore. |
| Terminal plugins | 7/7 repositories, exact manifests and bundles exist. xterm uses xterm.js; six plugins render sequence-receipted frames from their real providers through the shared accessible presenter. Full staged-sidecar fleet E2E remains open. |
| Shared plugin runtime | Status, PTY/lease/ACK coordination, checkpoint-key injection, provider frame receipts, operable DOM nodes and accessible presentation are implemented. |

Shitty revision `dd5c0d8c74f37a69a805a24b160472805a97c869` provides a production
headless snapshot interface and a flat C ABI. Its `vterm-c-sdk` target emits arm64
`libshitty_vt.a`, `libplt.a`, `libstd.a` and `vterm_c.h` without renderer, font backend,
application, session or native-window objects. The C smoke gate passes and generated outputs are
regular files, not symbolic links. The provider now passes the common conformance and real-process
warm-restore gates.

Kitty revision `d5f52872e805aa29837dcfe55d6833ae681805d3` provides a provider SDK around
its production Screen and VT parser. The Kitty provider passes the same conformance and real-process
warm-restore gates. Its release bundle must still carry the pinned Python runtime and rewrite native
install names before distribution.

Encrypted archived restore uses one shared AES-256-GCM checkpoint store. The Wails host creates its
device key in Keychain, Credential Manager or Secret Service, generates provider checkpoint keys
without exposing plaintext to JavaScript, and injects a provider key only into that sidecar process.
The shared kit proves authenticated checkpoint round trips, plaintext absence on disk and corrupt
checkpoint rejection. Complete archived recovery remains a product gate for all six providers.

The Shitty upstream baseline currently has one independent RED:
`Pty::OwnerDeathReleasesBlockedIoAndHangsUpChild` reproducibly leaves its blocked writer active
after owner release. This failure is not caused by the terminal snapshot interface and must be fixed
without weakening or excluding the test.


## Required evidence

The first complete recovery gate proves all of the following against real processes:

- the shell PID is unchanged across application restart;
- output produced while detached is received exactly once;
- a quiet terminal completes recovery without requiring a new output byte;
- the snapshot/live boundary has no gap or duplicate under sustained output;
- output, resize and clear remain ordered;
- stale process generations are rejected;
- observer gaps invalidate complete fidelity;
- corrupt checkpoints affect one pane only;
- archived screens reject input.

Every terminal plugin additionally proves keyboard, IME, focus, selection, clipboard, mouse, resize,
theme, accessibility, capture and renderer-failure behavior on its supported platforms.

## Wails application gates

Real-window gates remain because they measure pixels, native-surface geometry and arrangement
journals. An unattended launch uses the accessory activation policy, does not take focus and does
not add a Dock icon. Normal and forcibly terminated gate runs leave zero gate-owned processes.
Owner identity prevents cleanup from terminating a user's application.

Captures and recordings are mandatory development observations but never the sole pass condition.
Commands return the focus owner, Dock presence, process inventory, surface geometry, state cursor
and recovery phase used by mechanical verdicts.

## Prohibited designs

- compatibility readers, migrations and fallback protocol paths;
- implicit provider defaults or silent engine substitution;
- polling where an event, subscription, callback or receipt can exist;
- symlinks, guessed relative paths and personal absolute release paths;
- temporary test scripts instead of repeatable commands and repository tests;
- engine or plugin names in core source or the core dependency graph;
- raw retained-tail replay reported as complete full-screen recovery;
- lowering a correct standard because one candidate fails it.

## Completion

The terminal platform is complete when six state providers and seven terminal plugins pass their
independent gates on every declared platform, coexist under one identity, restore full-screen state
without source discontinuity, expose all command/status/node surfaces, satisfy license obligations,
and pass repository-owned, real-process, Wails, performance and visual verification.
