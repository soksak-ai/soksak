# Environment and installation

The public JSON shape belongs to `soksak-spec`. This document defines Core runtime state and the
installer transaction. Canonical build, local-store, and GitHub publication rules are in the spec
package's `docs/BUILD-AND-RELEASE.md`.

## Environment

The environment records only Plugin and Sidecar runtime selections.
`<identity-home>/environment.json` is the only persistent runtime-component state. It contains one
monotonic `revision`, Plugin records, and Sidecar records. A Plugin record contains its exact
version, materialized absolute path, source (`local` or `registry`), artifact SHA-256, and enabled
state. A Sidecar record contains the same fields except enabled state and adds its target triple.

Kit, Contract, and Spec are build or validation inputs. Their exact release references remain in
release documents and candidate build receipts; Core does not copy them into runtime state. Runtime
dependencies remain in Plugin releases. The environment stores no repository, source commit, URL,
size, dependency closure, or role binding.

Core creates revision 1 after acquiring the identity home. Missing or invalid state is a boot error,
not an implicit empty state. Every change uses compare-and-swap and emits one `environment.changed`
event. No caller polls the file.

## One release contract, two transports

Local and registry releases use the same closure resolver and installer transaction. Both carry the
same public release documents, manifests, permissions, entrypoints, sizes, and SHA-256 values. HTTPS
and an explicitly addressed local release store differ only in how the approved bytes are read. Raw
Raw source paths are never installation inputs. Core never discovers a repository through `../`, an
injected workspace root, `PATH`, checkout layout, or a symbolic link.

If an exact dependency version exists in the addressed local store, its release and asset bytes must
match the parent's URL, size, and SHA-256. A corrupt or mismatched local release is an error; Core does
not fall back to the network. A missing local dependency may use the exact HTTPS reference declared
by its parent release.

## Installer transaction

The installer resolves the complete Plugin/Sidecar runtime closure, selects the host target, verifies
every size and SHA-256, extracts regular files only, validates manifests, and stages every component
before changing runtime state. It publishes component directories and `environment.json` in one
transaction. Failure leaves the previous environment and component directories unchanged.

The same id, version, target, and artifact digest is idempotent. The same id, version, and target with
a different digest fails with `VERSION_ARTIFACT_CONFLICT`; Core never overwrites installed bytes. A
Local record is excluded from automatic registry replacement. A registry update may still be shown,
but replacing the Local selection requires an explicit registry install transaction.

A running or recorded Sidecar is not stopped by installation. Selecting different Sidecar bytes
requires an explicit lifecycle operation; Core does not terminate a user's restorable process to
complete an update.

## Commands and events

- `environment_get` reads the complete runtime selection.
- `plugin_enabled_set` changes Plugin activation by compare-and-swap.
- `artifact_install_begin`, `artifact_install_stage`, `artifact_install_read_utf8`,
  `artifact_install_commit`, and `artifact_install_rollback` implement the shared transaction.
- `artifact_install_status` and `artifact_install_wait` expose event-driven progress.
- `artifact.install.progress` reports phase changes; `environment.changed` reports one committed
  revision.

There is no `source_set`, raw-path install, compatibility reader, fallback transport, install
profile, stored dependency closure, or second installer.
