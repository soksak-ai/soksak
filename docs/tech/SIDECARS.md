---
kind: canonical
status: active
canonical: self
---

# Sidecars

A sidecar is an independently released process used by a plugin. The core starts the process and
relays the control protocol without interpreting domain payloads. A Wails service is compiled into
the host and extends the host itself, so it is not a sidecar.

## S1. Identity and selection

Plugins declare named sidecar requirements. Each requirement has a public contract id and version.
settings.json bindings connect the named plugin requirement to one sidecar id and version. Provider
selection never uses folder order, install order, an id prefix or a fallback.

When a plugin opens a requirement, the core sends the plugin id, plugin version and requirement
name to the installation resolver. The resolver returns the bound sidecar. The open response
contains the actual sidecar id, and later send, stream and release operations use that id.

The older process spawn shortcut for sidecars is removed. It had no consumer identity or
requirement name and therefore could not resolve a settings binding.

## S2. Manifest

Every sidecar artifact contains sidecar.json using soksak-spec-sidecar@0.0.1. It declares the
sidecar id and version, the implemented interface, and a process path relative to the installed
artifact. The composition contract owns this document format.

The process path must resolve through regular directories to a regular file. Symbolic links, path
escape, missing files and undeclared paths are rejected. release/unit.json does not exist and is
not read as a fallback.

The current host starts process sidecars. A manifest declaring a library is rejected until the host
implements the separately tested in-process library loader.

## S3. Distribution

Each sidecar repository owns its build, tests and GitHub Release. A release publishes one immutable
archive per supported target. The archive contains sidecar.json, dist/<sidecar-id> and any runtime
files required by that process. The source binary may use a platform extension while the archive
entry remains the path declared by sidecar.json.

The registry records target, archive URL, SHA-256, format and sidecar.json. The installer selects
the current host target, verifies the digest, extracts regular files in a transaction and records
the absolute install path in settings. A managed installation never clones a repository or builds a
sidecar locally.

Development mode is different: the owner repository builds and stages its own dist directory, and
settings records that absolute path with development:true. The updater does not replace it.

## S4. Runtime and protocol

A sidecar registers no application command. Its plugin owns public commands. Sidecar traffic uses
the versioned control envelope; the core checks correlation and framing but treats request and
response data as opaque. Operator and system tests may use sidecar.request, while plugin code must
use its declared app.sidecar capability.

Readiness is the first valid announcement from the process. A file appearing on disk is not
readiness. The core waits on the announcement with a finite deadline and never polls for a socket.

## S5. Lifetime

Releasing a channel closes that caller's connection and does not stop the sidecar. Application
shutdown also releases connections without ending sidecars that own restorable work. A later
application generation reads the saved process announcement, reconnects, performs the greeting and
uses the same process.

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
- the composition contract tests the closed manifest format;
- core tests settings binding resolution, path safety, process lifetime, adoption and opaque relay;
- externals/soksak-terminal-tests tests installed multi-provider behavior and never builds owner
  source trees.
