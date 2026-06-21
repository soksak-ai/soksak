# Plugin Contract & Integrity Gate

How soksak keeps the plugin ecosystem consistent: the **core** owns the contract, the **Doctor**
enforces it. No rule is copy-pasted per plugin — there is one source.

## 1. The core is the integrity authority

The contract is the set of things a plugin may rely on from the skeleton. Its single source is the
core code, and the core publishes it as machine-readable data:

| Contract | Source of truth (core) | Published as |
|----------|------------------------|--------------|
| Theme CSS variables | `src/theme/engine.ts` `COLOR_SLOTS` + `src/App.css` statics | `contract.json` `themeVars` |
| Host theme vocabulary | `src/plugins/themeContract.ts` `HOST_THEME_VOCAB` | `contract.json` `themeVocab` |
| Permissions | `src/plugins/spec.ts` `PERMISSIONS` | `contract.json` `permissions` |
| Naming pattern | `src/plugins/contract.gen.test.ts` `ID_PATTERN` | `contract.json` `idPattern` |
| Spec version | `src/plugins/spec.ts` `SPEC_VERSION` | `contract.json` `specVersion` |

`src/plugins/contract.json` is **generated**, not hand-written: `GEN=1 vitest run contract.gen.test`
rewrites it from the live core; the same test fails (pin) if the committed file drifts from the core.
When a capability moves out of the core (e.g. the editor → a plugin), removing its permission from
`PERMISSIONS` automatically removes it from the contract, and every consumer is re-checked.

### Core self-checks (run in `make verify`)

- `permissionBacking.test.ts` — every declared permission must gate a real `app.*` surface in
  `api.ts`, or be an explicit non-API-gated permission. A permission with no backing (a *dead*
  permission left after a capability moved to a plugin) fails this test.
- `themeContract.test.ts` — every emitted `COLOR_SLOT` must be in the published contract; the
  ghost-variable detector is unit-tested here.
- `contract.gen.test.ts` — `contract.json` matches the live core (no drift).

## 2. The Doctor enforces it per plugin

`soksak-plugin-doctor` (github:soksak-ai/soksak-plugin-doctor) checks one plugin against the
published `contract.json`. Plugins wire it so release is gated:

```json
{ "scripts": { "doctor": "soksak-plugin-doctor", "prepublishOnly": "npm run doctor" },
  "devDependencies": { "soksak-plugin-doctor": "github:soksak-ai/soksak-plugin-doctor" } }
```

Rules:

- **naming** — `id` matches `idPattern` (lowercase kebab, `soksak-plugin-` prefix) and equals the
  directory name.
- **permission** — every declared permission exists in the contract. Catches a permission the core
  removed (e.g. `editor` after the editor became a plugin).
- **theme** — the bundle references only theme variables the core emits. A reference to a host-token
  name the core does not provide — `--text`, `--surface`, `--accent`, `--bg2`, `--hover` — is a
  *ghost*: it silently falls back to a hardcoded colour and the core theme is not applied. Detection
  is precise: only names in the host theme vocabulary are flagged; library/private variables
  (`--radix-*`, `--color-blue-500`, `--gap`, anything the bundle defines itself with `--x:`) are
  ignored.

A non-zero exit blocks publish. A plugin that mis-declares anything errors — it is not audited by
hand.

## 3. Conformance: declared ≡ actual

Section 1 publishes the contract; section 2 checks one plugin's *declarations* against it. A
declaration is worthless if the runtime wiring diverges from it. The law is bidirectional and covers
every contribution kind — commands, views, fileViewers, iconSets, nodes, libraries:

- **Undeclared actual → reject.** Binding a command/view/viewer/iconSet the manifest does not declare
  throws at register time (`gateContribution`). Do not bind what you did not declare.
- **Declared, not actual → detect.** A contribution declared but never registered is surfaced after
  activate (inventory diff); a declared `nodes[]` id with no `data-node` in the DOM is surfaced by the
  node scan. The core does not silently accept a half-wired plugin.
- **Reach is for external state only.** A divergence in commands/views/nodes is an author bug — the
  core detects and rejects it, it does not "fix" it. Only `libraries` (external tools, which are
  system state) reconcile toward the declaration.

### Two enforcement surfaces — do not conflate them

| Surface | What | Where | Needs app |
|---------|------|-------|-----------|
| Schema gate | `parseManifest` rejects a malformed manifest | `@soksak-ai/plugin-spec` — `npx soksak-validate plugin.json` | No (headless) |
| Runtime conformance | declared ≡ actual diff across every register-gated kind (commands/views/fileViewers/iconSets) + nodes | `sok plugin.conformance` | Yes (running app) |

`@soksak-ai/plugin-spec` ships the **same** `parseManifest` the core imports — one spec, no vendored
copy. The schema gate runs headless (CI, pre-commit); the wiring diff needs a live app because
`actual` is a runtime fact (`ui.tree`, `catalogJson`, `observe`). Do not claim the schema gate proves
wiring — it proves shape only.

### External runtime dependencies are one conformance kind (4-tuple)

A `libraries[]` entry is `identity (name·bin) + observe + accept + reach`. `actual` is observed by
**running** the tool, not by checking PATH:

- `observe.probe` runs the bin (exit 0 = working); `observe.versionRe` extracts the version.
- `accept.minVersion` is the predicate — presence is not acceptance.
- `reach` converges a non-accepting tool: `vendor` (bundled bytes + sha256), `fetch` (download +
  per-platform sha256), or `command` (install line). `vendor`/`fetch` pin sha256 — a mismatch does
  not write the target, it fails.

Five health states classify the observation — `ABSENT`, `PARTIAL` (install trace, bin not linked),
`BROKEN` (dangling link or probe failure), `VERSION_MISMATCH`, `HEALTHY`. Only `HEALTHY` is accepted;
`PARTIAL`/`BROKEN` are cleaned then reached. Reconcile is idempotent — an already-`HEALTHY` tool is a
no-op. "Presence == working" is killed deliberately.

## 4. Why this shape

Plugins are independent repos and must not import core source (skeleton rule M7). So the core
publishes contract **data** (`contract.json`), and the Doctor — a shared package every plugin
depends on — consumes it. The detector logic lives once (in the core and mirrored in the Doctor);
the contract data lives once (in the core). This is the same published-cache model the plugin
registry uses (`registry.json` → `registrySnapshot.json`).
