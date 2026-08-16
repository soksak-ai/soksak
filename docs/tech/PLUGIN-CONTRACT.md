---
kind: canonical
status: active
canonical: self
---

# Plugin contract


What a plugin declares, who owns each definition, and which gate checks it.

## P1. The core owns the contract

The contract is what a plugin may rely on. Its definition is core source, not a document:

| Contract | Source | Published in `contract.json` |
| --- | --- | --- |
| Spec version | `frontend/src/plugins/spec` `SPEC_VERSION` | `specVersion` |
| Id pattern | `frontend/src/plugins/contract.gen.test.ts` | `idPattern` |
| Permissions | `frontend/src/plugins/spec` `PERMISSIONS` | `permissions` (27) |
| Theme variables | `frontend/src/theme/engine.ts` `COLOR_SLOTS` + `App.css` | `themeVars` (31) |
| Host theme vocabulary | `frontend/src/plugins/themeContract.ts` | `themeVocab` |

`frontend/src/plugins/contract.json` is generated, never hand-written. `GEN=1 vitest run
contract.gen.test` rewrites it from the live core, and the same test fails when the committed file
differs from the core. Removing a permission from `PERMISSIONS` removes it from the contract, and
every consumer is re-checked on the next run.

**Gates.** `contract.gen.test.ts` (generated file matches the core), `permissionBacking.test.ts`
(every declared permission gates a real `app.*` surface, so a permission left behind by a moved
capability fails).

## P2. The manifest declares which spec version it was written against

Every manifest opens with the version it conforms to:

```json
"spec": "soksak-spec-plugin@0.0.1"
```

This is a compatibility claim, not ownership: the core parses manifests, and the field selects which
rules to parse by. Measured 2026-08-15 across 46 installed plugins: all 46 carry it, and all 46 pin
`0.0.1`.

The definition stays in the core because the core is the only parser. A separate package would be
needed only for a second parser — a third-party validator, or a Go sidecar reading manifests — and
there is none. The plugin folder carries the declaration, not the definition.

## P3. Required and optional manifest keys

Measured across the 46 installed plugins.

Required in all 46: `spec`, `id`, `name`, `version`, `description`, `entry`, `permissions`.

Optional, with the count that uses it: `contributes` 43, `consumes` 20, `implements` 12,
`configuration` 9, `sidecars` 7, `dependencies` 3, `service` 2, `libraries` 2.

`name` and `description` are `{ ko, en }` objects, not strings.

## P4. Contribution axes

What a plugin contributes, and how many of the 46 use each: `commands` 81 declarations, `ui` 32,
`nodes` 28, `programs` 27, `views` 26, `data` 24, `process` 13, `terminal` 10, `sidecar` 6,
`skill` 5, `notify` 4, `network` 4.

These are the four attachment seams of `ARCHITECTURE.md` in manifest form: a program declares a
`kind` the skeleton routes to, a view declares a slot, a command registers once and is reachable
through every transport, and a permission gates a capability.

## P5. A plugin's spec is the plugin's, and the core's is the core's

There is no place that collects specs. The core defines its own formats and stamps `CORE_SPEC` into
them; a plugin's manifest is that plugin's spec, and the plugin id names it.

A plugin that needs another declares it in `dependencies`. That is the whole coupling: one identity,
declared, checked at the call boundary.

`implements` and `consumes` stood here until 2026-08-16, naming an interface so either side could be
swapped without knowing the other. Not one interface ever had both sides declared, and the id was a
second name for what the plugin id already names. When two implementations of one thing exist, the
mechanism gets designed then, against that case.

## P6. Permissions are declarations, not isolation

A permission is a consent notice and a broker allow-list. It is not a sandbox: plugin code runs with
the privileges of whatever runtime hosts it. The isolation boundary is the runtime — an
opaque-origin document with one `MessagePort` — and the permission list decides what that port
answers.

Most used, of 27 declared: `commands` 42, `ui` 32, `data` 24, `programs` 14, `process` 13,
`fs:read` 13, `terminal` 10, `commands:destructive` 10, `ui:overlay:screen` 6, `commands:inject` 6.

## P7. Plugin loading is not in the first round

The manifest format, the permission table and the conformance surface are here because they are the
boundary a plugin attaches through, and a boundary defined late is a boundary already violated. Disk
loading, consent recording and the dependency graph are not built in this round.

## P8. A plugin owns its translations

The core translates the core's surfaces; a plugin translates its own. A plugin that read the core's
table would break the first time the core renamed a key it never promised.

Two forms, and they are not interchangeable:

- **Declarations** in the manifest are `LocalizedText` — `{ en, ko }` side by side. Titles,
  descriptions, node descriptions.
- **Runtime strings** — a command's `message`, an error a person reads — come from the plugin's own
  table, keyed, with the host's language supplied by `app.locale()`. A language the table does not
  carry falls back to English.

**Gate.** Each plugin holds its own: `soksak-plugins/soksak-plugin-terminal-xterm/frontend/src/i18n.test.ts`
fails on a display string written into any source file outside the table.
