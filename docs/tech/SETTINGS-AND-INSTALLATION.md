# Settings and installation

Public JSON shapes are owned by `soksak-spec`. This document defines Core behavior.
Release identity, archive validation, and immutable-version handling are defined in
[RELEASE-INTEGRITY.md](./RELEASE-INTEGRITY.md).

## Settings

`<identity-home>/settings.json` contains user choices only: plugin activation, optional development paths, and selected sidecar IDs for named plugin requirements. It uses direct `plugins`, `sidecars`, `kits`, `contracts`, and `specs` maps and a monotonic `revision`. A change uses compare-and-swap and publishes one `settings.changed` event. Polling is not used.

## Installed state

`<identity-home>/installed.json` contains installation results only: exact ID and version, target and absolute path, registry and source repository, exact source commit, and manifest and artifact SHA-256. Installation advances its own `revision` and publishes `installed.changed`. Activation and provider selection are not copied into this file.

## Installer

The installer reads one certified registry release, selects the current target artifact, downloads the declared byte size, verifies SHA-256, extracts regular files only, validates the manifest, and atomically publishes the directory and installed record. Failure leaves the previous installed state unchanged.

Release documents contain no dependency scope or provider choice. Installing a plugin does not silently activate it or select a sidecar. Those are explicit settings operations.

## Development

A development path replaces only the source path for that ID and prevents managed updates for that ID. Its manifest still passes identity, app version, interface, permission, and path validation. No separate boolean is stored beside the path.

## Commands

- `settings_get` and `installed_get` expose the two documents.
- `plugin_enabled_set` changes plugin activation.
- `plugin_provider_set` changes one selected sidecar.
- Kind-specific `development_set` commands change development paths.
- `artifact_install_begin`, `artifact_install_stage`, `artifact_install_read_utf8`, `artifact_install_commit`, and `artifact_install_rollback` implement atomic installation.

There is no public unit, install profile, dependency closure, composition graph, execution graph, or deployment graph.
