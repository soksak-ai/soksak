---
kind: canonical
status: active
canonical: self
---

# Build toolchain

This document defines build-tool ownership, discovery, preparation and upgrade rules. A tool
version is declared by its owning ecosystem. Tests, commands, workflows and container definitions
derive that declaration; they do not copy the version.

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
Node version declared by `.node-version`. The read-only preflight then verifies exact Node and pnpm
versions, host/runtime architecture, the selected native frontend package and the lock digest.

Wails is not discovered from `PATH`. Go builds and executes the tool registered by `go.mod`:

```sh
scripts/ci/prepare-frontend-dependencies.sh
scripts/ci/check-frontend-toolchain.sh
go tool wails3 task verify
go tool wails3 dev
```

`WAILS3` overrides, a global `wails3`, a separately installed Task binary and versioned tool paths
in scripts are forbidden. An absolute workstation path may appear in an evidence record as the
observed executable, but never in source, a lockfile, a workflow or a release artifact.

## Preparation boundary

Toolchain inspection and dependency preparation are separate operations.

1. `check-frontend-toolchain.sh --toolchain-only` is read-only.
2. `prepare-frontend-dependencies.sh` obtains the repository dependency-owner lock and materializes
   the exact frozen lockfile.
3. `check-frontend-toolchain.sh` verifies the materialized native package.
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
split and proves pnpm is resolved from the frontend package that owns its declaration.
