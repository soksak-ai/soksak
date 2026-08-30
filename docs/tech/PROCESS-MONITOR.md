---
kind: reference
status: active
canonical: self
scope: workspace
---

# Process monitor contract

The process-monitor sidebar is a read-only view of processes that belong to the current Soksak
environment. It does not scan the workstation, infer ownership from an executable name, or inspect a
terminal plugin's private state.

## Current gap

Core's existing `process.list` reports only children started by Core's process manager. A terminal
shell is owned by `soksak-sidecar-pty`, so a running terminal can correctly have `process.list = []`.
The PTY owner now exposes its running shell snapshot through `process.inventory` and a bounded
`process.observe` stream for shell and descendant start/update/end events. Core now exposes `process.inventory` and accepts
injected owner sources without reading their implementation, and wires the PTY source through the
public contract at the application boundary. The source is not started by an inventory read when
no PTY is running. PTY 0.0.22, Core's event relay, and Process Monitor 0.0.15 close descendant
start/end delivery and installed visual acceptance without polling. The remaining process-monitor
gate is a measured sidebar-resize sequence; the terminal/browser tab-transition half is GREEN.

The 2026-08-30 isolated installation of monitor 0.0.6 and the already-installed File Tree both
showed the sidebar frame and tab but no provider-owned DOM after section placement. `ui.plugin-view.overlay`
reported `registryPresent=true`, `overlayReason=none`, and `mounted=[]`; the capture therefore proves
a Core sidebar-host mount RED, not an empty process result. This must be fixed at the section-to-
`PluginViewHost` lifecycle before either sidebar is accepted visually.

After rebuilding the current Core and installing monitor 0.0.9 in a fresh isolated identity, the
empty project state rendered `No owned processes in this project`. A real `process_spawn` with cwd
equal to that project's root then appeared in `process.inventory` with the same cwd, and the
focus-free capture showed owner `soksak-core`, command, pid, project path and `running`. This closes
the snapshot consumer's project-filter visual row; it does not certify a PTY shell or descendant
process yet.

The same check was repeated on 2026-08-30 in an isolated test identity, using the current arm64
Core build and monitor 0.0.9. The focus-free capture visibly showed the selected project
project sidebar with the Core child `/bin/sh -c sleep 20`, its PID, the exact project `cwd`, and
`running`. The machine observations were `process.inventory` revision 1 with one `soksak-core`
record and a monitor refresh returning two owners; this is repeat evidence for the project-root
intersection, not evidence of PTY descendant coverage or tab-transition stability.

The PTY owner `soksak-sidecar-pty` `0.0.19` is now an immutable local release containing the Unix
descendant reader and working-directory field; its local release digest is
`1ab2742ac51d474390397a03543730c8d075992d6f622bc7eb5b0298c513d552` (source `b2e774d`). The
existing 0.0.18 and 0.0.17 remain untouched, so environments selecting them do not change implicitly.

On 2026-08-30 an isolated workspace installed File Tree 0.0.3 and process-monitor 0.0.9,
created one section set containing both views, and mounted it in the left region. The focus-free
capture showed both `File` and `Process` tabs with the File Tree content visible; activating the
process tab produced
`No owned processes in this project`. `ui.plugin-view.overlay` reported both views `ready` and the
visible process view measured `298px × 473px`. This proves sidebar composition and per-project
visibility, not terminal descendant coverage or tab-transition stability.

An isolated install of xterm candidate 0.0.64 on 2026-08-30 started the 0.0.19 PTY sidecar and
rendered a prompt, but its status bar showed the Core checkout rather than the selected workspace
root. The candidate still embeds terminal kit 0.0.80. This was a measured RED for the
terminal-to-project `cwd` boundary, not a PTY ownership failure. The kit fix and the later candidate
that consumes it are recorded below.

