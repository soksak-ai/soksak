---
kind: canonical
status: active
canonical: self
---

# Installation settings

The public schema is owned by soksak-contract-composition@0.0.1. This document defines how the
Soksak product uses it. It does not duplicate the schema.

## C1. Plugin is the user-facing product

The official catalogue is soksak-ai/soksak-plugin-registry. A user selects plugins. A plugin
release may depend on sidecars and kits; the installer resolves and installs that closure.

Sidecars and runtime kits are visible dependencies, not independent catalogue products. Two
plugins that require the same id and version share one installed sidecar or kit. A build dependency
is used to produce an artifact and is not installed separately. Contracts and specifications are
versioned references and conformance material, not installed software. Wails services are core
build components.

## C2. One settings file

The installation record is `<identity-home>/settings.json`. The release identity therefore uses
`~/.soksak/settings.json`; development and test identities use their own homes.

The file has separate `plugins`, `sidecars` and `kits` arrays. Each entry records id, version,
enabled state, development mode, absolute install path, manifest path and acquisition source.
Source and development mode are independent:

- source records a Git commit, a SHA-256-pinned archive or an absolute local path;
- `development: true` means development mode and disables updates for that entry;
- changing development mode does not change enabled state;
- the plugin enabled selection is stored here, not in browser storage.

Sidecars and kits become active only through enabled plugin dependencies or bindings. A plugin
command does not expose a generic `kind` parameter; plugin, sidecar and kit commands name their
target type directly.

`.soksak.json`, `config/development-units.json`, browser-storage enabled ids and directory presence
are not installation records. This build does not read them and has no compatibility reader or
migration.

## C3. Manifests and bindings

No common `soksak-unit.json` exists. Each type keeps its existing manifest:

- a plugin uses `plugin.json`;
- a sidecar uses its release or interface manifest;
- a kit uses its package manifest.

The settings entry records that manifest's relative path. The owner repository validates its own
manifest and artifact. Installation provenance and dependency resolution remain in signed release
documents and settings rather than being copied into another manifest.

A named consumer requirement is connected to one provider id and version by `settings.json.bindings`. No
provider is selected by folder order, install order, name convention or fallback.

## C4. Installer

The installer is a core service. It knows no plugin, sidecar or kit implementation and no build
tool.

1. The catalogue verifies the signed registry sequence, expiry, owner release manifest,
   conformance reports and artifact digests.
2. The installer resolves the plugin dependency closure for the host target.
3. It downloads a digest-pinned archive into transaction-owned staging.
4. It rejects symbolic links, path escape, undeclared entrypoints, identity mismatch and digest
   mismatch.
5. It publishes regular files at the declared absolute install paths.
6. It replaces settings with generation compare-and-swap and advances generation by one.
7. The resolver reads the new graph and the core emits one `composition.changed` event.

The internal transaction commands are `artifact_install_begin`, `artifact_install_stage`,
`artifact_install_read_utf8`, `artifact_install_commit` and `artifact_install_rollback`. The commit
payload has separate plugin, sidecar and kit arrays. `plugin_enabled_set` changes plugin enabled
state with one generation compare-and-swap. Development commands use the same generation rule.
Polling is not used.

Provider SDKs and language-specific build rules remain inside their owner repositories. They are
not installer inputs.

## C5. Resolver and failure isolation

The resolver publishes separate plugin, sidecar and kit states, bindings, issues, enabled state and
development mode.
The authoritative commands are composition_settings, composition_graph and composition_status.

Invalid settings syntax is a document-level failure. A missing manifest, dependency, binding,
provider or required contract match rejects the affected entry and its dependents. Unrelated
entries remain available. A rejected record is not rewritten and no substitute provider is
selected.

## C6. Loader boundary

Plugin, sidecar and kit loaders consume only settings and the resolved graph. They do not scan fixed
plugin or sidecar directories and do not read sibling source repositories. The plugin loader reads
only the declared absolute path and manifest, and rejects an id or version mismatch. Enabled state
is restored from settings. A `composition.changed` subscription reloads each window; events received
during a reload are combined by generation rather than polled.

Each repository still owns its tests:

- core tests generic installer, resolver, loader, command, status and DOM interfaces;
- each plugin tests its renderer, input, IME, commands, status, DOM and declared integrations;
- each sidecar tests its adapter, recovery, performance and release artifact;
- contract repositories own schemas and conformance cases;
- kit repositories own shared runtime tests;
- the external terminal system test owns the six-provider and seven-plugin installed-product test.

Gate: the composition contract rejects implicit providers, relative paths, unpinned sources and
invalid selections. Core tests reject missing settings, symbolic-link install paths, stale
generations and manifest identity mismatches, and expose one generation through the settings,
graph and status commands.
