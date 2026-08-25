---
kind: changelog
status: historical
canonical: docs/tech/ENVIRONMENT-AND-INSTALLATION.md
---

# Environment and installation design flow

The current contract is [ENVIRONMENT-AND-INSTALLATION.md](./ENVIRONMENT-AND-INSTALLATION.md).

## Why two local records failed

Local component state was split between `settings.json` and `installed.json`. Activation and role
selection lived in one revision while installed paths and versions lived in another. A crash or a
concurrent update could publish one half without the other, leaving a selection that named content
the runtime could not open. Readers also had to merge two authorities before answering a simple
question: “what exact component will run?”

## One atomic environment

`environment.json` became the only persistent local component state. One revision now contains the
selected exact versions, absolute local paths, source kinds, activation, targets, and plugin-to-
sidecar role bindings. Installation stages bytes first and replaces the component directories and
environment in one transaction. Failure leaves the prior environment unchanged.

The registry remains the authority for remote provenance and immutable release metadata. The local
environment stores only what this installation selected and where those verified bytes are located.

## Evidence

The environment contract gate rejects the retired filenames and command surfaces in active code and
canonical documents. Transaction tests prove that failed installation cannot publish a partial
environment.

## Why a virtual first revision failed

The first implementation returned an in-memory revision 1 when `environment.json` did not exist,
while compare-and-swap correctly observed the stored revision as 0. The first installation could
therefore only fail with `expected 1, actual 0`. Core now publishes the real revision 1 after it
owns the identity home; reads and writes share one state instead of assigning two meanings to
absence.

## 2026-08-25: Development source and one removal command per kind

A development record has `source` set to `development`, `path` set to the source directory,
`artifactSha256` present and empty, `registry` absent, and `version` read from the manifest at
`plugin_develop` time. `plugin_develop` and `sidecar_develop` register it by compare-and-swap.
Installing a `registry` or `local` release over a development record replaces the record; an empty
`artifactSha256` never raises `VERSION_ARTIFACT_CONFLICT`.

The development directory is the version truth. No validation compares a development record's
`version` against the directory's `plugin.json`; the Core frontend builds the runtime from the
on-disk manifest and uses its version for dependents' `{id, version}` requirements and for reload
identity. Registry and local records stay immutable: their `version` must equal the artifact's
`plugin.json`.

A Plugin entry follows the manifest as `parseManifest` does: key absent is `main.js`; `null` is no
entry file (a pure contract Plugin); a string is a relative path inside the directory (no `..`, not
absolute). `plugin_develop` validates that file (a regular file, no symlink in its path components)
only when the entry is not `null`.

An install whose content-addressed directory
`<home>/components/<kind>/<id>/<version>[/<target>]/<sha256>` already exists reuses that directory
and discards the staged copy; the same digest is the same bytes and the rename that published the
directory was atomic. `destinationExists` is never returned for that case.

`plugin_remove` and `sidecar_remove` (`id`, `expectedRevision`) are the one removal command per
kind: `plugin_remove` was an unbuilt stub before this change and `sidecar_remove` is new. A
development record is removed from the environment only. A `local` or `registry` record is removed
from the environment and its artifact directory is deleted only when the real path — symlinks
resolved on both the components root and the record path, a symlink in any path component under
the components root refused — is strictly under `<home>/components/`; any other path is refused
with `environment.remove.pathOutsideHome`. An unknown id is refused with
`environment.remove.notFound`. The dependency invariant is checked on the resulting environment
before the write.

Artifact removal is atomic with respect to the content-addressed path. The directory is renamed to
`<dir>.removing` in the same parent before the environment write; the write is compare-and-swap; a
failed write renames the directory back; after a successful write `<dir>.removing` is deleted. A
failed deletion returns `environment.remove.artifactDeleteFailed` naming the `.removing` path
together with the change. The content-addressed path is therefore never partial, which is the
condition under which install reuses an existing directory at that path.

The Core frontend removes host first: `plugin_remove` at the current revision, and only after the
host accepted, the in-memory instance is deactivated, consent and enabled state are cleared, and
the revision is reconciled once. A host refusal changes nothing in the frontend. `sidecar.remove`
refuses `SIDECAR_IN_USE` when `sidecar_status` lists the id as open or recorded, the same rule as
`sidecar.install.local`; nothing is stopped automatically.

