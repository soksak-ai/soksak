# Environment and installation

`soksak-spec` owns the public JSON shape. This document defines Core runtime state and the
installer transaction. Canonical build, local-store, and GitHub publication rules are in the spec
package's `docs/BUILD-AND-RELEASE.md`.

## Environment

The environment records only Plugin and Sidecar runtime selections.
`<identity-home>/environment.json` is the only persistent runtime-component state. It contains one
monotonic `revision`, Plugin records, and Sidecar records. A Plugin record contains its exact
version, materialized absolute path, source (`local`, `registry`, or `development`), artifact
SHA-256, and enabled state. A Sidecar record contains the same fields except enabled state and adds
its target triple and the absolute materialized process path inside its component directory.

Kit, Contract, and Spec are build or validation inputs. Their exact release references remain in
release documents and candidate build receipts; Core does not copy them into runtime state. Runtime
dependencies remain in Plugin releases. The environment stores no repository, source commit, URL,
size, dependency closure, or role binding.

Core creates revision 1 after acquiring the identity home. Missing or invalid state is a boot error,
not an implicit empty state. Every change uses compare-and-swap and emits one `environment.changed`
event. No caller polls the file.

A frontend lifecycle operation that writes an environment revision does not return until the one
environment coordinator has applied that revision. The matching `environment.changed` event joins
the same reconciliation and is a no-op after it is applied. Consequently a following enable,
disable, install, or reload cannot race the reload caused by the preceding write and register the
same Plugin generation twice.

The host validates `environment.json` once. `environment_get` returns the parsed and validated
document; the Core frontend consumes it as typed data and does not validate it a second time.

## One release contract, two transports

Local and registry releases use the same closure resolver and installer transaction. Both have the
same public release documents, manifests, permissions, entrypoints, sizes, and SHA-256 values. HTTPS
and an explicitly addressed local release store differ only in how the approved bytes are read.
Raw source paths are never installation inputs. A development record's `path` is a source
directory declared by `plugin.develop` or `sidecar.develop`, not an installer input. Core never
discovers a repository through `../`, an injected workspace root, `PATH`, checkout layout, or a
symbolic link.

No release document records a location. A release directory is derived from kind, id, and version:
`https://github.com/soksak-ai/<id>/releases/download/v<version>/` when published,
`<store>/<kind>s/<id>/<version>/` in a local store; every file inside is addressed by its bare name.
A parent release pins each dependency's `release.json` by size and SHA-256, and the resolver that
reads it must return those bytes. A local install reads every release of the closure from the
addressed store; a dependency absent from the store, or one whose bytes differ from the pin, is an
error named by its derived location. Core does not fall back to the network.

## Installer transaction

The installer resolves the complete Plugin/Sidecar runtime closure, selects the host target, verifies
every size and SHA-256, extracts regular files only, validates manifests, and stages every component
before changing runtime state. It publishes component directories and `environment.json` in one
transaction. Failure leaves the previous environment and component directories unchanged.

A Sidecar manifest declares a project-independent `processRole` and its canonical release process.
The installer receives the Core build's `PROJECT`, renames the staged process to
`<PROJECT>-<processRole>` (preserving `.exe` on Windows), and records that exact absolute file in
`environment.json`. The canonical release file is not retained as a second executable. Runtime
resolution executes only the environment record; it does not reconstruct a name from the Sidecar
id or use an in-process display-name override.

The same id, version, target, and artifact digest is idempotent. An install whose content-addressed
directory `<home>/components/<kind>/<id>/<version>[/<target>]/<sha256>` already exists reuses that
directory and discards the staged copy: the same SHA-256 is the same bytes, and the directory was
published by an atomic rename, so an existing directory is complete. That case does not fail. The
same id, version, and target with a different digest fails with
`VERSION_ARTIFACT_CONFLICT`; Core never overwrites installed bytes. A Local record is excluded from
automatic registry replacement. A registry update may still be shown,
but replacing the Local selection requires an explicit registry install transaction.

A running or recorded Sidecar is not stopped by installation. Selecting different Sidecar bytes
requires an explicit lifecycle operation; Core does not terminate a user's restorable process to
complete an update.

## Immutable local release store

A local release is a release transport, not a build cache. The addressed store retains every
verified version under `<store>/<kind>s/<id>/<version>/` with its `release.json`, manifest, evidence,
and target artifact. Publishing a newer candidate never replaces or mutates an older directory.
Each application identity chooses a compatible closure through its own install transaction and
home; an existing application therefore continues to use its recorded older closure while a
separate identity can install a newer one. A dependency version conflict rejects the transaction
before any environment write—it never silently upgrades a different plugin or rewrites an existing
release directory.

