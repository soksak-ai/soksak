---
kind: canonical
status: active
canonical: self
---

# Build toolchain

This document defines build-tool ownership, discovery, preparation and upgrade rules. A tool
version is declared by its owning ecosystem. Tests, commands, workflows and container definitions
derive that declaration; they do not copy the version.

## Invariants

- **BT1 — One owner.** Each version has one owning manifest. Other required ecosystem fields are
  projections and must equal their owner.
- **BT2 — Required platform policy.** Local verification on Apple Silicon requires
  `darwin/arm64`. A translated child process reporting `uname -m=x86_64` cannot change that policy.
- **BT3 — Actual execution axes.** Node reports `process.platform/process.arch`; Go reports
  `GOHOSTOS/GOHOSTARCH`; Wails is the module-owned Go tool; product, CLI, test application, sidecar
  and native-library architectures come from their binary header or runtime status.
- **BT4 — Every axis must match.** Any difference between the required platform and an actual axis
  is `TOOLCHAIN_MISMATCH`, exit 78. Physical arm64 with x64 Node or Go is not accepted.
- **BT5 — Preconditions precede products.** No build, product test or product RED starts before
  BT1–BT4 are GREEN. An ambient or stale binary is never a test input.
- **BT6 — Separate public facts.** Evidence reports `required`, `nodeRuntime`, `goRuntime`,
  `wailsVersion`, and artifact/runtime architectures separately. One `runtime` field cannot merge
  these axes.
- **BT7 — No ambient path.** Global Wails or Task executables, fallback binaries, absolute source
  paths and automatic architecture substitution are forbidden. Failure to select the declaration
  is a refusal, not a search for another installation.
- **BT8 — Upgrade transaction.** An upgrade changes the owner, every projection, locks, CI inputs
  and artifact matrix in one verified change. Test fixtures contain no current version literals.
- **BT9 — Repository ownership.** Core verifies Core, CLI and framework boundaries. Each component
  verifies its own artifact. The terminal system-test repository verifies the architecture and
  coexistence of an installed multi-component fleet.

## Version owners

| Tool or state | Owner | Projection or consumer |
| --- | --- | --- |
| Go language version | `go.mod` `go` directive | Go's toolchain selection |
| Wails CLI | `go.mod` Wails requirement plus `tool github.com/wailsapp/wails/v3/cmd/wails3` | `go tool wails3` |
| Node runtime | `.node-version` | `frontend/package.json` `engines.node`, CI setup and container build arguments |
| pnpm | `frontend/package.json` `packageManager` | pnpm selection in the frontend package and CI |
| Frontend dependency bytes | `frontend/pnpm-lock.yaml` | serialized dependency preparation |
| Task runner | the Wails CLI selected by `go.mod` | `go tool wails3 task` |

The Node engine is a required ecosystem projection of `.node-version`, not a second owner. The
preflight rejects a difference before executing a product test. Wails includes its Task runner;
there is no independent `.task-version`, global Task requirement or Task version comparison.

## Discovery and execution

The repository never records an installed tool path. A developer or CI environment selects the
Node version declared by `.node-version` and the Go version declared by `go.mod`. On Apple Silicon,
platform policy establishes `required=darwin/arm64`; a translated amd64 parent process cannot
change it. The preflight compares that requirement separately with Node, Go and Wails runtimes.
The native frontend package is selected by the actual Node process and must also equal the required
platform. Physical arm64 alone never permits an x64 process or package.

Wails is not discovered from `PATH`. Go builds and executes the tool registered by `go.mod`:

```sh
scripts/ci/prepare-frontend-dependencies.sh
scripts/ci/check-build-toolchain.sh
go tool wails3 task verify
go tool wails3 dev
```

`WAILS3` overrides, a global `wails3`, a separately installed Task binary and versioned tool paths
in scripts are forbidden. An absolute workstation path may appear in an evidence record as the
observed executable, but never in source, a lockfile, a workflow or a release artifact.

## Preparation boundary

Toolchain inspection and dependency preparation are separate operations.

1. `prepare-frontend-dependencies.sh` first runs the read-only frontend tool check.
2. Preparation obtains the repository dependency-owner lock and materializes
   the exact frozen lockfile.
3. `check-build-toolchain.sh` verifies the materialized native package, Go host toolchain and the
   selected module-owned Wails binary.
4. Product gates may start only after all three conditions pass.

`TOOLCHAIN_MISMATCH` and an invalid declaration exit 78. `DEPENDENCY_STATE_INVALID` exits 79. Neither
is product RED. Cache deletion, an unowned package install, a fallback binary or a test skip cannot
change that classification.

## Upgrade transaction

A tool upgrade changes its owner declaration first and every required projection in the same
change. Tests read those declarations and therefore do not change merely because a version changes.

- A Node upgrade changes `.node-version` and its `engines.node` projection, then rematerializes and
  verifies the frontend lock on every supported architecture.
- A pnpm upgrade changes `packageManager` and the lockfile produced by that exact pnpm version.
- A Wails upgrade changes the `go.mod` module requirement. `go mod tidy` updates the module/tool
  closure; local tasks, CI and container execution continue to use `go tool wails3`.
- A Go upgrade changes the `go` directive and reruns every host and cross-compilation gate.

An upgrade is incomplete while a script, workflow, Dockerfile, test fixture or document carries an
independent version literal.

## Gates

`internal/repositorygate/build_toolchain_owner_test.go` rejects duplicate owners, ambient Wails or
Task executables, missing Go tool registration and Node selector drift.
`internal/repositorygate/frontend_toolchain_preflight_gate_test.go` verifies the read-only/preparation
split, proves pnpm is resolved from the frontend package that owns its declaration, rejects a
translated amd64 Go runtime and exposes required, Node, Go and Wails architecture axes separately.
