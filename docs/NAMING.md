# Naming Law (v1)

Binding rules for every identifier this project mints: registry commands, Tauri invoke
commands, core Rust files, plugins, sidecars, env vars, and terminology. The law was not
invented — it codifies the majority practice already in the codebase (secret/data/schedule/
git/clipboard/ai.session) and removes the violators.

## 1. The Law

1. **Registry command (public AI surface)** = `<capability>.<verb>` (dot-separated).
   `<capability>` names the *role*, never an implementation or engine. The registry name
   is canonical; the invoke stem follows it. A plugin command's first segment MUST NOT
   restate the plugin id's domain — neither an exact id-token nor a truncation or extension
   of one (`clip` ⊂ `clipboard`, `folder` ⊂ `folderpop` both stutter;
   an id like `soksak-plugin-agents-issue-create` would forbid `create` — that plugin was renamed to `soksak-plugin-agents-issue` for exactly this reason). A bare name (no dot) is banned
   only on exact id-token match — `playbox`'s `play` is the verb itself and is legal. A dot
   namespace names the OBJECT operated on (`node.*`, `page.*`), never the plugin. Enforced by
   `plugin-spec` (manifest reject) and `plugin-doctor` (R4).
2. **Tauri invoke command** = `<capability>_<verb>` (snake_case), same stem as the registry.
   Invoke is internal transport — renames are safe; the only public surface is the registry.
3. **Core Rust file** = one file per capability, filename = capability = command prefix.
   Example: `webview.rs` implements `webview_*`.
4. **Plugin** = `soksak-plugin-<domain>-<name>`. A replaceable-seam plugin MUST carry the
   observable engine name (`browser-native` is the exception naming the provisioning axis —
   see §3; `browser-chromium`, `editor-codemirror`).
4a. **Distributable unit** (generalization of rule 4) = `soksak-<kind>-<domain>[-<name>]`,
   kind ∈ {plugin, sidecar, kit}. The kind ALWAYS follows the brand prefix — a domain-first
   variant (`soksak-browser-kit`) is banned; it was minted once by following generic npm
   suffix convention instead of this grammar and renamed (§4). The `<name>` segment:
   - plugin/sidecar: required on a replaceable seam and MUST carry the observable
     engine/implementation name (rule 4); a unit that alone constitutes its domain may
     omit it (`soksak-sidecar-workflow`).
   - kit: ALWAYS required and names the PART of the domain the library provides
     (`common`, …). A bare-domain kit name is banned — a kit serves a domain's plugin
     family, it never IS the domain. The name must cover the whole content: naming a
     kit after one module inside it (`-ui` for a package that also ships lifecycle and
     input forwarding) is the same defect as a stale label — the unnamed majority ends
     up living outside its name.
   - Vocabulary-collision ban: a name token already meaning something else inside this
     project is rejected even when it is the textbook term. Grep before naming. Burned
     tokens (browser kit case): `chrome` (Chrome browser), `shell` (terminal shell —
     sessions `shell` field), `skeleton` (template plugin + platform-skeleton strategy
     doc), `frame` (paint frames + NSView frame).
   - Metaphor ban: do not escape a vocabulary collision by reaching for a figurative
     token (`chassis` was minted and rejected as forced). Prefer the plain role word —
     `common` for a domain family's shared part reads naturally to any developer.
   Registrar folder = `~/.soksak-dev/<kind>s/<full-name>` (plugins/, sidecars/, kits/).
   Consumption is declare + discover: the consumer declares the unit NAME only (manifest
   `sidecars[]`, package.json dependencies) and resolution discovers it in the registrar
   (`SOKSAK_HOME` env, default `~/.soksak-dev`). Symlinks and relative-topology paths
   (`../../`) are banned as resolution mechanisms — both break silently on relocation.