Frontend packaging does not imply a native compilation step. A frontend release owner declares
whether its entry requires a build; a build-required package runs that command and seals only its
declared outputs, while a static or already-generated entry may be packaged without a build. Both
paths run the same manifest, dependency, archive, and digest validation and produce the same
immutable store layout. Skipping compilation never permits a source-directory runtime path,
`file:`/`link:` locator, or mutable workspace injection.

When two or more installed Plugins must move a shared exact dependency to a new version, they are
installation roots of one transaction. `plugin.install.local.batch.plan` resolves every root from
one addressed store and selects exactly one version for each component kind and id. If two closures
select different versions, it returns `DEPENDENCY_VERSION_CONFLICT` with every conflicting id,
version and root before calculating a plan digest. It also rejects duplicate or conflicting release
identities, then hashes the sorted root set plus the complete union closure. `plugin.install.local.batch` re-resolves that same plan
and stages every distinct Plugin and Sidecar once before one environment revision commit. Updating
the roots one at a time, editing `environment.json`, or temporarily removing a dependent Plugin is
not a valid migration path.

The batch installer reads the public `sidecar_status` immediately before staging. Any selected
Sidecar present in `open` or `recorded` returns `SIDECAR_IN_USE` with its requested version and the
running version, process and PID. It never writes a newer environment selection over a running older
unit and never stops one implicitly. The caller explicitly runs `sidecar_stop`, then retries the
unchanged plan digest; re-resolving the plan closes the interval between planning and installation.

## Development source

A development record is the same Plugin or Sidecar record shape with `source` set to `development`.
`path` is the absolute, clean source directory: a Plugin directory contains `plugin.json` and the
entry it declares (entry `null`: no entry file); a Sidecar directory contains `sidecar.json` and
the project-materialized process declared by the environment. The entry rule is the manifest rule of `parseManifest` (`soksak-spec`,
`packages/plugin-spec/src/spec.ts`): key absent is `main.js`; `null` is no entry file (a pure
contract Plugin); a string is trimmed and must be non-empty, relative (no leading separator, no
drive letter), contain no `..` segment, and end with `.js` or `.mjs`; any other value is refused
with `environment.develop.entryInvalid`. The host validates the path, and validates the entry file
(a regular file, no symlink in its path components) only when the entry is not `null`; the frontend
does not pre-validate. A relative or unclean path is refused with `environment.develop.pathAbsolute`.
The manifest is read and parsed once per operation; `id`, `version`, and `entry` (Plugin) or
`process` (Sidecar) come from that single parse. A directory whose manifest cannot be read or parsed, or whose manifest declares a
different id, is refused with `environment.develop.directoryUnavailable` (`kind`, `id`, `path`,
`error`); `error` is `<file>: <os or parse error>` or `<file> declares id <id>`, and the os or
parse error on its own is never returned to the caller.
`version` is copied from that parse at `plugin.develop` or `sidecar.develop` time and must be
strict semver. `registry` and `local` records are immutable;
their `version` must equal the artifact's manifest. `artifactSha256` is present and empty;
`registry` is absent; there is no artifact. A Sidecar record's `target` is the host artifact target
triple derived from the host build OS and architecture, never from an environment variable.
Validation rejects a `development` record with a non-empty digest or registry. Validation of
`local` and `registry` records is unchanged; a digest is required.

The effective version of a record is one host rule (`recordVersion` in
`core/environment/manifest.go`, over the single manifest reader `readRecordManifest`). For
a `registry` or `local` record it is the record's `version`. For a `development` record, Plugin or
Sidecar, it is the version in the directory manifest (`<path>/plugin.json` or
`<path>/sidecar.json`). For every record a host operation touches, that manifest is read and parsed
exactly once per operation; the effective version and every other manifest field the operation
uses come from that single parse, and no operation compares two reads of the same file. The stored
`version` of a development record is never compared. Every host comparison of a caller-supplied
version against a record uses the effective version: `plugin_enabled_set`, Sidecar resolution in
`sidecar_open` for a Plugin requirement and for a requested version, the dependency invariant
(every Plugin's manifest `runtimeDependencies` `{id, version}` against Plugin and Sidecar records,
checked before every environment write that changes a record and by the installer), and the
install commit's checks against development records. A development record whose manifest cannot
be read or parsed, or whose manifest declares a different id, is broken: it has no effective
version and it satisfies no dependent. Every operation that needs its effective version is refused
with `environment.develop.directoryUnavailable` (`kind`, `id`, `path`, `error`):
`plugin_enabled_set` with `enabled` `true`, and Sidecar resolution in `sidecar_open` for a broken
consumer Plugin or a broken Sidecar. `plugin_enabled_set` with `enabled` `false` does not require
an effective version: a broken development Plugin is disabled without one. The dependency invariant
treats a broken record as absent for dependents: a dependent that requires it is refused with
`install.transaction.dependencyVersionConflict` (`requested` is `missing`), and a write proceeds
when no dependent requires the broken record; validation skips the broken record's identity check.
The Core frontend builds the runtime from the same on-disk manifest and uses its version for
dependents' `{id, version}` requirements and for reload identity.

