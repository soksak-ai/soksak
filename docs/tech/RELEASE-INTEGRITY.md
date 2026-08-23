# Release Integrity

This document defines the release and installation invariants for plugins, sidecars, and kits.
The component repository owns its source manifest. `soksak-spec` owns the canonical release
validator. The registry stores validated release metadata. Core installs and verifies release
bytes without knowing provider names.

## One identity source

- `plugin.json`, `sidecar.json`, or `kit.json` is the only source of component id and version.
- Build scripts may project target-specific fields, such as adding `.exe` to a sidecar process.
- Build scripts and workflows must not duplicate an id, version, interface, archive version, or tag.
- Archive names, tags, conformance subjects, and `release.json` identities are derived from the source manifest.

## Verification at both boundaries

Publication and installation enforce the same identity; neither trusts the other boundary.

1. The canonical publisher verifies every archive's manifest id, version, interface, process path,
   target executable, digest, size, and safe regular-file inventory before creating a tag.
2. Core verifies the downloaded digest and size, extracts regular files only, requires the canonical
   manifest name for the component kind, and compares manifest id and version with the registry identity before staging.
3. Commit verifies that the staged identity and digest still equal the approved installation request.
4. Core verifies registry Ed25519 signatures, currentness, and high-water continuity with Go's native
   crypto implementation. Renderer engines parse the public shape but do not own cryptographic trust.

An immutable release with incorrect bytes is never overwritten or migrated. It remains unregistered,
and a new patch version is published after the responsible invariant has a RED test and a GREEN fix.

## Execution preconditions

- CI actions, language toolchains, SDK sources, and reusable workflows use exact commits or versions.
- Text source and module checksum files are checked out with LF on every host; platform checkout
  conversion must not make a source-integrity gate report a false module change.
- A renderer command that delegates to a bounded native operation has an outer deadline longer than
  that native deadline. The transport never reports renderer silence while native work is still live.
- A native system test verifies that its application and control client target the host OS before startup.
  macOS on Apple Silicon may run both arm64 and amd64 binaries; unsupported architecture pairs are rejected.
- Product builds and native tests use the same minimum deployment target.
- A release or system-test run starts only after local contract tests, cross-compilation checks, and release-byte verification pass.
- The macOS Docker preflight verifies Windows build inputs, PE binaries, release bytes, manifests,
  and the staged environment. It does not claim a Windows runtime verdict. WebView2, ConPTY, named pipes,
  and Windows window behavior are verified only on the GitHub `windows-2025` runner.
- Terminal resize failures record the first non-advancing boundary: DOM pixels, requested size, PTY
  observation, recovery observation, or rendered frame. A plain timeout is not sufficient evidence.
- Disk capacity is checked before toolchain installation or multi-target builds. Only regenerable caches
  and build outputs are cleaned; source files and user data are never used as capacity.
- An explicit sidecar stop returns only after an adopted process has exited. Application shutdown
  remains a release, not a stop; the two lifecycle meanings stay separate.

## Repository ownership

- A component repository tests its source manifest, staging projection, target matrix, and release workflow.
- `soksak-spec` tests archive parsing and release identity for every component kind.
- Core tests installation identity, host binary compatibility, and atomic environment publication.
- The external terminal test repository verifies complete released fleets as black-box compositions.
- The registry contains only immutable release documents that pass its contract; failed release versions are not catalogue entries.
- Plugins and sidecars are runtime installation artifacts. Kits distribute reusable implementation
  source and are installed only when explicitly requested; they are not inferred as plugin runtime
  dependencies. Contract and spec releases are validation inputs and are not copied into runtime installation directories.
