# soksak Architecture — The Skeleton Contract (v1)

This is the authoritative v1 architecture contract for soksak. It is binding on the core (the skeleton) and on every plugin. Where this document and code disagree, fix the code. Where this document and a single-source-of-truth schema disagree, the schema wins for what it can enforce and this document wins for everything it cannot.

---

## 1. Identity and Purpose

soksak is a skeleton. It manages common interfaces and nothing else.

**The skeleton IS:**
- A host for content panes that have no opinion about their content.
- A registry substrate: one command registry, one program (+menu) registry, one view-placement registry, one capability API, one event bus.
- A native substrate: window/pane/layout, child-webview hosting, PTY spawning, filesystem, data store, secrets vault, process and network clients — exposed as **generic** capabilities.
- A single point of contact for CLI, MCP, and Skill surfaces — auto-derived from the command registry.

**The skeleton IS NOT:**
- A terminal. The skeleton spawns PTYs; it does not render an xterm.
- A browser. The skeleton hosts child webviews; it does not own a URL bar.
- A file explorer or an editor. The skeleton reads files and hands out a bare content slot; the file-viewing and editing experience — and the editor engine itself — are replaceable plugins.
- A place for feature logic. Terminal, browser, file explorer, and editor are independent plugins, weakly coupled to the skeleton.

The skeleton renders no content. Every concrete content surface arrives through one of four attachment seams (Section 3). A plugin that needs a private path into the skeleton is a defect in the skeleton, not a feature of the plugin.

The skeleton ships with zero content plugins. A fresh install opens to an empty frame; terminal, editor, files, and browser are installed and enabled on demand like any other plugin — there is no bundled-default or seed mechanism.

---

## 2. The Substrate — What the Skeleton Owns

The skeleton owns exactly these common interfaces. Each line states the guarantee. Nothing concrete (no xterm, no URL bar, no file-type switch) lives here.

| Interface | Source | Guarantee |
|-----------|--------|-----------|
| **Window / Pane / Layout** | `src/state/sessions.ts` | Owns the layout tree (`GroupNode`, `ViewGroup`, `View`, `ContentArea`). Splits, moves, closes, maximizes, resizes panes. The tree is opaque to plugins — never exposed, only mutated through commands. |
| **Generic content-pane hosting** | `src/components/GroupArea.tsx`, `src/components/PluginViewHost.tsx` | Renders one persistent off-screen-parkable slot per `view.id`. The slot is a bare container. The skeleton attaches no renderer to it beyond the plugin-provider mount contract. |
| **Command registry (single source of truth)** | `src/commands/registry.ts` | One registry. Every command (core or plugin) registers once with a typed param schema and danger gate. `catalogJson()` auto-exposes the same set to CLI, MCP, and docs. No command exists outside this registry. |
| **Capability API (`app.*`)** | `src/plugins/api.ts` | The only runtime surface a plugin receives. Permission-gated: an undeclared permission yields an absent (undefined) capability. Namespaced per plugin (`data[ns=pluginId]`, `secrets[ns=pluginId]`, `plugin.<id>.<cmd>`). |
| **Event bus** | `src/plugins/hooks.ts`, `src/plugins/bus.ts` | System events (`project.*`, `file.*`, `command.*`, `turn.ended`, `theme.changed`, `locale.changed`, `app.focus`, `bookmarks.changed`) are permission-gated. `bus.*` is plugin-to-plugin pub/sub independent of core state. |
| **Program (+menu) registry** | `src/plugins/programRegistry.ts` | Declarative `contributes.programs[]`. Each program declares a `kind`. The +menu and `view.open` route by `kind`. Plugins declare programs; the skeleton routes them. |
| **View placement registry** | `src/plugins/viewRegistry.ts` | `registerView(viewId, provider)` with placements (`content`, `sidebar-left`, `sidebar-right`, `footer`). The skeleton calls `provider.mount(container, ctx)` / `unmount(container)` and nothing more. |
| **Native generic capabilities** | `src-tauri/src/*` | PTY spawn/IO/flow-control (`pty.rs`), child-webview lifecycle + layer inversion + hole-punch (`browser.rs`), media proxy (`mediaproxy.rs`), data store (rusqlite + FTS5), secrets vault, process/WebSocket/HTTP clients, filesystem, git read. All generic — none named after a concrete feature consumer. |