The host validates `environment.json` once. `environment_get` returns the validated document and
the Core frontend consumes it as typed data through its own `HostEnvironment` type. The frontend's
`parseEnvironmentDocument` call and its `ENVIRONMENT_INVALID` result are removed. The Core `./spec`
barrel exports only the names Core uses, by explicit named exports; `parseEnvironmentDocument` is
not among them. Absolute-path validation for development records happens in the host only; the
frontend does not pre-validate paths.

## 2026-08-25: Effective version, spec-exact entry, removal order

The section above recorded three rules that the host did not implement as written, and a fourth
that a later Go change replaced. This entry states the rules that hold now.

The effective version is one host rule, `recordVersion` over the single manifest reader
`readRecordManifest` in `core/environment/manifest.go`. A `registry` or
`local` record's effective version is its stored `version`. A `development` record's, Plugin or
Sidecar, is the version in `<path>/plugin.json` or `<path>/sidecar.json` read at the time of the
comparison. Every host comparison of a caller-supplied version against a record uses it:
`plugin_enabled_set`, Sidecar resolution for a Plugin requirement and for a requested version, the
dependency invariant for both Plugin and Sidecar records, and the install commit's checks against
development records. No site compares a development record's stored `version`. The earlier
sentence "no validation compares the record's version against the directory's manifest" described
the Plugin store only; the host had compared the stored `version` of a development Sidecar. A
development record whose manifest cannot be read or parsed, or declares a different id, is broken:
no effective version, no dependent satisfied, and every operation that needs its effective version
(`plugin_enabled_set` with `enabled` `true`, Sidecar resolution in `sidecar_open`) fails with
`environment.develop.directoryUnavailable` (`kind`, `id`, `path`, `error`). A write proceeds when
no dependent requires the broken record; validation skips its identity check and treats it as
absent for dependents.

The entry rule is spec-exact (`soksak-spec` `packages/plugin-spec/src/spec.ts`, `parseManifest`):
absent is `main.js`; `null` is no entry; a string is trimmed, non-empty, relative, without a `..`
segment, without a leading separator or drive letter, and ends with `.js` or `.mjs`; any other
value is refused with `environment.develop.entryInvalid`. The earlier host accepted an untrimmed
string with any extension.

Removal order. If `<dir>.removing` exists before the rename, it is the remainder of an earlier
removal whose record is already gone, and it is deleted first; a failure there is refused with
`environment.remove.artifactDeleteFailed` naming `<dir>.removing` and nothing changes. Then rename
to `<dir>.removing`, environment write (compare-and-swap), rename back on write failure, delete
`<dir>.removing` on success. A failed final deletion is no longer a Go error: the command succeeds
with `{ previousRevision, revision, artifactDeleteFailed: { path, error } }`. The Core frontend
treats that change as a success — consent cleared, cascade continued — and publishes one activity
(`plugin.remove.artifactLeft`, `sidecar.remove.artifactLeft`) with the path. The earlier frontend
treated every throw as a refusal, so a deletion failure left consent and enabled state in place for
a record the host had already removed.

Path refusals are two keys, not one: `environment.remove.pathOutsideHome` for a path that is not a
strict descendant of `<home>/components/`, and `environment.remove.pathSymlink` for a symlink in
any path component under the components root. The earlier text named only the first.

`sidecar.develop` refuses `SIDECAR_IN_USE` through the same `sidecarInUse` check as
`sidecar.install.local` and `sidecar.remove`, before any host call. The earlier command had no
guard, so a development record could replace the record of a running Sidecar.

