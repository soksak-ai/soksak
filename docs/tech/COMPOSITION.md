---
kind: canonical
status: active
canonical: self
---

# Installation composition

The public schema is owned by soksak-contract-composition@0.0.1. This document defines how the
Soksak product uses it. It does not duplicate the schema.

## C1. Plugin is the user-facing unit

The official catalogue is soksak-ai/soksak-plugin-registry. A user selects plugins. A plugin
release may depend on sidecars and kits; the installer resolves and installs that closure.

Sidecars and runtime kits are visible dependency nodes, not independent catalogue products. Two
plugins that reference the same exact sidecar or runtime kit share one installed node. Build-time
kits are bundled or linked into the owner artifact and are not installed separately. Contracts and
specifications are exact manifest references plus certified conformance reports, not runtime
installations. Wails services are core build components and are not registry units.

## C2. One installation record

The composition record is identity-home/settings.json. The release identity therefore uses
~/.soksak/settings.json; development and gate identities use their own homes.

Each installed plugin, sidecar and kit records exact identity, absolute install path, unit manifest
path, acquisition source and update mode. Source and mode are independent:

- source records an exact Git commit, a SHA-256-pinned archive or an absolute local path;
- mode is installed or development;
- a development unit is never written by the updater and is reported as development in status and
  UI;
- switching mode preserves source provenance.

The record has one explicit enabled selection per installed plugin. Sidecars and kits become active
only through enabled plugin dependency or binding edges.

.soksak.json, config/development-units.json, frontend localStorage enabled ids and directory
presence are not composition records. They are removed when the installer and loaders use this
contract; no compatibility reader or migration is retained.

## C3. Unit declaration

Every install path contains soksak-unit.json. It declares exact unit identity, exact unit
dependencies, exact contracts implemented, named contract requirements consumed and relative
entrypoints. A plugin-specific manifest remains the plugin runtime entrypoint and does not duplicate
installation provenance or dependency resolution.

A named consumer requirement is connected to one exact provider by settings.json.bindings. No
provider is selected by folder order, install order, name convention or fallback.

## C4. Installer

The generic installer is a core service. It knows no unit implementation and no build tool.

1. The catalogue verifies the signed registry sequence, expiry, owner release manifest,
   conformance reports and artifact digests.
2. The installer resolves the plugin dependency closure for the host target.
3. It downloads an archive or clones an exact Git commit into transaction-owned staging.
4. It rejects symbolic links, path escape, undeclared entrypoints, identity mismatch and digest
   mismatch.
5. It publishes regular files at the declared absolute install paths.
6. It replaces settings with generation compare-and-swap and advances generation by one.
7. The resolver reads the new graph and the core emits one composition.changed event.

The five transaction commands are unit_install_begin, unit_install_stage, unit_install_read_utf8,
unit_install_commit and unit_install_rollback. Update, uninstall, development selection and plugin
enablement use the same settings transaction. Polling is not used.

Provider SDKs, Cargo, Zig, Go build rules and repository workspace paths remain inside their owner
repositories. They are not installer inputs.

## C5. Resolver and failure isolation

The resolver publishes nodes, dependency and binding edges, issues, active state and update mode.
The authoritative commands are composition_settings, composition_graph and composition_status.

Invalid settings syntax is a document-level failure. A missing or invalid unit manifest, dependency,
binding, provider, exact contract match or dependency cycle rejects that node and its dependents.
Unrelated nodes remain resolved. A rejected record is not rewritten and no substitute provider is
selected.

## C6. Loader boundary

Plugin, sidecar and kit loaders consume only the resolved graph. They do not scan fixed plugin or
sidecar directories and do not read sibling source repositories. Tests use a settings composition
and installed artifacts exactly as the application does.

Each repository still owns its tests:

- core tests generic installer, resolver, loader, command, status and DOM interfaces;
- each plugin tests its renderer, input, IME, commands, status, DOM and declared integrations;
- each sidecar tests its adapter, recovery, performance and release artifact;
- contract repositories own schemas and conformance cases;
- kit repositories own shared runtime tests;
- the terminal product composition owns the exact six-provider and seven-plugin coexistence fleet.

Gate: composition contract tests reject ranges, implicit providers, relative paths, unpinned
sources, cycles and invalid root selections. Core composition tests reject missing settings and
symbolic-link install paths and expose one graph generation through all three commands.