The native layer stays in the skeleton because PTY kernel objects and platform webviews (WKWebView / WebView2) cannot cross the plugin boundary. The skeleton exposes them as generic capabilities; plugins consume them as thin clients.

---

## 3. The Weak-Coupling Model — The Only Attachment Seams

A plugin attaches to the skeleton through exactly four seams. There are no others. There is no private channel, no direct store import, no back door into native commands.

1. **Programs (+menu).** `contributes.programs[]` declares an entry with a `kind`. The skeleton routes selection to the matching capability. This is how a plugin appears in the +menu.

2. **Views (placements).** `contributes.views[]` + `registerView(viewId, provider)` mounts a provider into a generic slot at a declared placement. The provider receives only the view context (Section 4, A2).

3. **Commands.** `app.commands.register(name, spec)` registers one command with a typed param schema and danger gate. It auto-exposes to CLI/MCP. Manifest `contributes.commands` declares intent; runtime binds.

4. **Capabilities.** `app.*` methods, gated by declared permissions, plus `app.events.on(...)` and `app.bus.*`. This is the only runtime surface.

Anything a plugin cannot express through these four seams, the plugin must not do. If a real plugin cannot be built within these seams, the skeleton is missing a generic capability — add the capability (Section 5), never a private path.

---

## 4. Principles (A1–A13)

These are HARD. They are stated absolutely on purpose.

### A1. Core renders no concrete content.
The skeleton hardcodes no terminal renderer, no browser chrome, no file-type renderer. `GroupArea` dispatches by an opaque `view.id` into a bare slot. A `view.kind` string is a routing label, not a license to embed an implementation. Concrete renderers (xterm, URL bar, CodeMirror strategy switch) move to plugins.

### A2. The view context is the only data channel into a view.
A plugin view receives state through its `PluginViewContext` and through `app.*` capabilities. It must not import core Zustand stores, reach into `sessions`/`settings`/`ui`, or read the layout tree. Plugins must not reach into core stores. The context carries identity (`projectId`, `root`, pane/view identity) and nothing the skeleton has not chosen to hand over.

### A3. Generic capability only — no view-specific hooks.
Every capability the skeleton exposes must be feature-neutral. No `onBrowserNavigated` baked into the core; expose generic webview events. No terminal-only spawn endpoint dressed as core; expose a generic pane/PTY capability. A capability named after one consumer is a lock-in and is prohibited. Existing feature-named events (`browser-nav`, `native-mousedown`, `browser_overlay_active`) are migration debt, not the contract — they generalize per Section 5.

### A4. No core lock-in.
The skeleton must not assume terminal/browser/files are built-in. View kinds, program kinds, and routing must be data-driven, not a fixed enum the skeleton special-cases. Adding a new content subsystem must require zero edits to the skeleton.

### A5. Single source of truth is the schema/spec.
`src/plugins/spec.ts` (manifest, permissions, contributions) and `src/commands/registry.ts` (command catalog) are the single sources of truth. Prose in this document adds only advice the schema cannot enforce. Do not restate, in prose, what a schema already enforces; do not invent constraints a schema does not back.

### A6. Idempotent.
Every plugin action must be safe to repeat. Activation, autorun, view mount, and command execution must converge to the same state whether run once or many times. A plugin reloaded mid-session must reconcile from current state, not assume a clean boot.

### A7. Independent.
Each plugin is its own git repository with its own build, tests, and lifecycle. A plugin must not depend on the internal source of the skeleton or of another plugin beyond declared manifest `dependencies`. The skeleton resolves transitive dependencies and cascade-removal; plugins do not.

### A8. Removable (the separation test).
Removing any plugin must leave the skeleton and all unrelated plugins fully functional. Disabling a plugin closes its views and unregisters its commands/programs with no orphaned native resources. If removing a plugin breaks the skeleton, the coupling is illegal.

### A9. Zero-core-change to add (the combination test).
Adding a new plugin must require zero changes to the skeleton. If a new plugin forces a skeleton edit, the skeleton is missing a generic capability — close that gap in the substrate, then add the plugin with no core diff.

### A10. Theme via host CSS variables.
Plugin views inherit theme strictly through host-injected CSS custom properties propagated into the shadow root. A plugin must not read the theme store, hardcode palette values, or branch on theme name. Recoloring the host recolors every conforming plugin with no plugin change.