`plugin_manifest_list` reads every record's manifest through `readRecordManifest`, the reader every
other operation uses. A record whose manifest cannot be read or parsed, or declares another id, is
listed with `manifest` `null` and `error` set to the `environment.develop.directoryUnavailable`
sentence for a `development` record and the `install.transaction.pluginManifestInvalid` sentence
for a `registry` or `local` record; a raw os string is never reported. The Core frontend lists such
a record as rejected. `plugin.remove` and `plugin.disable` look the id up in the host list, the
parsed runtime map and the rejected list together: a rejected record is removed through
`plugin_remove`, and disabled through `plugin_enabled_set` with `enabled` `false` when the host
record is enabled. `TARGET_NOT_FOUND` only when the host has no record.

`plugin.develop` and `sidecar.develop` register a development record. Declaring development for an
id that already has a `registry`, `local`, or `development` record replaces that record. Installed
artifact directories are not deleted. Installing a `registry` or `local` release for an id that has
a development record replaces that record; the empty `artifactSha256` of a development record never
raises `VERSION_ARTIFACT_CONFLICT`.

The response of each develop command includes the resulting status. `plugin.develop` returns after the
environment coordinator reloaded the plugins and answers `{ id, path, revision, status, error? }`:
`status` is the runtime status (`enabled`, `disabled`, `error`), `rejected` when only the rejected
list holds the id, or `absent` when neither holds it; `error` is the runtime error or the rejection
errors joined by `; `, and is omitted when there is none. The message names the status, and the
error when there is one: `Recorded development record for Plugin <id> at <path>; status disabled:
<error>`. `sidecar.develop` answers `{ id, path, revision, version }` where `version` is the
version of the record the host wrote, read from `environment_get` after the write; the message is
`Recorded development record for Sidecar <id> at <path> (version <v>)`; the Korean message includes the
same information. There is
no status field: the pre-write `SIDECAR_IN_USE` guard refuses an id listed as `open` or `recorded`,
so a post-write `sidecar_status` read has one answer.

A pane whose view has no provider renders one overlay, and the overlay is an exposed node under the
view's address (`ui.tree` lists it as `<view address>/node/<data-node>`; its `data-*` attributes are
in `dataset`). The overlay is a sibling of the provider container and declares the view address
under `data-view-overlay-addr`; the container alone holds `data-view-addr`, so `ui.slot` resolves one element per view address. The node collector has two scan roots,
`.tab-viewer[data-view-addr]` and `[data-view-overlay-addr]`, and a `data-node` inside either is
listed under that root's view address, never as chrome. Before boot is ready the node is `plugin-view-loading`. After boot the node is
`plugin-view-placeholder` with `data-view-plugin` (the plugin id) and `data-view-state`: `off` when
the plugin is installed and disabled, `absent` when no record holds the id, `refused` when the
manifest was rejected, in which case `data-view-reason` holds the rejection errors joined by `; `.
When the provider's mount threw, the node is `plugin-view-error` with `data-view-plugin` and
`data-view-error` (the thrown message).