The contract document lists, per host command, every error a caller can receive: the keys
`environment.develop.pathAbsolute`, `environment.develop.directoryUnavailable`,
`environment.develop.entryInvalid`, `environment.remove.notFound`,
`environment.remove.pathOutsideHome`, `environment.remove.pathSymlink`,
`environment.remove.artifactDeleteFailed`, `install.transaction.dependencyVersionConflict`,
`install.transaction.pluginManifestInvalid`, `install.hostArtifactTarget.noPlatform`,
`install.hostArtifactTarget.noTriple`, and the errors that are not keys: `ErrRevisionConflict`,
`os.ErrNotExist` for an absent `environment.json`, and the `os.ErrInvalid`, `os.ErrNotExist`, and
file-check os errors named in the table. `environment.develop.manifestMismatch` is deleted.
`environment.develop.directoryUnavailable` (`kind`, `id`, `path`, `error`) is the one refusal for
a development manifest that cannot be read or parsed or that declares a different id: in
`plugin_develop` and `sidecar_develop`, in `plugin_enabled_set` with `enabled` `true`, and in
Sidecar resolution. A raw os error of a manifest read is never returned to the caller.

One read. For every record a host operation touches, its manifest is read and parsed exactly once
per operation; the effective version and every other manifest field come from that single parse,
and no operation compares two reads of the same file. Disable. `plugin_enabled_set` with `enabled`
`false` does not require an effective version, so a broken development Plugin can be disabled;
`enabled` `true` requires it. Orphan. Removal of a non-development record always attempts
`RemoveAll(<dir>.removing)`, `<dir>` being the record path with its parent chain resolved and
symlink-checked, even when `<dir>` itself no longer exists; a crash between the rename and the
environment write leaves nothing behind after the next removal of that record.

## 2026-08-26: Refusal table derived from the code

The refusal table of the contract document is derived from `core/environment` and lists every
error each host command returns. The earlier table named two non-key errors and left the rest to
prose. Added rows: argument decoding per command (`control.arg.missing`, `control.arg.nullValue`,
and the raw `argument "<name>": <json error>` of a wrong JSON type); the raw read or parse error
of `environment.json`; `environment.home.absolute`; the raw `platformspec` validation error of the
resulting environment at write; the raw os errors of `MkdirAll`, `WriteFile`, and `Rename` while
publishing; `errors.Join(write error, rename error)` when `plugin_remove` or `sidecar_remove`
cannot rename `<dir>.removing` back after a failed write; `Lstat(<dir>)` failing with an error
other than not-exist. Made exact: `environment.develop.directoryUnavailable` covers a missing
manifest and its `error` is `<file>: <os or parse error>` or `<file> declares id <id>`; the
spec-parser conditions of `sidecar.json`; `environment.remove.pathOutsideHome` names `<dir>` when
the resolved parent puts it outside the resolved root; the effective version `plugin_enabled_set`
compares, and the skipped version check for a broken development record with `enabled` `false`.
Sidecar resolution in `sidecar_open` adds `os.ErrInvalid` for a `registry` or `local` Sidecar
whose `sidecar.json` does not confirm the record, and the process-file check of `dist/<id>`.

## 2026-08-26: Broken records in `plugin_manifest_list`, removal and disable of a rejected record

`plugin_manifest_list` reads every record's manifest through `readRecordManifest`, the reader every
other operation uses. A record whose manifest cannot be read or parsed, or declares another id, is
listed with `manifest` `null` and `error` set to the `environment.develop.directoryUnavailable`
sentence for a `development` record and the `install.transaction.pluginManifestInvalid` sentence
for a `registry` or `local` record. The earlier command read `plugin.json` with a second reader
and reported the raw os string.

The Core frontend's `plugin.remove` and `plugin.disable` look the id up in the host list, the
parsed runtime map and the rejected list together. The earlier store answered `TARGET_NOT_FOUND`
from the parsed runtime map alone, so a broken development record the host listed could be neither
removed nor disabled from the frontend. Now a rejected record is removed through `plugin_remove`
and dropped from the rejected list after the host accepted, and disabled through
`plugin_enabled_set` with `enabled` `false` when the host record is enabled; `TARGET_NOT_FOUND`
only when the host has no record.

The contract document names the Go identifiers that exist: `readRecordManifest` and
`recordVersion` in `core/environment/manifest.go`. The earlier text cited `effectiveVersion`, a
name no Go file declares. The refusal table has rows for `plugin_manifest_list` and
`environment_get`: both return the non-key read or parse error of `environment.json`;
`environment_get` returns `os.ErrNotExist` for a missing file where `plugin_manifest_list` returns
an empty list; a per-record manifest error is data on the record, never a refusal.