The xterm candidate was then rebuilt as 0.0.65 after kit 0.0.89 became registry-resolvable. In an
isolated identity, the runtime selected PTY 0.0.19 and kit 0.0.89; terminal status reported the
declared workspace root, and the focus-free capture showed the prompt, `XTERM_CWD_GREEN` output,
and the same root in the footer. This closes the previously measured terminal-to-project `cwd` RED for
this candidate. Selection drag remains a separate gate.

The same xterm 0.0.65 closure was then run with two terminal tabs in one pane. Distinct PTY markers
were written to each tab and `tab.switchScan threshold=0.0001` returned `clean=true`,
`switchFrames=1`, `flickerFrames=0`, with no blank, overlap, or native-mismatch frames. The
focus-free capture showed the active second tab, its marker output, the prompt, and the declared
workspace-root footer. The lower threshold is explicit because the
marker changes only a small fraction of the full window; it is not a relaxed pass criterion.

## Public boundary

### Monitoring selection rule

The monitor uses two independent facts and their intersection. `environment.json` selects the
installed owner release; it does not select processes. The owner publishes a process record with an
authoritative `cwd`; the selected project supplies its root. A record is shown only when its owner
is installed and its `cwd` equals the project root or is below it. A terminal or sidecar must have
opened the process for a record to exist; a browser view creates no process record. An unavailable
owner is reported as unavailable and is never collapsed into an empty process list.

The owner snapshot is the initial read and the owner event stream is the live path. Both carry a
monotonic revision. A gap is a failed observation requiring a new snapshot, not permission for the
consumer to poll or inspect the workstation.

Core validates the boundary shape without inspecting the owner implementation: every record's
`owner` must equal the enclosing `OwnerInventory.owner`. A mismatch is rejected as a contract error;
it is never silently rewritten to the registered owner.

The owner of a process publishes a generic record through the process contract:

```text
process.inventory -> {
  revision,
  processes: [{
    id, owner, window, pane, pid, parentPid, command, state,
    startedAtUnixMs, endedAtUnixMs?
  }]
}
```

`owner` is the declared component identity, `window` and `pane` are optional ownership keys, and
`state` is `running` or `ended`. The record never includes a source checkout, private socket path,
or guessed repository name. An owner may expose only processes it started or explicitly adopted.
The Core aggregator combines records through an injected owner interface; it does not know how a PTY
or another sidecar discovers its descendants.

The same boundary emits `process.started`, `process.updated`, and `process.ended` events with the
record id and revision. Events are the live update path. `process.inventory` is a snapshot command
for initial mount and an explicit user read, not a polling loop. A revision gap is a failed read, not
permission to silently refresh.

The PTY sidecar owns the shell and its process group and therefore supplies the terminal process
records through its own public contract. Core relays those records without parsing shell output.
Terminal plugins and the monitor plugin consume the generic process surface; no plugin imports
another plugin or names a provider engine.

The first monitor release is read-only. There is no kill command, signal escalation, timeout or
fallback list. A later signal operation requires its own contract and ownership proof.

## Sidebar composition

The monitor contributes one `process-monitor` view on the `side` surface. Core's `sections.create`,
`sections.arrange`, `sections.left`, `sections.link`, and `sidebar.move` compose it with File Tree or
another sidebar. The view receives only the generic process snapshot/events and the binding context
(`projectId`, `window`, `pane`); it cannot read the layout store or another plugin's DOM.

## Required RED→GREEN gates

1. Contract tests reject records without an owner, with an unowned PID, or with a revision gap.
2. PTY owner tests publish a shell and one descendant with stable ids and remove both on group exit.
3. Core tests aggregate two fake owners and preserve ownership fields without reading their source.
4. Monitor plugin tests render an initial snapshot, apply events once, and refuse stale revisions.
5. An installed capture-only run opens a terminal, executes a marker process, and confirms the
   monitor shows the shell/process records while `process.list` may remain Core-only.
6. A finite recording and `surface.inventory` prove the composed sidebar remains visible during
   terminal/browser tab switches and sidebar resize. Screenshots are observation evidence, never
   the sole verdict.

Until all six gates are GREEN, the process-monitor sidebar remains an explicitly missing capability.