`plugin.remove` and `sidecar.remove` are the only removal commands. A development record is removed
from the environment only; the source directory is never deleted. A `local` or `registry` record is
removed from the environment and its artifact directory at the record's `path` is deleted, only
when the real path is strictly under `<home>/components/`: symlinks are resolved on both the
components root and the record path. A path that is not a strict descendant is refused with
`environment.remove.pathOutsideHome` (`path`, `home`); a symlink in any path component under the
components root is refused with `environment.remove.pathSymlink` (`path`, `link`); in both cases the
record is kept. An unknown id is refused with `environment.remove.notFound` (`kind`, `id`). The
dependency invariant is checked on the resulting environment before any file operation. Removal is
atomic with respect to the content-addressed path and runs in this order. `<dir>` is the record's
`path` with its parent chain resolved and every path component symlink-checked.
`RemoveAll(<dir>.removing)` is always attempted first, even when `<dir>` itself no longer exists:
`<dir>.removing` is the remainder of an earlier removal whose record is already gone, and a crash
between the rename and the environment write therefore leaves nothing behind after the next removal
of that record. A failure there is refused with `environment.remove.artifactDeleteFailed` (`path` is
`<dir>.removing`, `error`) with nothing changed. When `<dir>` exists, it is renamed to
`<dir>.removing` in the same parent; the environment write runs (compare-and-swap); a failed write
renames the directory back and is refused; after a successful write `<dir>.removing` is deleted. A
failed final deletion is not an error: the command succeeds with `{ previousRevision, revision,
artifactDeleteFailed: { path, error } }` where `path` is the `.removing` path; the record is
removed and `environment.changed` is emitted. The content-addressed path is never partial, which is
why install reuses an existing directory at that path.

The Core frontend removes a Plugin host first: `plugin_remove` at the current revision, and only
after the host accepted, the in-memory instance is deactivated without an enabled write, consent and
enabled state are cleared, and the revision is reconciled once through the environment coordinator.
A host refusal changes nothing in the frontend. `artifactDeleteFailed` in the change is a success:
the frontend publishes one activity (`plugin.remove.artifactLeft` from the Plugin store,
`sidecar.remove.artifactLeft` from `sidecar.remove`) with the path, consent is cleared, and a
cascade continues. `sidecar.develop` and `sidecar.remove` refuse `SIDECAR_IN_USE` when
`sidecar_status` lists the id as open or recorded, the same rule as `sidecar.install.local`; Core
does not stop the Sidecar.

`plugin.reload {id}` re-reads `<path>/plugin.json` and the entry it declares. Identical manifest and
entry bytes keep the current runtime generation. Changed bytes replace an enabled generation without
writing `plugin_enabled_set`; a disabled record stays disabled. `state.health.plugins.modules`
reports graph reuse and replacement. `unitMode` in `app.environment` is derived from development
records.

## Refusals

The table lists, per host command, every error a caller can receive from the environment module.
Refusal keys are i18n keys declared in `core/environment`; the `install.*` keys below are declared
there as well. An error marked non-key is returned as it is: a Go `os` error,
`ErrRevisionConflict`, or the raw error of `control.Arg`, of the `environment.json` reader, or of
the `platformspec` validator. `SIDECAR_IN_USE` for `sidecar.develop` and `sidecar.remove` is a Core
frontend refusal before the host call, not a host error. The `sidecar_open` rows list the
environment-owned errors of Sidecar resolution only. `<dir>` is the resolved artifact directory of
the removal rule above.