### A11. The editor is a plugin; the skeleton routes, it does not edit.
Opening a path as content flows through a generic skeleton routing command (`editor.open` — open-path-as-content) that dispatches to whichever plugin registered a viewer for that file type (`registerFileViewer`). The skeleton owns no editor instance and vends no editor engine. The editor plugin owns its engine (CodeMirror by default, Monaco or any other by substitution), bundles it itself, and exposes its own extension surface; formatter and language plugins depend on the editor plugin through manifest `dependencies`, not on the skeleton. Active-file read/write is the editor plugin's capability, mediated through the command/event surface — not a skeleton-owned editor.

### A12. Verify, never assume.
Conformance is proven, not asserted (Section 6). "Looks decoupled" is not decoupled. A grep that returns matches is a failing separation test, not a stylistic note.

### A13. Engine-neutral primitives — the skeleton fixes no engine.
The skeleton exposes only engine-neutral raw substrate: raw PTY bytes, file IO, an OS-webview hosting primitive (one option among possible rendering approaches), and a bare content-pane surface. It fixes no concrete engine. The terminal emulator (xterm or other), the editor engine (CodeMirror or Monaco), and the browser engine (OS webview or Chromium) are each a plugin's replaceable choice. A capability only one engine can satisfy — a CodeMirror `Extension` type, an xterm addon, a WebKit-only eval shape — does not belong in the skeleton; it belongs in the plugin that owns that engine. Where an alternative engine needs a primitive the skeleton lacks (e.g. embedding an external Chromium surface), add it generically when that plugin is built (A9); never special-case one engine.

---

## 5. Extraction Targets

For each subsystem: what STAYS in the skeleton (the generic interface), what MOVES to the plugin (the concrete implementation), and the generic capability the skeleton must expose. Gaps are cited from the grounded subsystem maps.

### Terminal → plugin

**STAYS (skeleton):** PTY spawn/kill, reader thread, ACK flow control, ZSH integration injection, environment cleanup (`pty.rs`); pane host registry and DOM-preserving slot (`paneHosts.ts`, `GroupArea`); command-lifecycle and cwd event bridge (`hooks.ts`).

**MOVES (plugin):** xterm.js instantiation, renderer selection (WebGL/DOM), font/cell-metric handling, IME/OSC-11 wiring, terminal theme palette, terminal-specific settings UI (`createTerminal.ts`, `theme.ts`).

**Generic capability the skeleton must expose (gaps D1–D7, risks E1–E9):**
- `app.terminal.createPane(opts: {cwd?, shell?, initialCommand?}) → paneId` — plugin requests a PTY-backed pane (gap D1).
- Raw IO surface: `onData(paneId, cb)` (pre-render bytes) and `ackTerminal(paneId, bytes)` — custom renderer drives flow control (gaps D3, E3).
- Pane-host ownership for plugins: a container ref or `getHostDiv(paneId)` plus `onTerminalMount/Unmount(paneId)` (gaps D2, capability-map B2).
- Per-pane spawn interception (`onSpawnRequest`) and per-pane settings application (gaps D6, D7).
- Pluggable shell-integration / `setCwd(paneId, path)` fallback for non-OSC shells (gaps D4, E8).
- Window-scoped pane registry keyed by `${windowLabel}:${paneId}` (risk E1).

**Ruling:** extractable. The renderer leaves; the kernel-bound substrate stays.

### Browser → plugin

**STAYS (skeleton):** child-webview lifecycle (`browser_open/close/bounds/visible/navigate/eval/list`), macOS layer inversion + hole-punch + native input monitors, media proxy, view routing, GC infrastructure (`browser.rs`, `mediaproxy.rs`).

**MOVES (plugin):** URL bar, back/forward/reload, bookmarks UI, devtools toggle, the `kind:"browser"` view-type definition and `BrowserView.tsx` chrome.

**Generic capability the skeleton must expose (browser-map gaps D1–D10, risks E1–E10):**
- `app.webview.label(hint) → label` — app-level, Tauri-global-unique label coordination across windows (gap D1, risk E1).
- Generic webview events: `webview.on(label, "nav"|"title"|"open-external"|"status", cb)` replacing hardcoded `browser-*` event names (gap D2, principle A3).
- Generic `ui.overlayActive(label, bool)` and `ui.domHoles(label, holes[])` replacing `browser_overlay_active` (gap D3).
- Generic `native.click.on(label, cb)` and resize subscription, scoped via `emit_to(label, ...)` (gap D4, risk E4).
- Cross-platform `webview.eval(label, js)` and `webview.injectScript(label, {script, phase})` with graceful degradation (gaps D5, D8, risk E5).
- `webview.list(prefix)` for GC parity (risk E6).

