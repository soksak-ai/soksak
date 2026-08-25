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
dependency scope or provider selection. Registry documents list current Plugin roots. Plugin release
references disclose the exact Plugin and Sidecar runtime closure; build receipts disclose Kit,
Contract, and Spec inputs. The registry contains no install profiles or stored closure.

## Environment

`environment.json` is the only runtime-component state. It records exact Plugin and Sidecar versions,
materialized absolute paths, artifact SHA-256 values, source kinds, registry IDs, Sidecar targets, and
Plugin activation. Plugin releases own exact runtime dependency references; the environment stores no
role binding. Release documents and build receipts own repositories, source commits, dependency
declarations, URLs, sizes, and digests for Kit, Contract, and Spec inputs.

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
