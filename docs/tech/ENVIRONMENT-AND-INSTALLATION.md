# Environment and installation

The public JSON shape is owned by `soksak-spec`. This document defines Core behavior.
Release identity, archive validation, and immutable-version handling are defined in
[RELEASE-INTEGRITY.md](./RELEASE-INTEGRITY.md).

## Environment

`<identity-home>/environment.json` is the single local component state. Each plugin, sidecar, kit,
contract, and spec records its exact selected version, absolute local path, source kind, registry ID
for managed content, and target where applicable. Plugin entries also record activation and sidecar
role bindings. One monotonic `revision` covers the whole environment. A change uses compare-and-swap and
publishes one `environment.changed` event. Polling is not used.
Core atomically creates revision 1 immediately after it acquires the identity home. Absence is
therefore a boot failure, not a synthetic empty environment; the first compare-and-swap uses the
revision returned by `environment_get`, exactly like every later write.

Remote repository, source commit, dependency, URL, size, and digest facts remain in the registry
release. The environment never copies them. No other persistent local component document or
dependency lock exists.

## Installer

The Core installer reads a certified plugin, sidecar, or directly requested kit release, selects the current target artifact,
downloads the declared byte size, verifies SHA-256, extracts regular files only, validates the
manifest, and atomically publishes the directories and environment. A plugin installation also
installs its exact plugin dependencies and the sidecar IDs selected for its named requirements in
the same transaction. An already materialized exact dependency is shared. Failure leaves the previous
environment unchanged. The write lock exists only for the transaction.

Kit releases distribute reusable implementation source and are not implicit plugin runtime
dependencies. A future runtime kit dependency must first be declared by the public plugin spec;
the installer does not infer one. Contract and spec releases are validation inputs. They are published and registered independently,
but are not copied into the runtime installation directory. Development paths for contracts and specs
support authoring and validation; they do not turn those documents into runtime processes.

Release documents contain no dependency scope or sidecar role binding. Installing a plugin does not
silently activate it. Sidecar role bindings are explicit environment operations committed with the installation.

## Development

A development source replaces the versioned source and absolute path for that ID and prevents managed
updates for that ID. Its manifest still passes identity, app version, interface, permission, and path
validation. No separate boolean is stored beside the source.

`environment.json` is the only local runtime discovery surface. Core and components do not discover
another repository through `../`, an injected repository root, workspace checkout layout, PATH, or a
symbolic link. Build relationships use package dependencies; runtime relationships use component IDs
resolved through the environment; remote bytes use registry releases.

Concrete future features are not prebuilt. Complete rules, state axes, ownership boundaries, and
transparent command, status, event, and DOM interfaces are established before implementations depend
on them. The environment therefore exposes plugin, sidecar, kit, contract, and spec sources now; that
is platform state, not a speculative feature.

## Commands

- `environment_get` exposes the environment.
- `plugin_enabled_set` changes plugin activation.
- `plugin_sidecar_set` changes one sidecar role binding.
- Kind-specific `source_set` commands replace a component's exact source and local path.
- `artifact_install_begin`, `artifact_install_stage`, `artifact_install_read_utf8`, `artifact_install_commit`, and `artifact_install_rollback` implement atomic installation.

There is no public unit, install profile, dependency closure, composition graph, execution graph, or deployment graph.
