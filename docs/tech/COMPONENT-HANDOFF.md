---
kind: canonical
status: active
canonical: self
scope: workspace
---

# Component handoff

Subordinate to [`SESSION.md`](SESSION.md). The subject is the session; a process is what a session
needs to run, and replacing one is a thing that happens to a session rather than a goal of its own.

**Handoff is one way S6 is met and not the only one.** An owner that stores its sessions and
restores them at start meets S6 without any handoff at all: it writes at creation, as the session
runs, and at the stop (S4-2), and the next start stands every session back up. Handoff earns its
place by covering what storing cannot — the session keeps running, so nothing is lost and nothing
is replayed.

**And it covers less.** A descriptor stays open across its process's exit because the kernel holds
a reference to what it names, and a power cycle ends that kernel. Handoff serves a process
replacement on a running machine and nothing beyond it. Storing covers that case and the power
cycle both, which is why the store is the floor and this is the improvement over it.

A sidecar upgrade replaces a running process. What the process holds determines what the
replacement costs. This document defines one declaration every sidecar makes, one check the core
performs before it replaces anything, and what the core does with each result.

Wire definitions belong to each contract repository. Manifest fields belong to `soksak-spec`. This
document defines the axis the two agree on and the core's behaviour, and names the repository that
owns each part.

## H1. One axis, declared per sidecar

A sidecar declares how much of its state survives a replacement. The value is a capability, not a
version, so a new level adds no migration.

The levels are what a replacement costs the sessions the unit holds, read against S6's outcomes:
`none` restores them from the store as a start would, `state` and `fds` keep them without a
restore.

| Level | Meaning |
| --- | --- |
| `none` | Replacement ends the process, and its sessions come back the way any start brings them back: from the store, at whatever S6 outcome the record gives. |
| `state` | The process serializes its state, and the successor restores it from that serialization. |
| `fds` | The process passes open file descriptors to the successor, and the successor continues the same kernel objects. |

`soksak-spec` owns the field. It is `handoff` in the sidecar manifest, and its absence reads as
`none`. A sidecar that declares a level its build cannot perform is a defect: the core orders a
handoff at the declared level and reports failure when it does not complete.

`environment.json` records the installed version. It does not record the level; the level is read
from the manifest of the installed artifact.

## H2. The core checks before it replaces

The core never ends a running unit to install a newer one. Before a replacement it reads the
declared level of the selected artifact and the count of resources the running unit reports.

| Declared | Running unit holds nothing | Running unit holds resources |
| --- | --- | --- |
| `none` | Replace. | Report. Replacement waits for an explicit request. |
| `state` | Replace through the state path. | Replace through the state path. |
| `fds` | Replace through the fd path. | Replace through the fd path. |

"Holds nothing" is the unit's own count, read through the contract its plugin declares. The core
does not interpret what the resources are.

`sidecar.mismatch` returns one entry per unit whose running version differs from the selected
version: `{ name, running, selected, handoff, attached }`. `attached` is the count the unit reports
and is `null` when the unit serves no count. An empty array is the pass condition.

`sidecar.restart` takes one unit name, refuses a name absent from `sidecar.mismatch`, and performs
the replacement at the declared level. It returns the level it used and the count it carried.

At `none` the sessions are restored rather than kept, so the count is what the restore has to stand
back up and `session.list` is where the result is read. A unit whose sessions came back `degraded`
replaced correctly and lost state all the same; the two facts are separate and both are reported.

## H3. The state path

The predecessor serializes its state on request, and the successor restores from that serialization.
The serialization is produced at handoff time, not read from a periodic snapshot: a periodic
snapshot is stale by its interval and holds no live sequence.

The predecessor stays running until the successor reports the restore complete. A successor that
reports failure leaves the predecessor in place and the selected version unused.

`soksak-contract-terminal` owns this wire for the terminal mirror. §5 of that specification already
defines `rehydrate` as the live serialization and §7 defines the degraded path; the handoff request
is the same serialization taken once, at replacement, for every session the mirror holds.

## H4. The fd path

The predecessor passes open descriptors to the successor over a Unix domain socket control message,
and the kernel reference count keeps each object alive across the predecessor's exit. Alongside the
descriptors the predecessor passes the state that cannot be derived from them: the session
identifiers, the size applied to each descriptor, and the ring coordinates each session reached.

Target descriptor numbers are placed above every source and acknowledgement descriptor, so no
target collides with a descriptor the transfer itself uses. The successor's ring continues from the
coordinates it received; a ring that restarted at zero would stop output without an error.

The exchange is acknowledged. The predecessor holds every descriptor and keeps serving until the
successor acknowledges the adoption, and only then closes its socket and exits. A successor that
acknowledges failure, or that does not acknowledge within the deadline, leaves the predecessor
serving and the selected version unused.

Two operations remain correct only if the wire states them. A descriptor the successor adopted was
not created by the successor, so an operation that requires the creating process must be specified
rather than assumed: the wire states how the successor applies a size to an adopted descriptor. And
the successor must report the version of its own artifact, not the version it inherited through the
environment it was started with; a successor that reports its predecessor's version is read as a
mismatch again and ordered to replace itself without end.

`soksak-contract-pty` owns this wire. `HandoffNone` and `HandoffSafeFDs` and the `handoff` field of
`pty.status` already exist there; `pty.handoff` is declared as a command name and its request and
response are not yet specified.

## H5. What each repository owns

| Part | Owner |
| --- | --- |
| The `handoff` manifest field and its validator | `soksak-spec` |
| The fd exchange wire, its acknowledgement and deadline | `soksak-contract-pty` |
| The state exchange wire and its acknowledgement | `soksak-contract-terminal` |
| Reading the declaration, asking the unit for its count, ordering the replacement, reporting the result | `soksak-core` |
| Performing the exchange | each sidecar repository |

The core reads a declaration and a count. It does not hold which descriptors a unit has, what its
serialization contains, or which commands its plugin uses.

Session outcomes are not this document's. The core reads them through the one command every session
owner answers, and [`SESSION.md`](SESSION.md) S6 defines what each means.

## H6. Gates

| Claim | Gate |
| --- | --- |
| A manifest declaring an unknown level is refused | `soksak-spec` manifest validator test |
| `sidecar.mismatch` returns an empty array when every running version equals its selected version | core test over a fixture environment |
| `sidecar.restart` refuses a name absent from `sidecar.mismatch` | core test |
| A `none` unit holding resources is not replaced without an explicit request | core test |
| A predecessor whose successor fails keeps serving | contract repository test, per level |
| A session survives a `fds` replacement | `soksak-contract-pty` conformance test |
| A screen survives a `state` replacement | `soksak-contract-terminal` conformance test |
| A `none` replacement leaves every session in `session.list`, restored | core test over the session index |

The execution order and current state of each item are in
[`COMPONENT-HANDOFF-TASK.md`](COMPONENT-HANDOFF-TASK.md).
