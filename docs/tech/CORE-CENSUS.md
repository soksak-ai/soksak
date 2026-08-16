---
kind: canonical
status: active
canonical: docs/tech/ARCHITECTURE.md
---

# Core census — every surface, judged by C6

Taken 2026-08-16 over `frontend/src`, `core`, `frameworks`. **The core holds no feature**, and a
feature is code that holds an opinion about what content means or how it should behave. This
enumerates what is in the core and puts each entry to C6.

A verdict here is a decision, not an observation. **All six REMOVE entries were carried out on
2026-08-16**; each keeps its entry below with what went where, so the next surface proposed for the
core has the reasoning to be measured against.

## Counted

| Axis | Count |
| --- | --- |
| Registered commands | 242 across 46 namespaces |
| Renderer directories | `lib` 62, `commands` 49, `state` 43, `plugins` 34, `components` 32, `ui` 11, `framework` 10, `terminal` 6, `orchestrator` 5 |
| Go packages under `core/` | 17 |
| `frameworks/wails` sources | 30 |

## REMOVED — a feature that was in the core

### 1. `kind: "file"` — a second content kind

The `Tab` union has two arms: `"plugin"` and `"file"`. The file arm carries `path` and
`mode: "code" | "preview"`, and the core branches on it in 18 places outside tests — the tab strip,
the status bar, the snapshot writer and its restorer, the plugin event bridge. Beside it sit
`FileViewerHost.tsx` and `fileViewerRegistry.ts` (212 lines), about 300 lines of `.fv-*` stylesheet,
and `explorer.list`.

Fails question one — "file" is one kind of content — and carries opinions: that a file has a code
mode and a preview mode, that unsaved is a status a tab shows. A browser and a terminal already
reach the screen as `kind: "plugin"`, and a file viewer is the same shape. The second code path
exists for one content kind and no other.

**Done.** The arm, the host, the registry, the `contributes.fileViewers` declaration,
`ui.intent.open`, `file.opened/closed/saved`, `setFileMode` and 286 lines of stylesheet are gone. A
file-viewer plugin mounts as a plugin view, through the same seam as every other view. `--toolbar-h`
and `--toolbar-pad-x` are now declared in `:root`: a plugin's toolbar consumes them and they had
never been defined anywhere, so every plugin reading them got nothing.

**Nothing opens a file today.** Written here rather than left to be discovered.

### 2. The orchestrator — 1,416 lines, and it spawns one product by name

The control-plane window renders `OrchestratorApp`. `orchestrator.ask` runs a natural-language turn
by spawning the agent CLI named in settings, and `agent.ts` states the spawn form of one specific
product. A natural-language console is content: it has a conversation, a feed, and an opinion about
what an answer looks like.

Fails question one, and it is opinion end to end — what a turn is, what an answer looks like, which
CLI performs it. A plugin can spawn a process through `app.pty` and publish through the activity
stream, so nothing here needs the core's address space.

**Done, by cutting where the opinion starts.** The control-plane window keeps its screen — the
window map, the activity feed, and a console that runs one registry command — because all three read
core registries and hold no view about content. What left is the agent: `agent.ts`, `agentStream.ts`,
`orchestrator.ask/stop`, the two agent settings, `turn.signal`, and the output-gap turn heuristic.

A line that is not a command is now refused by name. A plugin that reads a sentence registers a
command, and the console already runs commands.

`feedFold` folded a set by the two kinds that one console published — `chat.prompt` opened and
`chat.answer` closed. A plugin publishing its own conversation got no card. The shape is the rule
now: `turnId` opens, `parentId` joins, `closesTurn` ends, which is MESSAGE-PROTOCOL §2 read rather
than a domain named.

**No natural-language console today.**

### 3. Terminal rule in the core — 308 lines

- `terminal/terminalStatus.ts` maps a shell's OSC 133/633 events onto view status. What a byte from
  a shell means belongs to the plugin reading it.
- `terminal/idleTurnDetector.ts` decides a turn ended from an output gap, and `turn.signal` is its
  command surface.
- `term.read`, `term.send`, `term.exec`, `term.cwd` and `termResolve.ts` drive a terminal tab from
  the registry.
