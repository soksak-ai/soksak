---
kind: canonical
status: active
canonical: self
---

# Sidecars

Sidecar source manifests, target process projection, and release validation follow
[RELEASE-INTEGRITY.md](./RELEASE-INTEGRITY.md).

A sidecar is an independently released process used by a plugin. The core starts the process and
relays the control protocol without interpreting domain payloads. A Wails service is compiled into
the host and extends the host itself, so it is not a sidecar.

## S1. Identity and selection

Plugins declare named sidecar roles. Each role has a public contract id and version requirement.
`environment.json` connects each plugin role to one sidecar ID. Selection never uses folder order,
install order, an id prefix, or a fallback.

When a plugin opens a requirement, the core sends the plugin id, plugin version and requirement
name to the installation resolver. The resolver returns the bound sidecar. The open response
contains the actual sidecar id, and later send, stream and release operations use that id.

## S2. Manifest

Every sidecar artifact contains sidecar.json using soksak-spec-sidecar@0.0.1. It declares the
sidecar id and version, the implemented interface, and a process path relative to the installed
artifact. `soksak-spec` owns this document format and its validator.

The process path must resolve through regular directories to a regular file. Symbolic links, path
escape, missing files and undeclared paths are rejected. No compatibility manifest is read.

The current host starts process sidecars. A manifest declaring a library is rejected until the host
implements the separately tested in-process library loader.

## S3. Distribution

Each sidecar repository owns its build, tests and GitHub Release. A release publishes one immutable
archive per supported target. The archive contains sidecar.json, dist/<sidecar-id> and any runtime
files required by that process. The source binary may use a platform extension while the archive
entry remains the path declared by sidecar.json.

The release document records target, archive file name, byte size, SHA-256, format, source commit, and
sidecar.json; the registry index records the release reference {id, version, size, sha256}, and every
location is derived from the id and version.
The installer selects the current host target, verifies the digest, extracts regular files in a
transaction, and records the exact version, target, registry ID, source kind, and absolute local path
in `environment.json`. A
managed installation never clones a repository or builds a sidecar locally.

A Local Sidecar release uses the same manifest, target archive, digest validation, and installer
transaction as a registry release. The environment records the materialized artifact digest and
`local` source. Automatic registry update does not replace that explicit selection.

## S4. Runtime and protocol

A sidecar registers no application command. Its plugin owns public commands. Sidecar traffic uses
the versioned control envelope; the core checks correlation and framing but treats request and
response data as opaque. Operator and system tests may use sidecar.request, while plugin code must
use its declared app.sidecar capability.

Readiness is the first valid announcement from the process. A file appearing on disk is not
readiness. The core waits on the announcement with a finite deadline and never polls for a socket.
Concurrent opens for the same provider share one start operation and receive the same success or
failure result. A different secret declaration is rejected before waiting.
The exact resolved component version is part of the running unit identity. Matching only the sidecar
id or its stable development directory is forbidden. The saved process announcement records that
version, so a later Core generation compares the same values before adoption.

A unit already serving another version or executable path is not ended by the core. Sessions the
unit holds end with it, and the split process exists so those sessions outlive an application
generation. The core reports the mismatch and starts no replacement. The selected version stays
unused until the running unit exits, and the restart is an explicit request.

`sidecar.mismatch` returns one entry per unit whose running version differs from the selected
version: `{ name, running, selected, attached }`. `attached` is the count the unit reports for the
resources it holds, and is `null` when the unit serves no count. An empty array is the pass
condition. The command starts no unit and ends none.

`sidecar.restart` ends one named unit and starts the selected version. It takes the unit name and
refuses a name that is not in `sidecar.mismatch`. It ends the sessions the unit holds; the caller
is the person, not the core.

The public `sidecar.status` command returns `{ units: [{ name, version, process, pid }] }` for every
unit this home has a live process for, whether this Core generation started it or a previous one
left it. A recorded unit is checked by connecting; a record whose process is gone is removed and
omitted. It does not start a unit, or return transport addresses, diagnostics, tokens, or secret
declarations.

## S5. Lifetime

Releasing a channel closes that caller's connection and does not stop the sidecar. Application
shutdown stops every Sidecar tracked by that application and removes each process record after
process exit. A shutdown failure prevents a successful shutdown result.
Channel release does not remove the process from host status or prevent an explicit
`sidecar_stop`; those operations address process lifetime, not channel lifetime.

A process record can remain after an unclean application termination. A later application checks
the recorded process by connecting and completing the greeting. It reuses a valid process only
during cleanup or recovery, removes a record for an unavailable process, and rejects an invalid
record. Normal shutdown and test cleanup verify that no application-owned Sidecar remains.

A process record is removed after the process exits, never before. A stop that fails leaves the
process running, and removing its record makes the unit unreachable: adoption reads no record,
status returns nothing, and the next start creates a second process for the same unit name.
Measured 2026-09-03: a terminal sidecar ran for 17 minutes with no record while `environment.json`
selected a newer version; `sidecar.status` returned one unit while two were running.

`sidecar_stop` is the explicit operation that terminates a sidecar. It returns only after the
operating system reports process exit. Darwin uses a kqueue process notification, Linux uses a
pidfd notification, and Windows uses `WaitForSingleObject`. The operation fails on timeout and does
not poll process state. Plugin disable and view unmount are not stop requests. Application shutdown
is a stop request for every tracked Sidecar. Streams have separate ids and close independently.

Open means something answers there. A held unit whose address refuses a connection has gone: reading
the inventory forgets it, and the next request starts the unit again from the arguments that started
it the first time. A caller was granted the name, not one process, so a request arrives at whichever
process serves that name now. A run record naming a process that has ended is forgotten when the
inventory is read, so an operation that refuses while a name is recorded is held by units that are
running and by nothing else.

A request that is never answered ends rather than holding the caller. A unit that takes a request
and reports nothing — a process alive but unable to serve, a disk with no room left to write — would
otherwise hold the plugin that asked, the queue behind that plugin, and the person typing into it.
The wait is bounded and the refusal names the unit and the bound.

## S6. Secrets and permissions

The plugin manifest discloses the sidecar permission and named requirements. Secret values do not
cross into JavaScript. A plugin passes secret names or generated-secret declarations; the core
resolves values at the process boundary. Reopening a running sidecar with a different declared
secret set is rejected.

## S7. Tests

- each sidecar repository validates sidecar.json, stages the declared process and tests its own
  protocol and conformance;
- `soksak-spec` tests and publishes the sidecar manifest format;
- core tests environment binding resolution, path safety, process lifetime, adoption and opaque relay;
- `tests/soksak-terminal-tests` tests installed multi-provider behavior and never builds owner
  source trees.
