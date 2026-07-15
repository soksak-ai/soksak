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
1a. **Plugin-local UI contribution id** = flat lowercase kebab,
   `^[a-z0-9][a-z0-9-]*$`. This covers views, file viewers, icon sets, overlays,
   header actions, status items, and exposed DOM node kinds. The plugin id and
   contribution kind already provide the outer namespace, so dots, slashes, callback
   names, and a repeated plugin domain are not local ids. Runtime module map keys must
   exactly equal these manifest ids; normalization never repairs an off-law id.
2. **Tauri invoke command** = `<capability>_<verb>` (snake_case), same stem as the registry.
   Invoke is internal transport — renames are safe; the only public surface is the registry.
3. **Core Rust file** = one file per capability, filename = capability = command prefix.
   Example: `webview.rs` implements `webview_*`.
3a. **Core companion binary** = a separately-shipped executable that IS the core, not a
   plugin, sidecar, or kit. It is the lifetime-separated implementation of a *core*
   capability — split out of the main binary only because its lifetime differs, never
   because it is a distinct feature. Two exist:
   - `sok` — the command registry's standalone CLI transport (a busybox binary, A17). Its
     lifetime is the invoking shell's, separate from the app's; it surfaces the same
     registry the app exposes.
   - `soksak-ptyd` — the PTY capability's survival daemon (`soksak-` + capability + `d`).
     Its lifetime outlives the app so shells survive an app exit; it is staged into the
     identity home's `bin/`.
   These are NOT sidecars (rule 5). A sidecar serves a *plugin* over a private protocol the
   core never reads and is never in the `sok` registry; a core companion binary serves the
   *core* — its capability is a normal registry command (`term.*`/`pty_*` behind `ptyd`;
   the whole registry behind `sok`) and it consumes no plugin contract. They therefore sit
   outside the distributable-unit grammar (§1.4a, `soksak-<kind>-<domain>`): the kind axis
   names a plugin/sidecar/kit consumer, and these have none — they are the core wearing a
   second process. Naming: `sok` is the one deliberate bare name (the CLI, brand-adjacent);
   a daemon is `soksak-<capability>d`, never `soksak-sidecar-…` (a sidecar shape would
   falsely promise a plugin contract that does not exist).
4. **Plugin** = `soksak-plugin-<domain>-<name>`. A replaceable-seam plugin MUST carry the
   observable engine name (`browser-native` is the exception naming the provisioning axis —
   see §3; `browser-chromium`, `editor-codemirror`).
4a. **Repository unit** (generalization of rule 4) = `soksak-<kind>-<domain>[-<name>]`,
   kind ∈ {plugin, sidecar, kit, contract}. The kind ALWAYS follows the brand prefix — a
   domain-first variant (`soksak-browser-kit`, `soksak-terminal-contract`) is banned; it was
   minted once by following generic npm suffix convention instead of this grammar and renamed
   (§4). The kind states what the repository IS, and a repository that ships nothing at
   runtime must never wear a shipping kind: `soksak-sidecar-…` on a test-and-text repository
   reads as a sidecar to anyone scanning the registrar, whatever the tokens were meant to
   convey. The `<name>` segment:
   - plugin/sidecar: required on a replaceable seam and MUST carry the observable
     engine/implementation name (rule 4); a unit that alone constitutes its domain may
     omit it (`soksak-sidecar-workflow`).
   - kit: ALWAYS required and names the PART of the domain the library provides
     (`common`, …). A bare-domain kit name is banned — a kit serves a domain's plugin
     family, it never IS the domain. The name must cover the whole content: naming a
     kit after one module inside it (`-ui` for a package that also ships lifecycle and
     input forwarding) is the same defect as a stale label — the unnamed majority ends
     up living outside its name.
   - contract: a bare domain (`soksak-contract-terminal`) — the contract IS the domain's
     standard, so it takes no `<name>`. It holds the contract text, the acceptance suite that
     decides conformance, and the domain's benchmarks; it ships no binary, enters no registry,
     and is consumed only as a build-time dev-dependency by the units it governs. Nothing
     runtime, nothing installed. The **contract id** it defines is `soksak-spec-<kind>-<domain>`
     (§8) — a sidecar wire contract keeps the sidecar kind (`soksak-spec-sidecar-terminal`),
     an L2 domain contract drops it (`soksak-spec-plugin-git`); either way it is an identifier
     string, not a repository name, and the two differ on purpose.
   - Vocabulary-collision ban: a name token already meaning something else inside this
     project is rejected even when it is the textbook term. Grep before naming. Burned
     tokens (browser kit case): `chrome` (Chrome browser), `shell` (terminal shell —
     sessions `shell` field), `skeleton` (template plugin + platform-skeleton strategy
     doc), `frame` (paint frames + NSView frame).
   - Metaphor ban: do not escape a vocabulary collision by reaching for a figurative
     token (`chassis` was minted and rejected as forced). Prefer the plain role word —
     `common` for a domain family's shared part reads naturally to any developer.
   Registrar folder = `~/.soksak-dev/<kind>s/<full-name>` (plugins/, sidecars/, kits/,
   contracts/).
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
| `soksak-engine-chromium@1` → `soksak-sidecar-browser@1` (both rejected) | `soksak-spec-sidecar-browser` | contract id — §8 (sidecar wire) |
| `sheet.*` registry family (activate/close/create/list/rename/switchScan), `tab/sheet/<n>` node addresses, `msg.sheet.*`/`cmd.sheet.*` keys, plugin event payload `activeSheetId`, UI word "시트" | `space.*`, `tab/space/<n>`, `msg.space.*`/`cmd.space.*`, `activeSpaceId`, "스페이스" | concept — a project's content tab is a Space (Studio rejected); `c*` ids and snapshot keys unchanged |
| `sessions.renameTab` | `sessions.renameProject` | internal — it renames a ProjectTab; "tab" meant a different thing on every layer |
| `soksak-browser-kit` | `soksak-kit-browser-common` | kit — unified with the unit grammar (§1.4a: kind-first + part name; intermediates burned: `-shell` terminal-shell collision, `-chassis` forced metaphor); registrar moved `~/ai/cli/` → `~/.soksak-dev/kits/` |
| `soksak-plugin-terminal` (id + program `terminal`) | `soksak-plugin-terminal-xterm` (program `terminal-xterm`) | plugin — the terminal domain is an engine seam (§1.4a `<name>` = engine), so the incumbent must carry its engine to coexist with `soksak-plugin-terminal-ghostty`. A destructive id rename orphans the old data ns (data ns = pluginId) — the manifest declares `renamedFrom: "soksak-plugin-terminal"` and the loader migrates the ns once |