- `GroupStatusBar` shows a terminal's cwd in its own branch.

`app.pty` stays — the kernel object cannot cross the boundary. So does `terminal/ptyObservation.ts`,
the OSC 7/133/633 byte-stream parser: it decodes a protocol and decides nothing, and every plugin
reading PTY output would otherwise write it again. What leaves is the opinion built on top of it —
that a gap means a turn ended, that a running command should read as a view's status line.

**Done.** The terminal plugin registers `read`, `exec`, `cwd` beside `send` and `clear`, reports its
own status through the view context, and places its working directory in the status bar as an item.
The status bar draws only registered items now — the two it drew itself were a branch on the content
kind, and a third kind of content had no way in.

Two capabilities were added rather than worked around, which is what ARCHITECTURE requires when a
plugin cannot be built within the seams: a plugin command handler receives the caller's `pane`, and
a status bar item may be a reading rather than a control.

### 4. `media.proxy.*` — a mechanism wearing a content kind's name

A loopback HTTP proxy that fetches with caller-supplied headers and rewrites playlist URLs. The
proxy is a mechanism and stays; the name fails question one, and the m3u8 rewriting is one format's
rule — an opinion about what a playlist is.

**Removed.** `media_proxy_info` was declared unserved, so the three commands answered a proxy this
build does not run. A proxy can come back as `net.proxy.*` when a plugin needs one; the m3u8
rewriting will not.

### 5. `explorer.list` — a directory listing named after a UI

Reads a directory. The mechanism is `core/files`; "explorer" is a panel.

**Done** — it is `fs.list`.

### 6. `workspace.shell` — dead

A workspace record carries `shell`, two modals edit it, `window.open` takes it, and nothing that
spawns a PTY reads it. It served a start-program tool that no longer exists.

**Removed**, no destination.

## KEEP — a mechanism every plugin would otherwise reinvent

Each is named after no domain, usable by a plugin that never heard of the first consumer, and either
host-owned or something every plugin would write again.

| Surface | Why it is the core's |
| --- | --- |
| `ui.*` (32) — tree, addresses, input, measure, trace | The address space of the frame the core draws. Named after no content. |
| `plugin.*` (26), `registry.*`, `program.*`, `unit.dev.*` | The loader and its registries. |
| `data.*` (23), `secret.*` (6) | Storage keyed by namespace. Serves a browser and a mail client alike. |
| `window.*` (19), `pane.*` (8), `layout.*` (7), `space.*` (5), `sidebar.*` (5), `tab.*` (10) | The frame itself — the one thing the core is. |
| `workspace.*` (11), `state.*` (5) | A workspace is a root path and a tree, not a content kind. |
| `pty.*` (9), `terminal/ptyObservation.ts` | The kernel object belongs to the process that owns the window; the OSC parser decodes a protocol and decides nothing. |
| `daemon.*` (9), `process.*`, `service.*`, `schedule.*` (5) | Declared processes and their supervision. |
| `net.*` (6), `fs.*`, `clipboard.*`, `notify.*`, `media.proxy` after renaming | Host capabilities with no window. |
| `webview.*` (3), `framework.*` (4), `system.*` | The substrate this build runs on. |
| `app.*` (6), `update.*` (4), `theme.*` (4), `settings.*` | The installation and its chrome. |
| `capture.*`, `presentation.*`, `activity.*`, `status.*`, `command.*` | Observation surfaces — E1's numeric judges. |
| `core/` Go packages (17) | Host-independent answers, reachable with no window at all. |

`fixture.*`, `d.fixture` and `resolver.fixture.*` appear only inside test files and ship in no build.

## What is left, named

- `frameworks/wails/register.go` types `HostDeps.Sessions` as `terminalcmd.Sessions`, and
  `terminal_sink.go` takes `terminal.Handle`. Both are entered in `couplingWiring` marked DEBT: the
  core owns no session contract and no trace contract for them to be typed against yet.
- A workspace record no longer carries `shell`, and no core surface names a shell.

## The pattern in all six

Every entry above reached the core because the core was where it was easiest to write — the store,
the command table and the stylesheet were already there. Nothing about any of them looks wrong in
place. The cost appears only at the second plugin of that kind, which can use none of it.
