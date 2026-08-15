---
kind: guide
status: active
canonical: self
---

# Development

Korean edition: [`DEVELOPMENT_KO.md`](DEVELOPMENT_KO.md). English is canonical.

How work proceeds here. The contracts are in `docs/tech`; this is the procedure around them.

## D1. Before changing anything

Read the canonical document for the area (`docs/README.md` says which), then the code it points at.
A rule usually carries the measurement that produced it, with a date.

## D2. Order of a change

1. A reproducing test, red.
2. The change, green.
3. The document, in the same commit as the rule it describes.

Commit prefixes: `test:`, `fix:`, `feat:`, `docs:`, `chore:`. One commit is one verified contract,
not one step of the work.

## D3. Every commit clears every gate

`task verify` (see TESTING.md). Gates only increase, and a commit that has not cleared them does not
land.

## D4. No compatibility layers

There is no shipped user. An old path is deleted, not kept beside the new one. Migration code,
fallbacks and dual paths are how two behaviours end up in one build with nobody able to say which
one ran.

## D5. The simplest thing that satisfies the requirement now

No abstraction, configuration or indirection for a future that has not arrived. Prefer a dependency
that is already present over a new one, and a maintained library over writing it again — but check
what the library actually does before assuming it lacks a feature.

## D6. Delete failed attempts

An attempt that did not reach its standard is removed with a commit that says so. The next attempt
starts from the last verified point, not on top of the failure.

## D7. Reverting

Before reverting, ask whether the change is harmful. If it is, revert it now. If it is not, ask
whether it is correct. Incorrect or unnecessary: remove it. Correct but unrelated to the work in
hand: keep it, and commit it separately with its real reason. A record that attributes an unrelated
change to this work is a false record.

## D8. No throwaway scripts

Anything needed to check something is a `sok` command or a test under version control. A script that
runs once is a check nobody can repeat.

## D9. Prose

Comments, commit messages and user-facing text: dry, short, exact. No metaphor, no personification.
Comments are English; only text shown to a person is Korean.

**Gates.** `prose_gate_test.go` (documents), `frontend/src/commands/refusalMessages.test.ts`
(user-facing strings: no internal vocabulary, no metaphor, never a dead end).

## D10. The record keeps reasons and drops sources

A comment says why a rule exists and what was measured. It does not say which other codebase the
measurement came from.

**Gate.** `provenance_gate_test.go`.
