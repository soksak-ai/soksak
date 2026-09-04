# Plugin contract

## Ownership

`soksak-spec` owns the public plugin manifest, release, registry, conformance, settings, and installed-state grammars. `build/soksak-spec.json` selects one exact Spec release. The Core consumes that release through the `@soksak/soksak-spec` package and Go `platformspec` module. It keeps no parser copies or alternate package name.

The normative version rules and examples belong to the `soksak-ai/soksak-spec` release.

## Manifest

Every plugin declares its exact release version and application requirement:

~~~json
{
  "id": "example-plugin",
  "version": "0.0.1",
  "appVersionRequirement": "0.0.1"
}
~~~

Providers declare exact `{id, version}` interfaces. Consumers declare `{id, requirement}`. The manifest repeats no schema discriminator and selects no provider repository.

Views declare `surfaces: ["tab"]`, `surfaces: ["side"]`, or both. The host owns placement. Unknown fields are rejected rather than mapped.

## Core-owned contract

`frontend/src/plugins/contract.json` contains only Core theme variables and vocabulary consumed by Doctor. Plugin IDs, permissions, and manifest fields come from `soksak-spec`; copying them into the theme contract would create another source.

## Runtime enforcement

- The opaque plugin runtime and capability broker provide isolation.
- Manifest permissions are consent declarations and broker allow-lists.
- Loader activation checks `appVersionRequirement`, permissions, commands, views, nodes, and interface requirements through the canonical package.
- Plugin, sidecar, and Core communicate through commands, events, status, and versioned interfaces. They do not read each other's internal files or DOM.

## Failure reporting

A Plugin runs in the renderer. Core collects no renderer console output, and `activity` records a
command that executed, not a command refused before execution. A Plugin that fails without
reporting therefore fails without any record.

Two forms produce no record:

- An optional call on an absent collaborator. `a?.b()` with `a` undefined performs nothing and
  raises nothing.
- A refusal returned as a value. `commands.execute` returns `{ok:false}` instead of raising, so a
  caller that only catches exceptions treats a refusal as success.

Requirements:

- A component that cannot perform its function reports that once, at the point of detection.
- A caller of `commands.execute` reads `ok` and reports a false value.
- An uncaught Plugin error and a refused Plugin command reach one location readable without
  rebuilding the Plugin.

Measured 2026-09-04: a Plugin wrote no session to the Core index. Every element of the path was
present in the installed bundle and every permission check passed. Locating the cause required
rebuilding the Plugin with an added log statement.

## File-drop grants

An operating-system drop enters Core as a path, but Plugin events receive only opaque grant IDs and
non-sensitive kind labels. A grant is bound to one Plugin and window, can be redeemed once, and is
removed only by that successful owner redemption. Core returns the authorized raw `path`; it does
not interpret the path as shell text, editor input, an image protocol, or another domain command.

The consuming Plugin or domain Kit owns that interpretation. Terminal Kit reads the declared login
shell through `app.environment`, quotes the granted path for one explicitly supported shell family,
and refuses an unknown family. A command cannot supply a raw path in place of a grant. File-path
input and inline-image payloads are separate capabilities and neither falls back to the other.

## Verification

- `soksak-spec` tests the complete manifest and wire grammar.
- Core facade tests prove the exact package is used and unknown fields are rejected.
- `permissionBacking.test.ts` requires every public permission to gate an actual capability.
- `dropGrants.test.ts` proves opaque, owner-bound, one-shot redemption without consumer semantics.
- Plugin repositories test their own manifest, implementation, translations, and release artifact.