4b. **Window identity** = opaque, never-reused. Runtime windows are labeled `w-<uuid4>` —
   an accidental label collision across sessions is impossible, so the ghost-restore class
   (a new window resurrecting a dead session's persisted slot) cannot exist. Intentional
   reuse is respawn only: the boot manifest recreates a window under its original uuid so
   its snapshot key matches. `main` is the single platform-forced constant (the statically
   declared bootstrap window) and the **control plane reserved word**: the bootstrap window
   IS the orchestrator, owns respawn, and carries no workspace; every workspace window is
   `w-<uuid4>`. The `orch-<n>` family is retired with the same finality as `win-<seq>`
   (one-shot migration `scripts/migrations/20260705-main-control-plane.sh` moved the old
   main workspace into a `w-*` slot). No other name carries meaning, and no code may parse
   a role out of a label — roles are metadata. Identifiers never surface in human answers
   (MESSAGE-PROTOCOL: `message` speaks in projects and sentences; labels live in `data`).
   Every window-label pattern MUST be listed in `src-tauri/capabilities/default.json`
   `windows` — a label family missing from the capability is denied `event.listen` and
   every socket command to such a window dies as TIMEOUT with no error at the source.
   Previous-generation labels (`win-<seq>`) no longer exist: a one-shot migration
   (`scripts/migrations/20260704-window-label-uuid.sh`, git-tracked) rewrote old
   manifests to uuid labels, respawn refuses to spawn a non-`w-*` slot (loud error,
   data untouched), and the capability never re-lists the retired family.

5. **Sidecar** = `soksak-sidecar-<domain>[-<engine>]` — the same artifact shape as
   plugins, so a plugin/sidecar pair is visible at a glance
   (`soksak-plugin-browser-chromium` ↔ `soksak-sidecar-browser-chromium`). A replaceable
   seam carries the engine name, exactly as for plugins; a non-seam sidecar carries the
   domain only (`soksak-sidecar-workflow`). Sidecars are never exposed in the command
   registry (`sok`). The sidecar's model (engine/service) is NOT part of the name — it is
   machine-encoded (attachment path, artifact kind, ABI self-report). See docs/SIDECARS.md.
6. **Env var** = `SOKSAK_<area>_<item>`. The area obeys rule 1 (no implementation names).
   Sidecar-owned diagnostics use `SOKSAK_SIDECAR_<NAME>_<item>`.
7. **Terminology**: a name states *what we provide*. The name of something we merely
   consume lives only inside its import boundary (see §2).
8. **Command verbs and targets**: `open` = surface the target, reusing an existing instance
   instead of minting a second one when the domain already has an identity to reuse
   (`project.open`, `window.open`). `create` = mint a new instance unconditionally, no reuse
   check (`space.create`, `plugin.dev.create`). `close` = detach without destroying the
   underlying record. `remove` = destroy the target's own record permanently (`secret.remove`,
   `project.recent.remove`). `list` / `get` / `set` = read-many, read-one, write — no side
   effect beyond the named field. The target parameter names the domain object acted on
   (`project`, `space`, `panel`, `view`, `pane`, `window`) — never a stage-specific or
   implementation synonym (`group`, `content`). Bare `id` is reserved for domains whose own
   identifier field is literally `id`; every other reference is `<domain>Id`
   (`projectId`, `spaceId`, `panelId`).

## 2. Consumed-Library Names (the CEF/Chromium ruling)

> A name states what we provide. The name of what we consume lives inside the import
> boundary only.

Test: did we write it? do we fork and continue developing it? If no, it is a consumed
carrier, and its name (e.g. `cef`) may appear only in the one crate that imports it —
`Cargo.toml` dependency line, `use` statements, and attribution/provenance docs. Everything
we mint — files, commands, env, types, docs terminology, UI — names the observable entity
(the Chromium engine), not the carrier.

- CEF's own framework binary is literally named `Chromium Embedded Framework.framework`:
  the upstream project itself declares the substance to be Chromium and itself the carrier.
  We do not name cargo after the truck.
- This is consistent with the engine-name rule for plugins (`editor-codemirror`):
  CodeMirror *is* the observable engine there, not a carrier.
- Naming ≠ dependency reference. Hiding the dependency would be dishonest; the reference
  (dep line, use, license attribution) is mandatory — as with tokio or objc2.

The name pair for the two browser engines encodes the *provisioning axis*, not just an
engine name: `Webview` = OS-provided (identity varies per OS, cannot pin an engine name)
vs `Chromium` = bundled by us (identical everywhere).

## 3. Why `webview.rs` Belongs in Core

Core-primitive test (both must hold):
(a) only the host process can provide it, and
(b) we bundle no engine code for it.

The OS webview is the substrate of the app itself (the UI already renders inside one);
`webview.rs` adds zero linked engine bytes — it only brokers "attach the OS-owned object as
a child of the window". NSView parenting is possible only for the window-owning process; a
JS plugin physically cannot do it. Symmetric precedents: `pty.rs` (terminal engine xterm is
a plugin; PTY spawn is core), `process.rs` (service binaries are plugin-owned; spawn is
core). Chromium fails (b) — we bundle a ~215MB engine — hence it must live outside core as
an engine sidecar. Same test, both directions.

