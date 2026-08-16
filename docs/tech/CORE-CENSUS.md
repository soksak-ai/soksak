---
kind: canonical
status: active
canonical: docs/tech/ARCHITECTURE.md
---

# Core census — every surface, judged by C6

Taken 2026-08-16 over `frontend/src`, `core`, `frameworks`. **The core holds no feature.** This
enumerates what is in it and puts each entry to C6's three questions: named after no domain, usable
by a plugin that never heard of the first consumer, impossible across the plugin boundary. Fail one
and it belongs to a plugin.

A verdict here is a decision, not an observation. Where the answer is REMOVE, the entry names the
work and `GATES.md` carries it until it is gone.

## Counted

| Axis | Count |
| --- | --- |
| Registered commands | 242 across 46 namespaces |
| Renderer directories | `lib` 62, `commands` 49, `state` 43, `plugins` 34, `components` 32, `ui` 11, `framework` 10, `terminal` 6, `orchestrator` 5 |
| Go packages under `core/` | 17 |
| `frameworks/wails` sources | 30 |

## REMOVE — a feature in the core

### 1. `kind: "file"` — a second content kind

The `Tab` union has two arms: `"plugin"` and `"file"`. The file arm carries `path` and
`mode: "code" | "preview"`, and the core branches on it in 18 places outside tests — the tab strip,
the status bar, the snapshot writer and its restorer, the plugin event bridge. Beside it sit
`FileViewerHost.tsx` and `fileViewerRegistry.ts` (212 lines), about 300 lines of `.fv-*` stylesheet,
and `explorer.list`.

Fails question one — "file" is one kind of content — and question two: a browser and a terminal
already reach the screen as `kind: "plugin"`, and a file viewer is the same shape. The second code
path exists for one content kind and no other.

**Goes to:** a file-viewer plugin, mounting as a plugin view. The core keeps the slot and the
registry seam it already has for every other view.

### 2. The orchestrator — 1,416 lines, and it spawns one product by name

The control-plane window renders `OrchestratorApp`. `orchestrator.ask` runs a natural-language turn
by spawning the agent CLI named in settings, and `agent.ts` states the spawn form of one specific
product. A natural-language console is content: it has a conversation, a feed, and an opinion about
what an answer looks like.

Fails question one and question three — a plugin can spawn a process through `app.pty` and publish
through the activity stream, so nothing here needs the core's address space.

**Goes to:** an orchestrator plugin. The core keeps the activity stream, the command registry and
the parent-id correlation, which every plugin uses.

### 3. Terminal rule in the core — 308 lines

- `terminal/terminalStatus.ts` maps a shell's OSC 133/633 events onto view status. What a byte from
  a shell means belongs to the plugin reading it.
- `terminal/idleTurnDetector.ts` decides a turn ended from an output gap, and `turn.signal` is its
  command surface.
- `term.read`, `term.send`, `term.exec`, `term.cwd` and `termResolve.ts` drive a terminal tab from
  the registry.
- `GroupStatusBar` shows a terminal's cwd in its own branch.

`app.pty` stays: a PTY's kernel object cannot cross the boundary (question three). Everything above
is a rule about what the bytes mean, and that crosses fine.

**Goes to:** the terminal plugin, which registers its own commands and reports its own status.

### 4. `media.proxy.*` — a mechanism wearing a content kind's name

A loopback HTTP proxy that fetches with caller-supplied headers and rewrites playlist URLs. The
mechanism passes all three questions; the name fails the first, and the m3u8 rewriting is one
format's rule.

**Becomes:** `net.proxy.*`, with the format-specific rewriting in the plugin that needs it.

### 5. `explorer.list` — a directory listing named after a UI

Reads a directory. The mechanism is `core/files`; "explorer" is a panel.

**Becomes:** part of the files surface.

### 6. `workspace.shell` — dead

A workspace record carries `shell`, two modals edit it, `window.open` takes it, and nothing that
spawns a PTY reads it. It served a start-program tool that no longer exists.

**Removed**, no destination.

## KEEP — a mechanism every plugin would otherwise reinvent

Each passes all three questions.

| Surface | Why it is the core's |
| --- | --- |
| `ui.*` (32) — tree, addresses, input, measure, trace | The address space of the frame the core draws. Named after no content. |
| `plugin.*` (26), `registry.*`, `program.*`, `unit.dev.*` | The loader and its registries. |
| `data.*` (23), `secret.*` (6) | Storage keyed by namespace. Serves a browser and a mail client alike. |
| `window.*` (19), `pane.*` (8), `layout.*` (7), `space.*` (5), `sidebar.*` (5), `tab.*` (10) | The frame itself — the one thing the core is. |
| `workspace.*` (11), `state.*` (5) | A workspace is a root path and a tree, not a content kind. |
| `pty.*` (9) | Question three: the kernel object belongs to the process that owns the window. |
| `daemon.*` (9), `process.*`, `service.*`, `schedule.*` (5) | Declared processes and their supervision. |
| `net.*` (6), `fs.*`, `clipboard.*`, `notify.*`, `media.proxy` after renaming | Host capabilities with no window. |
| `webview.*` (3), `framework.*` (4), `system.*` | The substrate this build runs on. |
| `app.*` (6), `update.*` (4), `theme.*` (4), `settings.*` | The installation and its chrome. |
| `capture.*`, `presentation.*`, `activity.*`, `status.*`, `command.*` | Observation surfaces — E1's numeric judges. |
| `core/` Go packages (17) | Host-independent answers, reachable with no window at all. |

`fixture.*`, `d.fixture` and `resolver.fixture.*` appear only inside test files and ship in no build.

## The pattern in all six

Every entry above reached the core because the core was where it was easiest to write — the store,
the command table and the stylesheet were already there. Nothing about any of them looks wrong in
place. The cost appears only at the second plugin of that kind, which can use none of it.
