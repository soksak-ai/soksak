---
kind: canonical
status: active
canonical: self
---

# Repository governance

## G1. Local source is canonical

The active source in each canonical workspace checkout defines the current product. Historical GitHub
branches, tags, releases, and framework implementations do not impose compatibility on it. A current
contract accepts only its canonical shape.

## G2. Independent repositories

An independently owned product repository has one development line, main. Every change branch is
audited patch by patch, verified against its owner's gate, and then either fast-forwarded to main
or rejected with its reason. A merged branch is deleted only after its tip is reachable from main.
An independently released library may retain a version maintenance branch when that branch is a
supported source line rather than a completed change branch. Its name carries the library version,
and its tip remains reachable from a permanent local and remote ref.

## G3. Forks

A fork keeps the upstream default branch for upstream synchronization. Soksak improvements remain on
a separate branch and are never merged into that default branch merely to simplify branch lists. The
branch name carries the upstream component version; when upstream publishes no version, it carries the
exact source commit. Consumers pin the exact improvement commit. An upstream version change creates a
newly verified improvement line, and an upstreamable change is proposed upstream.

## G4. Historical repositories

A retired framework implementation is source history, not a release target. Its repository is archived;
existing commits, improvement branches, tags, and releases remain readable. It runs no Actions and gains
no new tag, release, compatibility patch, or migration. Current products do not register it as installable.

## G5. No source loss

Before a branch, repository name, or worktree is removed, every tip must have a permanent retained ref:
the canonical branch, a versioned fork-improvement branch, a historical repository branch, or a non-release
archive/ tag. Patch equivalence permits deleting a duplicate branch only when the exact source tip is
retained elsewhere or intentionally recorded by an archive/ ref. Product release workflows trigger only
on v*; an archive/ tag never publishes a product.

## G6. Standards do not move to meet an implementation

When a gate fails, the implementation, fixture, dependency, or automation is corrected. The criterion is
not weakened to make the failure pass. If evidence shows the criterion itself is wrong, the conflict is
reported first and the document and its RED are changed together before implementation resumes.