Do NOT suffix such files with `_hosting`: brokering is the invariant of *every* core
capability module (ARCHITECTURE A13), not a property of one file, and the suffix would
break the symmetry law (file = command prefix: `webview_open`, not `webview_hosting_open`).

## 4. Applied Migrations

### 2026-07 browser/engine domain

| Before | After | Kind |
|---|---|---|
| `src-tauri/src/browser.rs` | `src-tauri/src/webview.rs` | core file |
| `browser_open/_bounds/_navigate/_devtools/_history/_visible/_close/_list/_open_window/_eval/_media_extract/_overlay_active/_dom_holes/_debug_hierarchy` | `webview_*` (same verbs) | invoke |
| `src/lib/browserGc.ts` (+test) | `src/lib/webviewGc.ts` | frontend core file |
| `startBrowserGc` / `collectBrowserLabels` | `startWebviewGc` / `collectWebviewLabels` | exports |
| `browser.cef.*` registry + `cef_browser_*` invoke + `catalogBrowserCef.ts` | **deleted** (engine control is a plugin↔sidecar channel, never a registry concern) | removal |
| `SOKSAK_CEF`, `SOKSAK_CEF_NO_TICK`, `SOKSAK_CEF_FRAMEWORK`, `SOKSAK_CEF_HELPER`, `SOKSAK_CEF_MAIN_BUNDLE` | **deleted** (sidecar derives paths from its own location; diagnostics move to `SOKSAK_SIDECAR_BROWSER_CHROMIUM_*` — {NAME} is the full sidecar name) | env |
| `soksak-plugin-browser-cef` | `soksak-plugin-browser-chromium` | plugin |
| `soksak-sidecar-chromium` (initial publish) | `soksak-sidecar-browser-chromium` | sidecar artifact — unified with the plugin shape |
| `soksak-engine-chromium@1` → `soksak-sidecar-browser@1` (both rejected) | `soksak-sidecar-browser-spec@1` | contract id — §8 |
| `sheet.*` registry family (activate/close/create/list/rename/switchScan), `tab/sheet/<n>` node addresses, `msg.sheet.*`/`cmd.sheet.*` keys, plugin event payload `activeSheetId`, UI word "시트" | `space.*`, `tab/space/<n>`, `msg.space.*`/`cmd.space.*`, `activeSpaceId`, "스페이스" | concept — a project's content tab is a Space (Studio rejected); `c*` ids and snapshot keys unchanged |
| `sessions.renameTab` | `sessions.renameProject` | internal — it renames a ProjectTab; "tab" meant a different thing on every layer |
| `soksak-browser-kit` | `soksak-kit-browser-common` | kit — unified with the unit grammar (§1.4a: kind-first + part name; intermediates burned: `-shell` terminal-shell collision, `-chassis` forced metaphor); registrar moved `~/ai/cli/` → `~/.soksak-dev/kits/` |

`webview_inject_script` already conformed and is unchanged.

### 2026-07 command surface rename

Applied under the verb law of §1.8. Reference for external users and existing plugins
built against the prior surface.

Commands:

| Before | After |
|---|---|
| `content.list` | `sheet.list` |
| `content.create` | `sheet.create` |
| `content.close` | `sheet.close` |
| `content.activate` | `sheet.activate` |
| `content.rename` | `sheet.rename` |
| `content.switchScan` | `sheet.switchScan` |
| `project.create` | `project.open` |
| `project.recent.forget` | `project.recent.remove` |
| `window.new` | `window.open` |
| `plugin.dev.new` | `plugin.dev.create` |
| `secret.delete` | `secret.remove` |

`plugin.reload` keeps its name; it gained an optional `{id?}` parameter (not a rename).

Parameters: `group` → `panel` (`panel.split`, `panel.close`, `panel.focus`, `view.list`,
`view.open`); `content` → `sheet` (`sheet.close`, `sheet.activate`, `sheet.rename`,
`panel.list`). `sheet.switchScan`'s `to`/`from` parameters are unchanged.

Return fields (surface only — internal store fields keep their own names and are converted
at the command-handler boundary): `groupId` → `panelId`, `contentId` → `sheetId`,
`activeGroupId` → `activePanelId`, `activeContentId` → `activeSheetId`, `contents` → `sheets`.

