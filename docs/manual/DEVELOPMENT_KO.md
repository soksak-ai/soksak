---
kind: guide
status: active
canonical: DEVELOPMENT.md
---

# Development

English canonical: [`DEVELOPMENT.md`](DEVELOPMENT.md). Where the two differ, English wins.

How work proceeds here. The contracts are in `docs/tech`, and this document is the procedure around them.

## D1. Before fixing anything

Read the canonical document for the area (`docs/README.md` reports which one). Then read the code that document
points at. A rule usually has the measurement that produced it attached, with a date.

## D2. The order of a change

1. A test that reproduces it, RED.
2. Change, GREEN.
3. Documentation. In the same commit as the rule it describes.

Commit prefixes: `test:`·`fix:`·`feat:`·`docs:`·`chore:`. One commit is one verified contract, not one step
of the work.

## D3. Every commit passes every gate

`task verify` (TESTING.md). Gates only increase, and a commit that has not cleared them does not land.

## D4. No compatibility layer

There is no shipped user. An old path is deleted, not kept beside the new one. Migration code, fallbacks and dual paths
are how two behaviours end up in one build with nobody able to say which one ran.

## D5. The simplest thing that meets the requirement now

No abstraction, configuration or indirection layer for a future that has not arrived. Prefer a dependency already present over a new one,
a maintained library over writing it again. But before concluding that the library lacks the feature,
Verify it for real before that.

## D6. A failed attempt is deleted

An attempt that did not reach its standard is removed with a commit that states so. The next attempt starts not on top of the failure but from the last
verified point.

## D7. Revert

Before reverting, the first test is whether it is harmful. If it is, revert it now. If not, the test is whether the change itself
check whether the change itself is right. Wrong or unnecessary: remove it. Right but unrelated to the work in hand: keep it, and for its real reason
commit it separately. A record that attributes an unrelated change to this work is a false record.

## D8. No throwaway script

Anything needed to check something is a `sok` command or a test under version control. A script that runs once
A script is a check nobody can repeat.

## D9. Sentences

Comments·commit messages·text that goes to a person: dry, short, exact. No metaphor and no personification.
Comments are English, and only text shown to a person is Korean.

**Gate.** `prose_gate_test.go`(documents), `frontend/src/commands/refusalMessages.test.ts`(user
strings — no internal vocabulary, no metaphor, no dead-end sentence).

## D10. The record keeps the evidence and drops the source

A comment records why a rule exists and what was measured. Which other codebase the measurement came from is
not recorded.

**Gate.** `provenance_gate_test.go`.
