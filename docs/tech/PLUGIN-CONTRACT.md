# Plugin contract

## Ownership

`soksak-spec` owns the public plugin manifest, release, registry, conformance, settings, and installed-state grammars. The Core consumes the exact `@soksak-ai/plugin-spec` package and Go `platformspec` module. It keeps no parser copies.

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

## Verification

- `soksak-spec` tests the complete manifest and wire grammar.
- Core facade tests prove the exact package is used and unknown fields are rejected.
- `permissionBacking.test.ts` requires every public permission to gate an actual capability.
- Plugin repositories test their own manifest, implementation, translations, and release artifact.