`webview_inject_script` already conformed and is unchanged.

### 2026-07 terminal/engine domain

Symmetric to the browser/engine precedent above. The `ghostty` terminal plugin
turned `terminal` into a replaceable seam, so rule 4 now forces the observable
engine name on the incumbent — `terminal` alone no longer says which engine.

| Before | After | Kind |
|---|---|---|
| `soksak-plugin-terminal` | `soksak-plugin-terminal-xterm` | plugin — rule 4 (engine name on a replaceable seam) |
| program `terminal` | program `terminal-xterm` | program id |
| (none — new seam contract) | `soksak-spec-plugin-terminal` | contract id — §8 |

The plugin-id rename moves its registrar folder in lockstep
(`~/.soksak-dev/plugins/soksak-plugin-terminal-xterm`, dir = id, §1.4a).

`soksak-spec-plugin-terminal` is the terminal domain's view contract — a view that provides a
`content` surface and supports `app.pty` PTY round-trip and `command` autorun.
Consumers reference the contract, never a plugin id; the core resolves it to an
implementer, so the core names no engine and a new engine joins by declaring
`implements`, not by a core edit. The scope is the bare domain `terminal` (not
`soksak-plugin-soksak-spec-plugin-terminal`): the id appears in core source as a program's
`viewContract`, and §8/PS6 bars a core-source contract id from matching the
plugin-id grammar.

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

