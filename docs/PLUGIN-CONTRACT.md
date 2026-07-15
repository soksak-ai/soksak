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

## 2.5 The manifest validation gate

The Doctor checks the *contract* (theme/permissions/naming). The *manifest schema* — every field of
`plugin.json` — is validated by `@soksak-ai/plugin-spec`, the same `parseManifest` the core runs. One
authority, **enforced only at boundaries the core owns** — independent of the plugin's build setup:

- **Runtime** (install/load) — the core runs `parseManifest`; a malformed manifest is rejected.
  Absolute, unbypassable.
- **Evidence** (release/registry) — plugin-kind conformance binds the parsed `plugin.json` to
  the exact owner release; a registry indexes only that report and owner-manifest digest.

An author runs the exact GitHub Release-pinned tool before publishing —
`soksak-validate plugin plugin.json`. The package is not fetched from npm.

## 2.6 The dependency graph gate

Section 2.5 validates one manifest. Installation is a **release graph**. The owner
`soksak-spec-release@0.0.1` manifest is the only install closure and may depend on plugin, sidecar, or
kit units. `plugin.json.dependencies` is not a locator: it is the runtime plugin
relationship/authorization surface. Plugin-kind conformance requires its `(id, range)` set to equal
the release manifest's `kind:"plugin"` set; the release may additionally contain sidecar and kit
closure.

Every edge resolves only inside the certified registry that supplied its parent. The resolver picks
the greatest satisfying strict SemVer entry. Missing targets, incompatible ranges, cycles, rollback,
or equivocation fail loudly. It never retries another registry, a package registry, a branch, or an
implicit source, and never drops a node to make the graph appear valid. Contract-addressed coupling
(`implements`/`viewContract`/`consumes`, §3) remains preferable to a runtime id pin.

## 3. Conformance: declared ≡ actual

Section 1 publishes the contract; section 2 checks one plugin's *declarations* against it. A
declaration is worthless if the runtime wiring diverges from it. The law is bidirectional and covers
every code-bound contribution kind — commands, views, fileViewers, overlays, iconSets — plus DOM
nodes and external libraries:

- **Undeclared actual → reject.** After importing a bundle in its opaque sandbox, the host compares
  static `commands/views/fileViewers/overlays/iconSets` keys with the manifest. An extra key is rejected;
  there is no imperative registration path.
- **Declared, not actual → reject.** A missing static handler/provider is rejected by the same inventory
  comparison; a declared `nodes[]` id absent from the sandbox DOM snapshot is reported by the node scan.
  The core does not silently accept a half-wired plugin.
- **Host-declarative chrome stays declarative.** `headerActions` and `statusItems` carry an exact reference
  to a command declared by the same plugin. The host renders them and executes that command on click;
  the plugin supplies no callback/provider and may only update the state of an already declared id.
- **Reach is for external state only.** A divergence in commands/views/nodes is an author bug — the
  core detects and rejects it, it does not "fix" it. Only `libraries` (external tools, which are
  system state) reconcile toward the declaration.
- **`implements` is checked as a declaration, never as a capability.** A manifest-level
  `implements: [{"id":"soksak-spec-<kind>-<domain>","version":"0.0.1"}]` entry
  (coupling law C3, the L2 contract-pin) declares which
  contracts this plugin implements. The core checks only that the declaration itself holds — shape
  (exact provider objects), contract-id/SemVer grammar (NAMING §8), duplicate base ids. What surfaces a contract *requires*
  is the contract owner's law; the core knows no contract (C1) and never verifies it. Consumers
  resolve implementers by contract id (`sok plugin.implementers`) — discovery is contract-addressed
  and implementation-blind. Do not pin a plugin id for a new coupling (that is L1, banned).
- **`consumes` is the caller side of the same pin.** A manifest-level
  `consumes: [{"id":"soksak-spec-<kind>-<domain>","range":"0.0.1"}]`
  entry declares which contracts this plugin calls. The core's
  cross-plugin call boundary admits `plugin.<targetId>.<cmd>` when the caller declares the contract
  and the target declares a provider version satisfying the range — so a consumer names the contract, never an
  implementation, and a second implementer needs no manifest edit anywhere. Without this axis the
  boundary honoured only `dependencies` (an implementation id), which made discovery decorative: a
  plugin could find implementers by contract and still be denied the call. The boundary is
  unchanged — an undeclared cross-plugin call is still refused; what it reads changed, from a name
  to a contract. `dependencies` remains the L1 name-pin: transitional couplings only, banned for new
  ones.

### One judge, many callers

The transparency judgment (C2 — command/status/DOM) is defined **once**, in the public
`soksak-spec` source (`packages/plugin-spec/src/transparency.ts`): a pure function over the manifest plus optional
runtime evidence. Absent evidence means *not judged* — never zero. Every boundary consumes that
one function: `soksak-validate` at authoring, the registry doctor at publish, the
`c2-transparency-scan` gate over a plugin base, the activation boundary in the app, and
`sok plugin.conformance` at runtime. **Never write judgment logic anywhere else.** A second
implementation of any conformance rule — a scan that re-derives violations, a mirror kept equal
by a pin test — is itself a violation of this contract. If a new boundary needs the verdict, it
imports the function. Enforcement *modes* (`warn`/`blocking`) live beside their enforcement
point. A mode change requires a versioned contract change and matching conformance tests; the
judgment never depends on the mode.