## Vision cwd and installed monitor evidence — 2026-08-30

The native Vision path had a separate cwd omission. Plugin Kit 0.0.99 now passes the pane's declared
initial cwd through `TerminalPresenterOptions`; Vision 0.0.53 writes it into the public terminal
surface source before the service opens the PTY. The Kit RED received no cwd; GREEN receives the
exact project root. Kit 0.0.99 was published to the local Registry and immutable store with digest
`5c5a352f68c9453ea2774dabc1fcdb194fae4683ce3700e64ba3209d8acc7e13`. Vision 0.0.53 was accepted as
`published` then `unchanged`, digest
`89bf593e5ee2dbc211bfd9ec2a5491eb5e82f14c057bf1e3ff37b4a4f1de0f9c`.

Process Monitor 0.0.9 crashed when an older, valid PTY record omitted optional `cwd`.
Process Monitor 0.0.10 treats such a record as unattributable instead of dereferencing it and
publishes `PROCESS_CWD_UNAVAILABLE: <count>` in its exposed view. Its named RED failed with
`undefined.startsWith`; GREEN returns no project match and counts the missing field. The release is
immutable with digest `0daa9e60ed6b42984985d702fb740fde247593fa6100596c9b61faf724649120`.

An isolated installed product composed File Tree 0.0.3 and Process Monitor 0.0.10 in one left-side
section set. Both view keys appeared in `sections.list` and `sidebar.tree`; the file tree visibly
rendered the project, and the monitor view reached `bootPhase=ready`, `overlayReason=none`. A new
Vision 0.0.53 terminal published its exact workspace root in `process.inventory`. Running
`sleep 20 &` produced the owned shell and descendant records with stable IDs, parent PID, command,
the same cwd and `running`; the non-key capture showed both records beside the live terminal.
Older restored sessions remained visible only as the explicit missing-cwd count.

This closes the installed snapshot, project filtering, shell, descendant, local-registry and basic
sidebar-composition rows. The explicit `refresh` command remains operator recovery, not a live path.

## Event-driven installed acceptance — 2026-08-30

PTY 0.0.22 owns descendant observation with a Darwin process-event watcher and publishes the same
monotonic owner ledger through snapshot and event interfaces. Its immutable local release digest is
`78611e24e0b8c1989e67b4409a80ecf9105fe4814823873f6a39253d2d236385`. Core source `81e25abf`
subscribes to `process.observe` when the declared PTY unit starts and relays the public
`process.inventory.changed` event; it does not read the PTY source tree or process implementation.

Process Monitor 0.0.15 reduces that event stream and exposes `status` plus an event-driven `wait`
command. `wait` requires an owner, a lower revision bound, and optionally an exact process count.
It resolves only from the reduced state; its timer is a bounded failure deadline, never a polling
loop. The owner RED showed that a handler without a declared command schema was rejected as
`INVALID_PARAMS`; the GREEN declares every parameter in the public registry. A second RED exposed a
deadline as generic `INTERNAL`; the GREEN returns the machine-readable `TIMEOUT` code. The immutable
release was accepted as `published` and then `unchanged`, digest
`491a3088fda7e2046c5a58e29bf2b28e56802ec5ae3e0e6f37cff20d10a45561`.

In an isolated capture-only installation, the baseline was owner revision 8 with four shell
records. Without calling `refresh`, starting one `sleep 60` resolved `wait` at revision 9 with five
records. Terminating the same PID resolved the next `wait` at revision 10 with four records. A second
start reached revision 11, and a focus-free native-composed capture visibly showed the four shells
and the owned `sleep 60` descendant beside the terminal. Cleanup reached revision 12 with four records. Thus
snapshot, Core relay, plugin reducer, public wait command, and rendered row agree on the same owner
revisions.

Linked terminal and browser sidebar sets were also switched in an installed window. Each direction
settled in one frame with zero flicker, blank, overlap, or native-mismatch frames. That closes the
tab-transition half of gate 6. A finite sidebar-resize recording remains OPEN and is not inferred
from the static capture.