**Ruling:** extractable as a thin client over native webview commands. The native webview substrate cannot move; only the chrome and view-type move.

### Files / File Explorer → plugin

**STAYS (skeleton):** `read_text_file`, `file_metadata`, `asset://` streaming, `watch_dir`, the generic content slot, and the generic open-path-as-content routing command. No editor engine, no CodeMirror module authority.

**MOVES (plugin):** the file-type strategy switch (code/markdown/image/pdf/video/audio), the file-viewer chrome, the `kind:"file"` view-type, and any file-tree explorer UI (`FileViewer.tsx`).

**Generic capability the skeleton must expose (hosting-map D3, capability-map editor gaps):**
- `registerFileViewer(priority, strategies)` or plugin-view contribution for custom file types, so the concrete viewer is replaceable (hosting-map D3 verdict).
- `file.activated` event / `onActiveFileChange(cb)` (capability-map gap).
- Engine-specific surfaces removed from the skeleton (A13): `api.editor.modules`, `registerExtension` (CodeMirror `Extension`), and `registerLanguage` move to the editor plugin's own extension API. `registerFormatter` (text→text) is engine-neutral; its placement (skeleton vs editor plugin) is settled in the editor stage.

**Ruling:** the explorer and the file-viewing experience extract; file IO stays. The editor module substrate does not stay — it moves with the editor plugin (see Editor below).

### Editor → plugin

**STAYS (skeleton):** file IO (`read_text_file`, `write_text_file`, `file_metadata`, `asset://`, `watch_dir`), the generic content slot, the generic open-path-as-content routing command, and cross-window state consistency via `app.data.watch` (the Rust singleton broadcast). No editor engine.

**MOVES (plugin):** the CodeMirror 6 instance, per-view tab/undo authority, the code/text file viewer, the editor extension/language API, and the `@codemirror/*` bundle. The editor plugin owns its engine and may be replaced by a Monaco-based (or other) editor plugin with no skeleton change.

**Generic capability the skeleton must expose:** generic open-path-as-content routing to `registerFileViewer`; `file.activated` event; cross-window file-state consistency (existing `app.data.watch`). Engine-specific surfaces (`api.editor.modules`, `registerExtension`, `registerLanguage`) are removed from the skeleton (A13).

**Ruling:** extractable in v1. Multi-window file-state consistency is achieved through the existing cross-window data broadcast, not a skeleton-owned editor. The editor is a plugin like the others; formatter and language plugins depend on it, not on the skeleton.

---

## 6. Conformance

Separation and combination are tested, not claimed.

### Separation test (A8 — removable)
- **Grep gate:** searching the skeleton for hardcoded references to concrete subsystems (an xterm import in `GroupArea`, a `browser-nav` literal outside the migration shim, a `view.kind === "file"` strategy switch carrying renderer logic) must return **zero** matches outside the declared generic substrate. A nonzero count is a failing test.
- **Disable-and-survive:** disable each plugin via `plugin.disable`; the skeleton and unrelated plugins remain fully functional with no orphaned PTYs, webviews, or registered commands.

### Combination test (A9 — zero-core-change to add)
- Adding a plugin produces **zero diff** in skeleton source. The plugin attaches only through the four seams (Section 3). Any required skeleton edit fails the test and signals a missing generic capability (Section 5).

### Build and registry gate
- `make verify` is green: manifest validation (`spec.ts`), command-registry consistency (`catalogJson()`), and dependency-graph resolution pass.
- Every command is reachable from the registry; no command exists outside it.

### CLI / E2E self-check
- Every plugin capability is exercised through the command surface via the socket E2E harness (`SOKSAK_SOCKET`): drive the real app, run the command, read the result, prove RED→GREEN. "No feature to test it" is not an excuse — use the generic surface (`data.*`, `secret.*`, `ui.tree`/`ui.input.click`) with symmetric open env for isolation.

### Visual verify (UI)
- UI conformance is not satisfied by headless DOM assertions. Capture with `window.snapshot`, read the PNG, confirm the view inherits host theme variables (A10) and renders without native-layer bleed-through, then iterate until correct.

---

Version: 1.0.0
Status: AUTHORITATIVE
Single source of truth: `src/plugins/spec.ts`, `src/commands/registry.ts`
This document adds only the advice those schemas cannot enforce.
