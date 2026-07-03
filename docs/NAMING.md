# Naming Law (v1)

Binding rules for every identifier this project mints: registry commands, Tauri invoke
commands, core Rust files, plugins, sidecars, env vars, and terminology. The law was not
invented — it codifies the majority practice already in the codebase (secret/data/schedule/
git/clipboard/ai.session) and removes the violators.

## 1. The Law

1. **Registry command (public AI surface)** = `<capability>.<verb>` (dot-separated).
   `<capability>` names the *role*, never an implementation or engine. The registry name
   is canonical; the invoke stem follows it.
2. **Tauri invoke command** = `<capability>_<verb>` (snake_case), same stem as the registry.
   Invoke is internal transport — renames are safe; the only public surface is the registry.
3. **Core Rust file** = one file per capability, filename = capability = command prefix.
   Example: `webview.rs` implements `webview_*`.
4. **Plugin** = `soksak-plugin-<domain>-<name>`. A replaceable-seam plugin MUST carry the
   observable engine name (`browser-native` is the exception naming the provisioning axis —
   see §3; `browser-chromium`, `editor-codemirror`).
5. **Sidecar** = `soksak-sidecar-<name>`. Sidecars are never exposed in the command
   registry (`sok`). The sidecar's model (engine/service) is NOT part of the name — it is
   machine-encoded (attachment path, artifact kind, ABI self-report). See docs/SIDECARS.md.
6. **Env var** = `SOKSAK_<area>_<item>`. The area obeys rule 1 (no implementation names).
   Sidecar-owned diagnostics use `SOKSAK_SIDECAR_<NAME>_<item>`.
7. **Terminology**: a name states *what we provide*. The name of something we merely
   consume lives only inside its import boundary (see §2).

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
| `SOKSAK_CEF`, `SOKSAK_CEF_NO_TICK`, `SOKSAK_CEF_FRAMEWORK`, `SOKSAK_CEF_HELPER`, `SOKSAK_CEF_MAIN_BUNDLE` | **deleted** (sidecar derives paths from its own location; diagnostics move to `SOKSAK_SIDECAR_CHROMIUM_*`) | env |
| `soksak-plugin-browser-cef` | `soksak-plugin-browser-chromium` | plugin |

`webview_inject_script` already conformed and is unchanged.

## 5. Normalization Backlog (documented drift — separate pass, do not mix into feature work)

Registry names are public and stay; invoke stems and file placement get aligned in a
dedicated pass:

| Current | Target | Note |
|---|---|---|
| `net.udp.*`/`net.http.*` ↔ `network_*` | align stem (`net` vs `network`) | pick one stem |
| `data.encrypt.*` ↔ `data_encryption_*` | align stem | |
| `term.*` ↔ `spawn_terminal`/`*_terminal` (pty.rs) | `term.*` ↔ `pty_*` or `term_*`, file = stem | 3 stems today (term/terminal/pty) |
| `secret.autolock` ↔ `secret_set_idle_timeout` | align verb | |
| `plugins_scan`/`plugin_install_git`/`dev_plugin_paths` | one prefix `plugin_*` | |
| `network_http_request` lives in `http.rs` | move or rename to match file law | |
| `git_status` lives in `fs.rs` | move to `git.rs` | |
| `browserLabel`/`browserLabelPrefix` (webviewLabels.ts) | consider `webviewLabel` | label scheme (`b-` prefix) is persisted — rename needs a compat note |
| `browser_media_extract` → `webview_media_extract` | done mechanically; **primitive purity suspect** (domain smell — playbox) | review whether it decomposes into eval/inject primitives |
| emitted event names `browser-nav`, `browser-title` | `webview-*` | frontend listeners must move in lockstep |

## 6. False-Positive Guard for Rename Tooling

`sourceFromState` and `graceful` contain the substring "ceF/cef". Word-boundary matching is
mandatory for any sweep; `cef_browser_*` (pre-deletion) and CEF API names
(`browser_host_create_browser_sync`, `browser_process_handler`, `browser_subprocess_path`)
belong to the third-party crate and were never rename targets.