### Enforcement population — measurement population = enforcement population

A C2 rule promoted to `blocking` refuses activation (loader) and enrollment (deploy gate). The
promotion ratchet — a rule ships `warn`, then promotes to `blocking` only after the population it
governs reaches **0 violations** — must measure the *deployed* population, because that is the
population the gate enforces. Distribution is through GitHub: `~/.soksak-dev/plugins` is a
developer's working copy that may run ahead of or behind the published catalog, so
`c2-transparency-scan --plugins <dir>` (in `make gates`) is a **dev pre-check only, never the
promotion authority**. The authority is `c2-transparency-scan --registry` (`make gates-registry`),
which measures the signed registry's owner-release/conformance closure. Promotion is forbidden
until that exact population reports zero violations; a local development scan cannot authorize it.

### Two enforcement surfaces — do not conflate them

| Surface | What | Where | Needs app |
|---------|------|-------|-----------|
| Schema gate | `parseManifest` rejects a malformed manifest | GitHub Release-pinned `@soksak-ai/plugin-spec` — `soksak-validate plugin plugin.json` | No (headless) |
| Runtime conformance | manifest ≡ static module inventory (commands/views/fileViewers/overlays/iconSets) + sandbox DOM nodes | `sok plugin.conformance` | Yes (running app) |
| `consumes` (C3 L2, caller) | declaration checks only — shape, contract-id grammar, duplicates. The call boundary reads it at execute time: a call passes when the caller consumes a contract the target implements | `soksak-validate` (reject) · core call gate (`PERMISSION_DENIED` on an undeclared cross-plugin call) · `sok plugin.implementers` (discovery) | Both |
| `implements` (C3 L2) | declaration checks only — shape, contract-id grammar, duplicates. Schema gate rejects; the activation boundary re-judges at warn (`C3_ENFORCEMENT` — promotion to blocking requires a versioned contract change and matching conformance tests) | `soksak-validate` (reject) · activation warn · `sok plugin.conformance` (implements block) · `sok plugin.implementers` (discovery) | Both |

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
the contract data lives once (in the core). This legacy Doctor mirror is not the registry model:
a v1 registry never vendors unit truth and carries only signed integrity references. The Doctor vendors a copy of
`contract.json`, so it can drift from the core — `contract-sync-scan` (`make gates-registry`)
gates it: the published Doctor contract must equal the core's, and a divergence (a permission the
core added or removed) fails loudly. A vendored copy without a drift gate is how the `service`
permission went missing in 2026-07.

## 5. Sidecar standard — two models

A **sidecar** is a shared binary consumed by plugins. Sidecars are not plugins: they carry no
plugin manifest and no plugin lifecycle. Two models exist (taxonomy and the engine ABI are
owned by docs/SIDECARS.md):

- **service**: a native executable a plugin spawns as a
  subprocess (LLM runners, media pipelines) — no manifest, no permissions, stdio contract.
- **engine**: an in-process dylib that renders into pane surfaces, loaded by the core's
  generic hosting primitive at plugin request. It self-describes via exported C symbols
  (the binary is the single truth — no sidecar.json), and the consuming plugin declares it
  in its manifest (`sidecars[]` + the `"sidecar"` permission), verified at load
  (declared ≡ actual). See docs/SIDECARS.md §3–§7.

A **plugin service** is a resident service-model process whose manifest-declared commands
the core routes natively; `entry: null` is lawful. Its contract is owned by
docs/PLUGIN-SERVICE.md. The rest of this section defines the
plugin-driven **service** model:

Layout rule — one directory per artifact, names always derived the same way:

- Plugin: `~/.soksak/plugins/soksak-plugin-{name}/`
- Sidecar: `~/.soksak/sidecars/soksak-sidecar-{name}/`

Consumption contract (what a plugin may reference — nothing else):

- Entry point: `<identity home>/sidecars/soksak-sidecar-{name}/dist/soksak-sidecar-{name}`
  (single binary) or `dist/soksak-sidecar-{name}.app` (bundle). Plugins never assemble this
  path: spawn with cmd `sidecar:{name}` and the core resolves it from the identity home
  (symmetric with the engine model's core-owned resolution in `sidecar.rs`).
- Directory name = binary name = crate/package name = `soksak-sidecar-{name}`.
- There is no ambient env binary override — the identity home's `sidecars/` directory is
  the only resolution path (A17); dev stages a fresh build into its own home via `stage.sh`.
- Bundled resources the sidecar reads (prompt references, canonical workflow docs, …) live
  under the sidecar directory next to `dist/`; the binary resolves them relative to its own
  location, never relative to the consuming plugin.

Source location is free (an independent repo is the norm, matching the plugin rule); the build
is responsible for placing the entry point under `dist/`. Dev environments may satisfy `dist/`
with symlinks into a build tree. Build debris (logs, scratch output) must not live in the
sidecar directory.

Sidecars expose **no external command surface**. The argv/stdin interface is a private
contract between the sidecar and its consuming plugin — never place sidecar binaries on PATH,
never document them as user-facing CLIs, and never mirror them as internal commands of the
`sok` CLI. Human and AI control goes through the consuming plugin's registry commands
(surfaced automatically via `sok`/MCP); the command registry is the single control surface.
Direct-invocation harnesses are unit-level development aids only — completion-grade
verification must go through the plugin's registry commands so the real path (spawn, IPC,
stdin EOF, secret env, consent gating) is exercised.
