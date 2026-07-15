# soksak public platform wire 0.0.1

This document is normative for the public JSON boundaries exported by
`@soksak-ai/plugin-spec`. The TypeScript parsers enforce the full rules; the JSON Schemas
are the language-neutral structural form; the checked-in corpus fixes canonical bytes and
cryptographic results.

## 1. Ownership is not aggregation

A plugin, sidecar, or kit is an independent unit. Its own repository has final
responsibility for its implementation, unit-specific manifest or protocol, documentation,
tests, source commit, dependency closure, artifacts, and release history. Creating a new
plugin does not require a change to `soksak-spec` or to the core.

`soksak-spec` owns only the common platform boundary: unit identity grammar, owner release
envelope, signed registry projection, portable conformance evidence, and validation tools.
A domain contract is split into `soksak-contract-<domain>` only after two or more independent
implementations genuinely share that domain protocol. It is never split merely to collect
files in one place.

A registry owns discovery and trust continuity, not unit truth. It may index a unit only as:

```text
kind + id + version
owner release manifest URL + SHA-256
conformance report URL + SHA-256[]
```

It must not copy source, dependencies, artifacts, entrypoints, names, commands, or docs from
the owner. Official and third-party registries use the same contract. A unit may be listed by
neither, one, or several registries without changing its implementation.

## 2. Identity and immutable transport

- `kind` is exactly `plugin`, `sidecar`, or `kit`.
- `id` is flat, at most 128 ASCII characters, and matches
  `^[a-z0-9][a-z0-9-]{0,127}$`. A third party is not forced into a
  soksak-branded namespace.
- Versions are strict SemVer 2.0.0. Registry resolution uses full SemVer precedence;
  build metadata does not create a second selectable precedence value.
- Source is a canonical `https://github.com/<owner>/<repository>` URL plus one lowercase
  40-character commit SHA.
- Distribution uses immutable GitHub Release assets plus lowercase SHA-256. A branch,
  `latest`, git checkout, npm/crates registry lookup, or guessed filesystem path is not an
  installation source.
- The release tag is exactly `v<version>` or `<unit-id>-v<version>`. The owner manifest,
  every install artifact, and every report must be assets of that repository and tag.

The package itself is `private: true`; its deterministic tarball is a GitHub Release asset.
This contract does not prohibit a future mature library from additionally publishing to a
language registry. Such publication is an extra distribution channel, never a prerequisite
for soksak installation.

## 3. Owner release manifest

`soksak-spec-release@0.0.1` is the sole install manifest. It owns:

- `kind`, `id`, `version`;
- exact source repository and commit;
- exact release tag;
- generic `plugin|sidecar|kit` dependency ranges;
- the complete artifact matrix;
- SHA-256, archive format, and declarative entrypoint for every artifact.

Plugin and kit releases contain exactly one portable `any` artifact. A plugin entrypoint is
`{kind:"plugin", manifest:<relative path>}`; a kit entrypoint is
`{kind:"kit", packageManifest:<relative path>}`. A sidecar uses canonical Rust target
triples and declares one or more named `process`/`library` paths plus one
exact `{id: "soksak-spec-sidecar-<domain>", version}` interface provider. All sidecar targets expose the same
interface. Paths are lexical, relative, non-empty, and traversal-free. Installers do not
search for default filenames and do not use symlinks.

`plugin.json.dependencies` is only the runtime plugin relationship/authorization surface.
It is not a locator. Its `(plugin id, range)` set must exactly equal the release manifest's
`kind:"plugin"` dependency set. Sidecar and kit dependencies exist only in the release
closure. `sidecars[].reach` and `plugin.json.repo` do not exist.

Dependencies are resolved only against the certified registry that supplied the parent
release. The resolver filters by exact kind/id and range, then selects the greatest SemVer
precedence. No match is a hard failure. It must not retry an official registry, another
private registry, a package registry, or a git branch. A release consumer detects dependency
cycles and fails with the cycle path; it never drops an edge to make the graph installable.

## 4. Platform schemas, runtime contracts, and evidence

Platform schema ids describe documents:

```text
soksak-spec-release@0.0.1
soksak-spec-registry@0.0.1
soksak-spec-conformance@0.0.1
soksak-spec-plugin@0.0.1
soksak-spec-sidecar@0.0.1
soksak-spec-kit@0.0.1
```

Runtime declaration contracts describe independently implemented behavior:

```text
soksak-spec-plugin-<domain>
soksak-spec-sidecar-<domain>
soksak-spec-service[-<domain>]
```

The id is version-free. A provider and conformance report carry exact evidence as
`{ "id": "soksak-spec-plugin-<domain>", "version": "0.0.1" }`; a consumer,
`sidecars[].interface`, `service.interface`, and `viewContract` carry
`{ "id": "...", "range": "0.0.1" }`. Discovery matches the base id and
evaluates the provider version against the consumer range. Concatenated
`name@version` strings are not accepted as runtime contract references.

The two vocabularies are checked separately. In particular, bare
`soksak-spec-plugin@0.0.1` and `soksak-spec-sidecar@0.0.1` are platform schema ids, not values a
plugin may put in `implements`, `consumes`, `viewContract`, or a sidecar interface.

`soksak-spec-conformance@0.0.1` is immutable evidence for one contract. A platform-schema
report keeps the exact schema-id string; a domain report uses the exact `{id, version}` provider
object and is valid only when that owner declared the same provider. It binds the exact
owner manifest SHA-256 and every `(target, artifact SHA-256)` in the release matrix. Only a
`passed` result can be indexed. Every release requires evidence for
`soksak-spec-release@0.0.1` and its kind schema. A sidecar additionally requires evidence for
its declared runtime interface. Plugin-kind evidence includes the exact runtime-dependency
projection rule in §3. Registry report references are an evidence surface; they do not add
a runtime dependency, command, or call surface.

An evidence producer tests the bytes named by the release: it downloads each artifact,
verifies its SHA-256, extracts it with traversal/link rejection, opens the declared
entrypoint, and runs the relevant conformance suite. It must not certify a convenient local
working copy as though it were the release artifact. `soksak-validate conformance` checks
the supplied report/owner documents for authoring and audit; trust for installation exists
only after the registry operator has independently produced or accepted that evidence and
signed its exact digest into a certified index.

## 5. Signed registry certification

`soksak-spec-registry@0.0.1` is signed with Ed25519. Trust configuration pins the expected
`registryId`, expected `keyId`, and the 32-byte public key independently of the downloaded
index. Shape validation alone never makes an index trusted.

The signature input is the registry payload with `signature` omitted, serialized using RFC
8785 JSON Canonicalization Scheme (JCS). The 0.0.1 schema permits only safe integers and ASCII
object keys, so independent JCS implementations produce the checked-in
`registry-canonical.json` bytes. `registry-canonical.sha256` and the RFC 8032 Ed25519 fixture
are the cross-language golden.

Certification is one fail-closed boundary:

1. Strictly parse the index and public key.
2. Require the pinned registry id and key id.
3. Verify Ed25519 over the canonical payload.
4. Require `issuedAt <= now < expiresAt`.
5. Compare the persisted per-registry high-water `(sequence, digest)`:
   - no state: `initial`;
   - same sequence and digest: `unchanged`;
   - greater sequence: `advance`;
   - smaller sequence: rollback failure;
   - same sequence with another digest: equivocation failure.
6. Persist the returned high-water only after the whole certification succeeds.

Downstream code receives `CertifiedRegistryIndex`, not a structurally parsed index. Unit
installation then verifies owner-manifest bytes, exact indexed identity, same-repository/tag
URLs, every report digest, complete required evidence, and finally every artifact digest
before extraction.

## 6. Portable files and CLI

The schemas are:

- `schema/unit-release.schema.json`
- `schema/conformance-report.schema.json`
- `schema/registry-index.schema.json`
- `schema/registry-public-key.schema.json`

The corpus is under `test/fixtures/platform-wire/`. Consumers in another language should
first reproduce the canonical registry bytes/digest/signature, then accept every valid
plugin/sidecar/kit fixture and reject mutations of identity, URL, digest, target, entrypoint,
unknown fields, continuity, and evidence coverage.

The installed GitHub Release package provides:

```text
soksak-validate plugin <plugin.json>
soksak-validate release <release.json>
soksak-validate conformance <report.json> --release <release.json> [--plugin-manifest <plugin.json>]
soksak-validate registry <registry.json> --public-key <key.json> --registry-id <id> --key-id <id>
```

Registry mode performs cryptographic certification; it never reports success from schema
parsing alone. `--at` exists for deterministic fixtures and audits; normal execution uses
the current clock. `--high-water` supplies persisted continuity state.
