---
kind: changelog
status: historical
canonical: docs/tech/ENVIRONMENT-AND-INSTALLATION.md
---

# Environment and installation design flow

The current contract is [ENVIRONMENT-AND-INSTALLATION.md](./ENVIRONMENT-AND-INSTALLATION.md).

## Why two local records failed

Local component state was split between `settings.json` and `installed.json`. Activation and role
selection lived in one revision while installed paths and versions lived in another. A crash or a
concurrent update could publish one half without the other, leaving a selection that named content
the runtime could not open. Readers also had to merge two authorities before answering a simple
question: “what exact component will run?”

## One atomic environment

`environment.json` became the only persistent local component state. One revision now contains the
selected exact versions, absolute local paths, source kinds, activation, targets, and plugin-to-
sidecar role bindings. Installation stages bytes first and replaces the component directories and
environment in one transaction. Failure leaves the prior environment unchanged.

The registry remains the authority for remote provenance and immutable release metadata. The local
environment stores only what this installation selected and where those verified bytes are located.

## Evidence

The environment contract gate rejects the retired filenames and command surfaces in active code and
canonical documents. Transaction tests prove that failed installation cannot publish a partial
environment.

## Why a virtual first revision failed

The first implementation returned an in-memory revision 1 when `environment.json` did not exist,
while compare-and-swap correctly observed the stored revision as 0. The first installation could
therefore only fail with `expected 1, actual 0`. Core now publishes the real revision 1 after it
owns the identity home; reads and writes share one state instead of assigning two meanings to
absence.
