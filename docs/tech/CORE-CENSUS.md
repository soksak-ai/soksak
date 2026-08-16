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

### 7. A vendor's environment, and three comments naming a product

Found on a second pass, after the first six were done and the question "so the code has no features
at all?" was asked rather than assumed.

`core/process/environment.go` held `AISessionEnv` — six `CLAUDE_CODE_*` variables, a `CODEX_*` and
`AI_AGENT` — scrubbed from a child's environment when a caller passed `scrubAiEnv`. No caller passed
it: the orchestrator agent was the only one, and it left with entry 2. Removed with its parameter,
its manager field and its decode.

Three comments named one product where the code named none: a shell-escape rule "for Claude Code"
whose code left with the drop handler, a step-⑤ session watch this file no longer performs, and
`.claude/skills/<id>` as where a skill installs — a path no command in this build writes.

The domain-word list now holds vendor names as well as content kinds. `soksak-plugin-<x>` was caught
by the plugin scan; a vendor's name was not, and it arrives as an environment variable, a spawn form
or a directory.

`core/files/binary.go` keeps its mime table and its size cap — a plugin reading a file needs both —
but they were framed as "what a **preview** can render" and `maxPreviewBytes`, shaped and named for
the viewer that left. The mechanism is the same; the framing was the residue.

### 8. A media type table — the core said what a file is

Raised as a question rather than found by a scan: should a preview live in the core at all?

`core/files/binary.go` mapped 24 extensions to media types and `read_file_base64` carried the answer
to every caller, `application/octet-stream` for everything else. An HWP viewer, an editor for an
unlisted language, a CAD format — each would have arrived as a one-line edit here, which is the
missing capability A9 names and C6's second question failing outright: a plugin that never heard of
the first consumer **cannot** use it unchanged.

The split:

- **Core** — path validation against the home boundary, the read, the size ceiling, the blob URL with
  its cache and revocation. The part that cannot leave the process owning the disk.
- **Not core** — what the file is. `read_file_base64` answers `{ base64, bytes }`, and
  `app.files.url(path, mime?)` takes the type from whoever knows it: an editor its languages, an
  image viewer its formats, an HWP plugin one.

**No new registry was added.** Which plugin can show which document is a contract between plugins
(C3/C4): a viewer declares `implements`, a consumer resolves through `plugin.implementers` and picks.
The core indexes the declaration and never interprets it — C4 constrains the *shape* of a contract id
and nothing about its meaning. Routing lives in whoever wants to open something, not here. Building a
registration seam today would be an extension point with no consumer (4-2).

Gate: `TestTheCoreAnswersNoMediaType` refuses an extension literal and a `type/subtype` literal on
one line. A media type alone stays legitimate — a capture writes `image/png` because it made a PNG.

### 9. A contract id the core spelled out, and a preset that named two domains

Raised as a question — "we don't even have `soksak-spec-plugin-terminal`, did we invent it?" The id
was real: the terminal plugin declared `implements`. What was wrong is that the **core** held it.

`plugins/terminalEngine.ts` kept `soksak-spec-plugin-terminal` as a constant for three affordances,
and the generic machinery beside it — discovery, selection, resolution — never named one and did not
change. A contract's definition is owned by whoever implements it (PLUGIN-CONTRACT P5); the core
naming another's is the same coupling as naming the plugin, one level up.

- **⌘T** opened a terminal. It opens the add-tab menu on the active pane now, and the person picks.
  A tab is the frame's; which content fills it is not. The shortcut fires at the window and the menu
  is drawn by the tab bar, so `state/addTabIntent.ts` is the channel between them.
- **Two install paths** ran a command in "the configured terminal engine". They publish the fact and
  the exact command into the activity stream now — `program.missing` and `library.missing`. Where a
  command runs is not the core's decision, and every window, plugin and CLI reads that stream.
- **`layout.apply preset=dev`** built a terminal and a browser side by side, resolving one through
  the contract and matching the other against the conventional id `browser`. Gone: `spaces` is the
  only form, and a caller that wants that layout names those two programs. `findBrowserProgram` went
  with it.
- **The plugin's `implements` declaration is gone too.** With the core no longer asking, the contract
  had a provider and no consumer — a declaration nobody reads, which is the extension point 4-2
  forbids. When a plugin needs "a terminal", that plugin defines the contract and the implementer
  owns the definition.

Gate: `TestTheCoreNamesOnlyItsOwnSpecs` lists the six ids this repository defines and refuses any
other `soksak-spec-` literal. It caught one more on the way in — a `plugin.implementers` example
naming `soksak-spec-plugin-git`, a contract nobody implements. The example reads the registry now.

### 10. A second identity for what the plugin id already names

Raised as a question and then stated plainly: a plugin has a spec, and there is no stage that
collects specs. The core has the core's spec; a plugin has the plugin's.

Three things existed where one was needed.

**Interface ids.** `implements` and `consumes` named a contract a provider offered and a consumer
asked for, so either side could be swapped without knowing the other. The id duplicated the plugin
id, and the core ended up holding one as a constant (entry 9).

