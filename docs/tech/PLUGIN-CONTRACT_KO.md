---
kind: canonical
status: active
canonical: PLUGIN-CONTRACT.md
---

# Plugin contract

English canonical: [`PLUGIN-CONTRACT.md`](PLUGIN-CONTRACT.md). Where the two differ, English wins.

What a plugin declares, who owns each definition, and which gate checks it.

## P1. The core owns the contract

The contract is what a plugin may rely on. Its definition is core source, not a document.

| Contract | Source | Key in `contract.json` |
| --- | --- | --- |
| Spec version | `SPEC_VERSION` in `frontend/src/plugins/spec` | `specVersion` |
| Id pattern | `frontend/src/plugins/contract.gen.test.ts` | `idPattern` |
| Permissions | `PERMISSIONS` in `frontend/src/plugins/spec` | `permissions` (27) |
| Theme variables | `COLOR_SLOTS` in `frontend/src/theme/engine.ts` + `App.css` | `themeVars` (31) |
| Host theme vocabulary | `frontend/src/plugins/themeContract.ts` | `themeVocab` |

`frontend/src/plugins/contract.json` is generated, never hand-written. `GEN=1 vitest run
contract.gen.test` rewrites it from the core, and the same test fails when the committed file differs from the core.
Removing a permission from `PERMISSIONS` removes it from the contract, and every consumer is checked again.

**Gate.** `contract.gen.test.ts`(the generated output matches the core), `permissionBacking.test.ts`(every declared
permission gates a real `app.*` surface, so a permission left behind by a moved capability fails here).

## P2. A manifest declares which spec version it was written against

Every manifest opens with this line.

```json
"spec": "soksak-spec-plugin@0.0.1"
```

It is a compatibility claim, not ownership. The core is what parses manifests, and which rules this field
they are parsed by. Measured 2026-08-15: all 46 installed plugins have this field and all 46 pin `0.0.1`.

Why the definition is in the core: the core is the only parser. A separate package is for when there are two parsers — a third-party validator or
a Go sidecar reading manifests — and there is none now. The plugin folder holds only the declaration, never the definition.

## P3. Required and optional keys of a manifest

Measured across the 46 installed.

All 46: `spec`, `id`, `name`, `version`, `description`, `entry`, `permissions`.

Optional (count that uses it): `contributes` 43, `consumes` 20, `implements` 12, `configuration` 9,
`sidecars` 7, `dependencies` 3, `service` 2, `libraries` 2.

`name` and `description` are not strings but `{ ko, en }` objects.

## P4. Contribution axes

What a plugin contributes, and how many of the 46 use each: `commands` 81, `ui` 32, `nodes` 28,
`programs` 27, `views` 26, `data` 24, `process` 13, `terminal` 10, `sidecar` 6, `skill` 5,
`notify` 4, `network` 4.

These are the four attachment seams of `ARCHITECTURE.md` in manifest form — a program declares a
`kind` the skeleton routes to, a view a slot, a command a name registered once and available through every transport, a permission
declares a capability gate.

## P5. A contract is declared by the plugin that implements it

`implements` and `consumes` name a contract id. The implementing plugin owns the definition, and a consumer
pins `id@range`. Contract ids start with `soksak-spec-`, so they never collide with a plugin id (`soksak-plugin-<name>`)
never collide — which is why the C1 scan looks for plugin id tokens in core sources and skips contract ids.

It is not a separate repository. For the same reason the manifest format is in the core, the implementation is the authority, and a copy
elsewhere drifts from it.

A shared repository becomes necessary in exactly one case — when one contract has implementations in two languages (a Go sidecar and a TypeScript
plugin speaking the same wire). Then no implementation can hold the definition. That has not happened yet.

## P6. A permission is a declaration, not isolation

A permission is a consent notice and a broker allow-list. It is not a sandbox — plugin code runs with the privileges of the runtime that hosts
it. The isolation boundary is the runtime (an opaque-origin document plus one `MessagePort`), and the permission
list sets what that port answers.

Of the 27, the most used: `commands` 42, `ui` 32, `data` 24, `programs` 14, `process` 13,
`fs:read` 13, `terminal` 10, `commands:destructive` 10, `ui:overlay:screen` 6, `commands:inject` 6.

## P7. Plugin loading is outside the first scope

The manifest format, the permission table and the conformance surface are here because they are the boundary a plugin attaches through, and a late
boundary is a boundary already violated. Disk loading, consent recording and the dependency graph are not built
does not.

## P8. The plugin owns its translations

The core translates the core's surfaces, and a plugin translates its own. A plugin that reads the core's table breaks the first moment the core
breaks the first moment a key it never promised is renamed.

Two forms, and they are not interchangeable.

- **Declaration** is the manifest's `LocalizedText` — `{ en, ko }` side by side. Title, description, node description.
- **Runtime strings** — a command's `message`, a human-readable error — come by key from the plugin's own table,
  with the display language supplied by `app.locale()`. A language the table does not hold falls back to English.

**Gate.** Each plugin has its own:
`soksak-plugins/soksak-plugin-terminal-xterm/frontend/src/i18n.test.ts` scans source files outside the table for
It fails when a string a person reads is written there.
