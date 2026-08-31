---
kind: canonical
status: active
canonical: self
---

# Repository governance

## G1. Local source is canonical

The active source in each canonical workspace checkout defines the current product. Historical refs,
releases, and paused components do not change the current contract. A current contract accepts only
its canonical shape.

## G2. Independent repositories

An independently owned product repository has one development line, main. Every change branch is
audited patch by patch, verified against its owner's gate, and then either fast-forwarded to main
or rejected with its reason. A merged branch is deleted only after its tip is reachable from main.
An independently released library may retain a version maintenance branch when that branch is a
supported source line rather than a completed change branch. Its name includes the library version,
and its tip remains reachable from a permanent local and remote ref.

## G3. Versioned product lines

Each independently released component has one declared source line for each supported version. The
version is recorded in its manifest and release artifact. Consumers select a version through their
environment manifest; a new release does not alter an installed environment.

## G3a. Preserved provider sources

Provider source trees retained for build or audit use are stored under `forks/` with an explicit source
revision. They are inputs, not product owners, and no product description attributes current behavior to them.

## G3b. Historical source

Completed source retained only for audit is stored under `archive/` or a permanent historical ref. It is
excluded from builds and does not change the active product contract.

## G4. Paused repositories

A paused component remains available for source inspection and its existing release artifacts remain
readable. While paused, it receives no source change, release, compatibility patch, or migration. Current
products do not register a paused component as installable.

## G5. No source loss

Before a branch, repository name, or worktree is removed, every tip must have a permanent retained ref:
the canonical branch, a supported version branch, or a retained historical ref. Patch equivalence permits
deleting a duplicate branch only when the exact source tip is retained elsewhere or intentionally recorded
by a non-release ref. Product release workflows trigger only on declared release tags.

## G6. Standards do not move to meet an implementation

When a gate fails, the implementation, fixture, dependency, or automation is corrected. The criterion is
not weakened to make the failure pass. If evidence shows the criterion itself is wrong, the conflict is
reported first and the document and its RED are changed together before implementation resumes.