The measurement written here first was wrong and is corrected: it read the two plugins installed in
the run home and concluded no interface ever had both sides. The corpus is 47 plugins in the
development home, and nine interfaces have both — three browsers implement one, two terminals
implement another, seven plugins consume git. What that changes is the sentence, not the entry:
a sample is brought to the rule, not the rule to the sample. Those manifests are the list of things
to bring into conformance. Removed: the fields, the grammar, discovery, selection, resolution,
`ContractEngineSettings`, `plugin.implementers`, the activation-boundary enforcement, and the
installer's provider axis. A plugin that needs another names it in `dependencies` — one route across
the boundary, and the call gate checks that one thing.

A sidebar slot named a contract; it names a plugin and a view. A program had `viewContract` beside
`viewPlugin` — two ways to say one thing — and keeps `viewPlugin`.

**Seven names for the core's own format.** `soksak-spec-release@0.0.1`, `-registry@`, one per unit
kind, and so on: all defined in one file, all moving together at `0.0.1`, each announcing in its own
value which document it was while the field's place already said so. One `CORE_SPEC` now, and a
manifest says `"spec": "0.0.1"`.

**The prefix itself.** The reason written down for it was that a scanner could tell a contract id
from a plugin id in core sources — a rule shaped to suit a scanner. Gone with the thing it named.

A mechanism for choosing between two implementations gets built against the case that needs it. The
sample corpus holds three browsers and two terminals, so that case is real and is not this entry's.

Gate: `TestTheCoreHoldsNoSecondIdentityNamespace` refuses any `soksak-spec-` literal in core sources.

Measured on a running build: both plugins enable with no error, `ui.validate` passes, a terminal
opens with a live shell, and the browser draws.

### 11. A window has three regions, and the plugin declares which one

The sidebar was a shell with nothing in it and two mechanisms behind it. `leftLayout` — a split tree
of views the person arranges, the same machine the pane area uses — and a *projection*, where a
content view declared what belonged in the sidebar beside it, resolved per binding.

The second is a view about content, which is the one thing A1 forbids, and it is what produced a slot
pointing at a plugin that does not exist.

**A plugin declares the region.** `placements` reads `left` | `center` | `right`, one or several, and
`defaultPlacement` is where the view goes. A region is a place; `content` and `rail` were roles —
this one is the main thing, that one is auxiliary — and the core holds no such view. One vocabulary
throughout: a placement declares a region, an address names one (`win/<label>/center/view/…`), a view
host is handed one.

`rail-footer` is gone — a position inside a region is an order the person arranged. The footer
*frame* stays, empty, because the frame is the contract (measured 2026-08-15: a window with no
plugins had no footer and sat one row off from its neighbour). `resident` is gone with it: the right
sidebar borrowed left-placed views carrying that flag, a flag standing in for a region.

Removed: `projection.ts`, `projectionWiring.ts`, `ProjectionSlots.tsx`, `catalogProjection.ts`,
`ui.projection.*`, the `sidebar` declaration with its slots, instances and templates, the persisted
pins, and A1's clause requiring a content view to declare a sidebar.

Measured on a running build: the left sidebar stands as an empty frame — the "no sidebar provider"
line (`projection.degraded.unresolved`) is gone, because there is no provider to look for —
`ui.validate` passes, addresses read `center`, and both plugins draw.

**Nothing is placed left or right yet.** No plugin declares those regions, so both sidebars are empty
frames.

**A section is a plugin** (A2a). A file tree, a daemon list, bookmarks, a terminal — each is its own
plugin declaring the region it is placed in, and no plugin provides another's section. A plugin with
only a left view and nothing in the centre is the ordinary case, not a special one:
`sidebarOnly.test.ts` holds that shape.

**What appears with what is a separate question, and the workspace answers it** (A2a). A manifest
declares a region and no companion; which sections are open, split or tabbed and in what order is the
workspace's state, arranged by the person and restored with the workspace. Which pane a section
follows arrives at mount as view context, so a section names no plugin either.

## What is left, named

- `frameworks/wails/register.go` types `HostDeps.Sessions` as `terminalcmd.Sessions`, and
  `terminal_sink.go` takes `terminal.Handle`. Both are entered in `couplingWiring` marked DEBT: the
  core owns no session contract and no trace contract for them to be typed against yet.
- A workspace record no longer carries `shell`, and no core surface names a shell.
- **A plugin cannot declare a keybinding.** ⌘T is the frame's own shortcut and names nothing, so it
  stays; a plugin that wants its own has no way to ask, and nothing needs one yet.
- **Both sidebars are empty.** The core owns the frame — regions, split, tabs, order, persistence —
  and no plugin declares `left` or `right` (entry 11).
- **Nobody installs a missing binary.** The core publishes `program.missing` and `library.missing`
  with the exact command; no plugin subscribes, so a person reads the stream and runs it.

## The pattern in all ten

Every entry above reached the core because the core was where it was easiest to write — the store,
the command table and the stylesheet were already there. Nothing about any of them looks wrong in
place. What it costs shows at the second plugin of that kind, which can use none of it.