Event: `layout.reflow`'s payload key `activeContentId` → `activeSheetId` (the event name
itself is unchanged).

Address: `ui.tree` node addresses `tab/content/N` and `tab/content/N/close` →
`tab/sheet/N` and `tab/sheet/N/close`. The layout region named `content`
(`win/<label>/content/view/…`, the central area that hosts the active sheet's panel
tree) is a distinct namespace and is unaffected — it names a screen region, not the
sheet concept.

## 5. Normalization Backlog (documented drift — separate pass, do not mix into feature work)

Registry names are public and stay. The mechanical invoke-stem aligns are done
(`network_*`→`net_*`, `data_encryption_*`→`data_encrypt_*`, `secret_set_idle_timeout`→`secret_autolock`,
`plugins_scan`→`plugin_scan`). The rows below need a design decision, not a blind rename:

| Current | Target | Note |
|---|---|---|
| `term.*` ↔ `spawn_terminal`/`*_terminal` (pty.rs) | `term.*` ↔ `pty_*` or `term_*`, file = stem | 3 stems today (term/terminal/pty) |
| `git_status` lives in `fs.rs` | move to `git.rs` | |
| `browserLabel`/`browserLabelPrefix` (webviewLabels.ts) | consider `webviewLabel` | label scheme (`b-` prefix) is persisted — rename needs a compat note |
| `browser_media_extract` → `webview_media_extract` | done mechanically; **primitive purity suspect** (domain smell — playbox) | review whether it decomposes into eval/inject primitives |
| emitted event names `browser-nav`, `browser-title` | `webview-*` | frontend listeners must move in lockstep |

## 6. False-Positive Guard for Rename Tooling

`sourceFromState` and `graceful` contain the substring "ceF/cef". Word-boundary matching is
mandatory for any sweep; `cef_browser_*` (pre-deletion) and CEF API names
(`browser_host_create_browser_sync`, `browser_process_handler`, `browser_subprocess_path`)
belong to the third-party crate and were never rename targets.

## 7. Enforcement Gate

Mechanical check for the §2 ruling: `grep -riE "\bcef\b" src src-tauri/src packages`
must return zero hits. Documented exceptions where the string legitimately lives:
this file (the ruling must name what it bans), the `soksak-ai/soksak-sidecar-browser-chromium` repo
(the importing crate: dep line, `use cef`, attribution README), and third-party
API names inside that crate. Substring false positives (`sourceFromState`,
`graceful`) require word-boundary matching.

## 8. Contract Ids (specs and protocols)

**Self-evidence principle**: a name must reveal its kind and its relationships
without explanation. An artifact-family shape must never be used for a
non-artifact — a contract string shaped like `soksak-sidecar-<x>` reads as a
sidecar that does not exist.

A contract id is therefore derived, never invented: **`<scope>-spec@<major>`** —
the scope it governs plus the mandatory kind marker `-spec`. The archetype is
`soksak-plugin-spec@1` (the contract of soksak plugins). Applied here:
`soksak-sidecar-browser-spec@1` = the contract of browser-domain sidecars, read
directly off the artifact it pairs with (`soksak-sidecar-browser-chromium` minus
the engine, plus `-spec`). The scope names the domain, never the implementation
(a protocol-compatible replacement engine must not self-report someone else's
name) and never the model (models are machine-encoded, banned from names —
SIDECARS.md §1). Its sole job is the version handshake between
independently-shipped artifacts. It appears in exactly three declared surfaces:
the sidecar handshake (`sidecars[].interface` — plugin JS ↔ engine dylib), the
plugin manifest's `implements` declaration (`implements:
["<scope>-spec@<major>"]` — the L2 contract-pin, C3: a plugin declares the
contracts it implements, and discovery is contract-addressed and
implementation-blind), and the plugin service declaration
(`service.interface` — the resident-process wire the core frames,
docs/PLUGIN-SERVICE.md PS5/PS6; this sentence is that re-legislation). A
contract id that appears in core source must never match the plugin-id grammar
the C1 scan sanctions (PS6 — `soksak-service-spec@1`, not
`soksak-plugin-…`). It appears nowhere else. A major bump mints a distinct
id — `<scope>-spec@2` promises nothing about `@1`; revising this section's
surface list is itself re-legislation (C4), never a silent addition.