A runtime contract id is therefore derived, never invented, and never version-shaped:
**`soksak-spec-<kind>-<domain>`**. The `soksak-spec-` prefix always comes
first; `<kind>` is one of `sidecar`, `plugin`, or `service`, and `<domain>` names
what the contract governs. Plugin and sidecar runtime contracts always carry a
domain. The common service wire is the only domain-elided runtime form:
`soksak-spec-service`. The regex enforces the kind
vocabulary (`CONTRACT_ID_RE`, packages/plugin-spec/src/contracts.ts): an arbitrary
token (say `fixture`) is not a kind and is rejected. Adding a kind requires a new
schema version and matching conformance fixtures. A contract id is an identifier string, never
a repository name: the repository that carries a contract's text and its acceptance
suite is a `contract`-kind unit named after the domain it standardizes
(`soksak-contract-terminal`, §4a). So two layers nest — `soksak-contract-<domain>`
(the repo that owns the spec, its golden, its bench) ⊃ `soksak-spec-<…>` (the
contract's id string and its spec-as-code crate). `contract` is the owning home;
`spec` is the contract's name and code. **The kind names what the contract
standardizes, not who implements it:**

- A **sidecar wire contract** — the handshake between a plugin's JS and a
  specific sidecar dylib (`sidecars[].interface`) — carries kind `sidecar`:
  `soksak-spec-sidecar-<domain>` (`soksak-spec-sidecar-terminal`). This
  is the contract of one sidecar shape, not a domain-wide standard.
- An **L2 domain contract** — the domain standard a conforming implementation
  declares through `implements`/`consumes` — carries kind `plugin` (every domain
  L2 is implemented by a plugin): `soksak-spec-plugin-<domain>`
  (`soksak-spec-plugin-git`, `soksak-spec-plugin-browser`,
  `soksak-spec-plugin-narration`, the terminal seam `soksak-spec-plugin-terminal`).
  A domain can hold both at once: browser has a sidecar wire
  (`soksak-spec-sidecar-browser`, chromium's dylib handshake) and a domain L2
  (`soksak-spec-plugin-browser`); the kind segment keeps them distinct.

Platform document schema ids are a separate closed vocabulary:
`soksak-spec-release@0.0.1`, `soksak-spec-registry@0.0.1`,
`soksak-spec-conformance@0.0.1`, `soksak-spec-plugin@0.0.1`,
`soksak-spec-sidecar@0.0.1`, and `soksak-spec-kit@0.0.1`. In particular, the bare plugin
and sidecar forms are kind schemas, not runtime declaration contracts, and
`CONTRACT_ID_RE` rejects them. `soksak-spec-service` is different: it is the
enacted common service wire and therefore remains a runtime contract. The domain
names the domain, never the
implementation (a protocol-compatible replacement engine must not self-report
someone else's name) and never the model (models are machine-encoded, banned from
names — SIDECARS.md §1). Its sole job is the version handshake between
independently-shipped artifacts. Version and compatibility are separate fields:
providers and conformance evidence declare `{id, version}` exactly, while consumers declare
`{id, range}`. Discovery compares ids and evaluates the SemVer range; it never compares a
concatenated `name@version` string. A runtime contract reference appears in exactly six
declared surfaces. The first five enact runtime relationships:
the sidecar handshake (`sidecars[].interface` — plugin JS ↔ engine dylib), the
plugin manifest's `implements` declaration (`implements:
[{"id":"soksak-spec-<kind>-<domain>","version":"0.0.1"}]` — the L2 contract-pin PROVIDER side, C3: a
plugin declares the contracts it implements, and discovery is contract-addressed
and implementation-blind), the plugin service declaration (`service.interface` —
the resident-process wire the core frames, docs/PLUGIN-SERVICE.md PS5/PS6), a
program's `viewContract` (`contributes.programs[].viewContract:
{"id":"soksak-spec-<kind>-<domain>","range":"0.0.1"}` — the L2 contract-pin CONSUMER side, the
counterpart to `implements`: a program targets a contract-view instead of a plugin
id (`viewPlugin`), and the core resolves the contract to a user-selected active
implementer, so the core names no engine and a new engine joins by declaring
`implements`, not by a core edit — the terminal seam `soksak-spec-plugin-terminal`,
§4), and the plugin manifest's `consumes` declaration (`consumes:
[{"id":"soksak-spec-<kind>-<domain>","range":"0.0.1"}]` — the L2 contract-pin CALL side: the core's
cross-plugin call boundary admits a call when the caller declares the contract and
the target declares `implements` for it, so a consumer names the contract instead of
the implementer and a second implementer needs no manifest edit anywhere). Discovery and
authorization use the same declaration: `plugin.implementers` finds matching providers,
while the call boundary requires the caller's matching `consumes` entry. The sixth surface is
non-runtime evidence: `soksak-spec-conformance@0.0.1.contract`, referenced by a signed
registry `reports[]` integrity entry. It states which enacted platform schema or
runtime contract was tested; it grants no dependency, discovery, command, or call
permission. Because every contract id begins
with `soksak-spec-`, a contract id in core source never matches the plugin-id
grammar the C1 scan sanctions (`soksak-plugin-<name>`), so the terminal seam id
lives in core source (`soksak-spec-plugin-terminal`, terminalEngine.ts) without a
C1 exception. Outside the five runtime surfaces and the evidence surface it appears
nowhere else. A major bump changes the provider's exact `version`; consumers whose declared
range excludes that major do not match. It does not mutate the base id. Revising this section's surface
list or kind vocabulary changes the contract schema and requires a new schema version with
matching conformance fixtures.

**Wire-contract crates.** The Rust single-truth for a wire contract (version
constants + serde types, no transport code) is a crate named `soksak-spec-<domain>`:
`soksak-spec-socket` (the app↔client socket protocol), `soksak-spec-pty` (app↔ptyd),
`soksak-spec-service` (app↔service binary). The crate carries no `@major` — a Cargo
package name and contract base id may coincide because the declaration shape, not punctuation,
distinguishes ownership from compatibility (`{id, version}` / `{id, range}`). These crates are
the spec written as Rust types, not an implementation, so
`spec` is the required suffix; `proto` and `protocol` are not valid crate suffixes.
