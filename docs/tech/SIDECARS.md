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

The registry records target, archive URL, byte size, SHA-256, format, source commit, and sidecar.json.
The installer selects the current host target, verifies the digest, extracts regular files in a
transaction, and records the exact version, target, registry ID, source kind, and absolute local path
in `environment.json`. A
managed installation never clones a repository or builds a sidecar locally.

A development source is different: the owner repository builds and stages its own dist directory,
and the environment records that exact version, absolute path, and source kind. The updater does not
replace it.

## S4. Runtime and protocol

A sidecar registers no application command. Its plugin owns public commands. Sidecar traffic uses
the versioned control envelope; the core checks correlation and framing but treats request and
response data as opaque. Operator and system tests may use sidecar.request, while plugin code must
use its declared app.sidecar capability.

Readiness is the first valid announcement from the process. A file appearing on disk is not
readiness. The core waits on the announcement with a finite deadline and never polls for a socket.
Concurrent opens for the same provider share one start operation and receive the same success or
failure result. A different secret declaration is rejected before waiting.

## S5. Lifetime

Releasing a channel closes that caller's connection and does not stop the sidecar. Application
shutdown also releases connections without ending sidecars that own restorable work. A later
application generation reads the saved process announcement, reconnects, performs the greeting and
uses the same process.
Channel release does not remove the process from host status or prevent an explicit
`sidecar_stop`; those operations address process lifetime, not channel lifetime.

sidecar.stop is the explicit operation that ends a sidecar. A plugin disable, view unmount or app
restart is not a stop request. Streams have their own ids and can close independently.

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
- min-median-max/soksak-terminal-tests tests installed multi-provider behavior and never builds owner
  source trees.
