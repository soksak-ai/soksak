# CI Status Ledger

This ledger records which gates run remotely versus locally, so no gate is
silently claimed as live before it has executed. It exists because the
audit found "CI≡verify" and "3-OS check" recorded as met while the remote
runner had executed zero times.

## Current state

| Gate | Local | Remote (GitHub Actions) |
|---|---|---|
| `make verify` (spec-gate, C1 scan, baseline, tsc, cargo, vitest) | green | mirrored by `verify.yml`, **0 runs** |
| 3-OS `cargo check` (macOS / Ubuntu / Windows) | macOS only | `multiplatform-check.yml`, **0 runs** |

`verify.yml` and `multiplatform-check.yml` are committed but have never
executed. They run only after the branch is pushed and the
`CI_REPO_TOKEN` secret is provisioned (the workflows read a private
sibling crate). Until then their result is **unknown, not green**.

## Deferred, not silently dropped

- **Remote `make verify` mirror** — pending push + `CI_REPO_TOKEN`. Local
  `make verify` is the standing gate; the remote run is a mirror, not a
  new source of truth.
- **Windows and Linux `cargo check`** — the matrix measures them, but no
  RED baseline exists yet because the runner has not executed. The first
  run produces that baseline. The core currently compiles on macOS only;
  the platform gap is real and lands in P3 (Windows boot), not P0.

## Release condition

P0 does not claim "CI live" or "3-OS measured" as met. It claims: the
mirror and the matrix are wired and will produce their first verdicts on
the first pushed run. The user owns the push and the secret.
