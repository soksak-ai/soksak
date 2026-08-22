---
kind: canonical
status: active
canonical: self
---

# Component ownership and shared standards

## Direct component kinds

The platform names plugin, sidecar, kit, contract, and spec directly. There is no generic unit,
component kind, or `{kind,id,version}` identity. Commands, settings, registry records, release
documents, status, and errors use the direct kind name.

## Ownership boundary

- `soksak-spec` is the only source for public platform JSON Schemas, parsers, canonical fixtures,
  validator CLI behavior, and owner release templates.
- `soksak-contract-*` owns a domain protocol only when more than one repository genuinely shares
  that protocol. It is not a second source for platform release or registry grammar.
- `soksak-kit-*` owns reusable implementation code. A kit never owns the public contract grammar.
- Plugin, sidecar, kit, contract, and spec repositories own their implementation, direct manifest,
  tests, license, and exact dependency declarations.
- The core consumes the exact public spec package. It does not copy release, registry, conformance,
  plugin, sidecar, kit, contract, or spec parsers.

## Schema metadata and payload identity

JSON Schema files own `$schema` and `$id`. Payloads do not repeat their schema identifier. `spec` is
reserved for an installed spec identity object. `protocol` is reserved for runtime framing. `format`
is reserved for serialization formats such as `tar.gz` and `tgz`.

## Release and registry

A release contains exactly one plugin, sidecar, kit, contract, or spec identity, its immutable
source commit, artifact byte size and digest, and conformance reports. Release documents contain no
dependency scope or provider selection. Registry documents keep separate plugins, sidecars, kits,
contracts, and specs arrays and contain no install profiles or dependency closure.

## Settings and development

`settings.json` contains user choices: plugin activation, development paths, and provider selection.
`installed.json` contains installed versions, paths, targets, source commits, and manifest and
artifact digests. Neither document copies the other's facts. Development stops managed updates for
only that plugin, sidecar, kit, contract, or spec and does not disable validation.

There is no public unit, dependency scope, install profile, dependency closure, composition graph,
execution graph, or deployment graph. Validation may use temporary local data structures but never
stores them as another contract.

## Change discipline

- No compatibility reader, alias, migration, fallback field, or old path remains.
- A public boundary change updates schema, parser, canonical corpus, validator, owner template,
  consumer tests, and documentation in one verified sequence.
- Tests start RED against the final rule. A failing implementation is fixed without weakening the
  rule.
- Code comments and Git messages are concise English. User-visible Korean and English messages
  carry the same information.
