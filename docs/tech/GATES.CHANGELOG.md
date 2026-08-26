---
kind: changelog
status: historical
canonical: docs/tech/GATES.md
---

# Gate ownership changes

The current contract is [GATES.md](GATES.md).

## Installed-product gates left Core

Core once built sibling plugin sources and owned arrangement, drawn-surface, motion, quiet-runtime,
and terminal-fleet system tests. That made checkout topology part of product verification and let
Core restate plugin behavior.

Commit `fde267ac5860b4e9ed7dc4e2abd16bdcc576610f` removed those fixtures when installed-product
verification moved to `min-median-max/soksak-terminal-tests`. Four Taskfile entries remained and
named deleted tests. Go reports a successful package when `-run` matches no test, so those tasks
became false GREENs.

The stale tasks were removed. Core keeps its owner tests and lifecycle restore gate; the external
suite installs immutable releases through Core and owns fleet composition. Frame-by-frame rail and
section motion remains explicitly not done until that suite implements it.

## Evidence

- `TestEveryNamedGoTestTargetExists` fails when Taskfile or CI names a missing Go test.
- `task verify:restore` targets `internal/application` where the lifecycle gate now is defined.
- `scripts/ci/macos-link.sh` targets the existing repository release-workflow test.

## Unanswered compositor commit

The removed drawn-layout gate failed intermittently in a full suite and passed alone. One measured
failure reported `declared 22, committed 21, still dirty`; later failures surfaced only a pending
presentation timeout. The current contract keeps this explicitly incomplete until the installed
suite owns a scenario and native trace that separates delivery, compositor commit, and presentation
receipt.

## Installed native fleet closure

On 2026-08-23 the external suite installed immutable terminal releases from an empty environment
and passed commands, resize, high output, warm restore, archived restore, UI invariants, and
app-owned captures on Windows x86_64, macOS, Linux x86_64, and Linux arm64 in run `32644742653`.

The same Core build freshly installed `soksak-plugin-browser-wails3@0.0.5` from signed registry
sequence 10. Navigation to `https://example.com` reached exact title `Example Domain`; plugin
conformance had zero violations, the plugin host overlay reason was `none`, `ui.verify` passed all
six checks, `state.health` reported zero degraded axes, surface composition was clean, and the
app-owned PNG showed the native page without a blank or error overlay.
