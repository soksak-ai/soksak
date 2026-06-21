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

## 3. Why this shape

Plugins are independent repos and must not import core source (skeleton rule M7). So the core
publishes contract **data** (`contract.json`), and the Doctor — a shared package every plugin
depends on — consumes it. The detector logic lives once (in the core and mirrored in the Doctor);
the contract data lives once (in the core). This is the same published-cache model the plugin
registry uses (`registry.json` → `registrySnapshot.json`).