| Command | Error | Condition |
| --- | --- | --- |
| `plugin_develop`, `sidecar_develop` | `control.arg.missing` (`name`), `control.arg.nullValue` (`name`) | `id`, `path`, or `expectedRevision` is absent or `null`. Checked before everything else. |
| `plugin_remove`, `sidecar_remove` | `control.arg.missing` (`name`), `control.arg.nullValue` (`name`) | `id` or `expectedRevision` is absent or `null`. Checked before everything else. |
| `plugin_enabled_set` | `control.arg.missing` (`name`), `control.arg.nullValue` (`name`) | `plugins`, `enabled`, or `expectedRevision` is absent or `null`. Checked before everything else. |
| `plugin_develop`, `sidecar_develop`, `plugin_remove`, `sidecar_remove`, `plugin_enabled_set` | non-key `argument "<name>": <json error>` | An argument has the wrong JSON type. |
| `sidecar_develop` | `install.hostArtifactTarget.noPlatform` | The process was given no host OS or architecture. Checked before `path`. |
| `sidecar_develop` | `install.hostArtifactTarget.noTriple` (`os`, `arch`) | No artifact triple for the host pair. Checked before `path`. |
| `plugin_develop`, `sidecar_develop` | `environment.develop.pathAbsolute` (`path`) | `path` is relative or not clean. |
| `plugin_develop` | `environment.develop.directoryUnavailable` (`kind` `plugin`, `id`, `path`, `error`) | `<path>/plugin.json` is missing, cannot be read or parsed, or declares another id. `error` is `plugin.json: <os or parse error>` or `plugin.json declares id <id>`. |
| `sidecar_develop` | `environment.develop.directoryUnavailable` (`kind` `sidecar`, `id`, `path`, `error`) | `<path>/sidecar.json` is missing, cannot be read, is refused by the spec parser (an unknown field or trailing data; `id` or `interface.id` outside the id pattern; `version` not strict SemVer; `interface.version` other than `0.0.1`; `process` other than `dist/<id>` or `dist/<id>.exe`), or declares another id. `error` is `sidecar.json: <os or parse error>` or `sidecar.json declares id <id>`. |
| `plugin_develop` | `environment.develop.entryInvalid` (`id`, `entry`) | The manifest `entry` violates the entry rule. |
| `plugin_develop` | non-key `os.ErrNotExist`, `os.ErrInvalid`, or another `Lstat` error | Entry-file check, entry not `null` (`main.js` when absent): the entry or a component of its path is missing (`os.ErrNotExist`); a component is a symlink or the entry is not a regular file (`os.ErrInvalid`); `Lstat` failed otherwise (the os error). |
| `sidecar_develop` | non-key `os.ErrNotExist`, `os.ErrInvalid`, or another `Lstat` error | Process-file check of the manifest `process` (`dist/<id>`): the process or a component of its path is missing (`os.ErrNotExist`); a component is a symlink or the process is not a regular file (`os.ErrInvalid`); `Lstat` failed otherwise (the os error). |
| `plugin_develop`, `sidecar_develop`, `plugin_remove`, `sidecar_remove`, `plugin_enabled_set`, `sidecar_open` | non-key read or parse error of `environment.json` | `environment.json` cannot be read (an error other than not-exist), or its content is refused by the `platformspec` parser or validator. First check in `plugin_remove`, `sidecar_remove`, and `plugin_enabled_set`; after the directory checks in `plugin_develop` and `sidecar_develop`. |
| `plugin_develop`, `sidecar_develop`, `plugin_remove`, `sidecar_remove`, `plugin_enabled_set`, `sidecar_open` | non-key `os.ErrNotExist` | `environment.json` is missing. Same position as the row above. |
| `environment_get`, `plugin_manifest_list` | non-key read or parse error of `environment.json` | `environment.json` cannot be read (an error other than not-exist), or its content is refused by the `platformspec` parser or validator. The only refusal of these two commands. |
| `environment_get` | non-key `os.ErrNotExist` | `environment.json` is missing. `plugin_manifest_list` returns an empty list instead. |
| `plugin_manifest_list` | none; `error` on the record | A record whose manifest cannot be read or parsed, or declares another id, is listed with `manifest` `null` and `error` set to the `environment.develop.directoryUnavailable` sentence (`development`) or the `install.transaction.pluginManifestInvalid` sentence (`registry`, `local`), from `readRecordManifest`. Never a refusal, never a raw os string. |
| `plugin_remove`, `sidecar_remove` | `environment.remove.notFound` (`kind`, `id`) | No record for `id`. |
| `plugin_remove`, `sidecar_remove` | `environment.remove.pathOutsideHome` (`path`, `home`) | A non-development record whose `path` is not a strict descendant of `<home>/components/`, or whose `<dir>` is not a strict descendant of the resolved components root; `path` is `<dir>` in the second case. The record is kept. |
| `plugin_remove`, `sidecar_remove` | `environment.remove.pathSymlink` (`path`, `link`) | A path component below the components root, the leaf included, is a symlink. The record is kept. |
| `plugin_remove`, `sidecar_remove` | non-key os error of the path check | `Lstat` of a path component, or `EvalSymlinks` of the parent or the components root, failed with an error other than not-exist. |
| `plugin_develop`, `sidecar_develop`, `plugin_remove`, `sidecar_remove` | `install.transaction.pluginManifestInvalid` (`plugin`) | Dependency validation of the resulting environment: a `registry` or `local` Plugin record's `plugin.json` is missing, cannot be read or parsed, or does not declare the record's id and version. In `plugin_remove` and `sidecar_remove` after the path check and before any file operation. |
| `plugin_develop`, `sidecar_develop`, `plugin_remove`, `sidecar_remove` | `install.transaction.dependencyVersionConflict` (`plugin`, `kind`, `dependency`, `required`, `requested`) | Dependency validation of the resulting environment: a Plugin manifest's `runtimeDependencies` entry has no record at exactly that version; in `plugin_remove` and `sidecar_remove`, a remaining Plugin requires the removed record. `requested` is `missing` for an absent or broken record, otherwise the effective version found. |
| `plugin_remove`, `sidecar_remove` | `environment.remove.artifactDeleteFailed` (`path`, `error`) | `RemoveAll(<dir>.removing)` before the rename failed; `path` is `<dir>.removing`. Nothing changed. A failed final deletion is data on the result, not a refusal. |
| `plugin_remove`, `sidecar_remove` | non-key os error of the rename | `Lstat(<dir>)` failed with an error other than not-exist, or the rename of `<dir>` to `<dir>.removing` failed. |
| `plugin_enabled_set` | non-key `os.ErrInvalid` | A ref with an empty `id` or `version`, or the same `id` twice in `plugins`. |
| `plugin_enabled_set` | non-key `os.ErrNotExist` | No record for a ref `id`, or the ref `version` differs from the effective version (the record's `version` for `registry` and `local`; the manifest version read now for `development`). The version check is skipped for a broken development record with `enabled` `false`. |
| `plugin_enabled_set` | `environment.develop.directoryUnavailable` (`kind` `plugin`, `id`, `path`, `error`) | `enabled` `true` and the development Plugin's `plugin.json` is missing, cannot be read or parsed, or declares another id. `enabled` `false` on that record succeeds. |
| `plugin_develop`, `sidecar_develop`, `plugin_remove`, `sidecar_remove`, `plugin_enabled_set` | non-key `ErrRevisionConflict` (`Expected`, `Actual`) | `expectedRevision` differs from the current revision. |
| `plugin_develop`, `sidecar_develop`, `plugin_remove`, `sidecar_remove`, `plugin_enabled_set` | non-key `platformspec` validation error | `Validate` refuses the resulting environment, e.g. `plugin <id>: component requires exact version and absolute path` when a development `plugin.json` `version` is not strict SemVer. |
| `plugin_develop`, `sidecar_develop`, `plugin_remove`, `sidecar_remove`, `plugin_enabled_set` | `environment.home.absolute` | The environment home is not absolute. |
| `plugin_develop`, `sidecar_develop`, `plugin_remove`, `sidecar_remove`, `plugin_enabled_set` | non-key os error of the publish | `MkdirAll`, `WriteFile`, or `Rename` failed while publishing `environment.json`. |
| `sidecar_open` (Sidecar resolution) | non-key `os.ErrNotExist` | No record for the consumer Plugin or the Sidecar id, or the requested version differs from the effective version. |
| `sidecar_open` (Sidecar resolution) | `environment.develop.directoryUnavailable` (`kind`, `id`, `path`, `error`) | The consumer Plugin record or the Sidecar record is a broken development record. |
| `sidecar_open` (Sidecar resolution) | non-key `os.ErrInvalid` | A `registry` or `local` Sidecar record whose `sidecar.json` is missing, cannot be read, is refused by the spec parser, or does not declare the record's id and version. |
| `sidecar_open` (Sidecar resolution) | non-key `os.ErrNotExist`, `os.ErrInvalid`, or another `Lstat` error | Process-file check of `dist/<id>`, as in `sidecar_develop`. |

`plugin_remove` and `sidecar_remove` rename `<dir>.removing` back to `<dir>` before returning any
error of the four write rows; when that rename fails the error is `errors.Join(write error, rename
error)`. `plugin_enabled_set` runs no dependency validation: enabled state is not part of the
dependency invariant.

## Commands and events

- `environment_get` reads the complete runtime selection.
- `plugin_manifest_list` lists every Plugin record with its manifest text, or with `error` for a
  broken record.
- `plugin_enabled_set` changes Plugin activation by compare-and-swap. `enabled` `true` requires the
  effective version of every named Plugin; `enabled` `false` does not.
- `plugin_develop` and `sidecar_develop` (`id`, `path`, `expectedRevision`) register a development
  record by compare-and-swap.
- `plugin_remove` and `sidecar_remove` (`id`, `expectedRevision`) remove one record by
  compare-and-swap and apply the removal rule above.
- `artifact_install_begin`, `artifact_install_stage`, `artifact_install_read_utf8`,
  `artifact_install_commit`, and `artifact_install_rollback` implement the shared transaction.
- `artifact_install_status` and `artifact_install_wait` expose event-driven progress.
- `artifact.install.progress` reports phase changes; `environment.changed` reports one committed
  revision.

There is no `source_set`, raw-path install, compatibility reader, fallback transport, install
profile, stored dependency closure, or second installer.
