---
kind: canonical
status: active
canonical: self
---

# Sidecars


A sidecar is a plugin that runs in its own process. This document is the contract; this round
builds no sidecar.

## S1. Classification is by consumer

- **Sidecar** — a separate process a plugin drives. The core spawns and relays; it does not
  interpret the messages.
- **Wails service** — extends the host itself (native surfaces, capture). Registered in
  `frameworks/wails/host.go`'s service list, cannot be switched off, and is not a sidecar.

The two differ in what depends on them, so they are different folders (REPO-LAYOUT.md L1).

## S2. One envelope, not a second ABI

A sidecar speaks the control envelope of CONTROL-PROTOCOL.md and registers its commands on the same
registry. There is no separate sidecar ABI.

A second protocol is the defect this rule prevents: two wires diverge, and a divergence does not
fail — it arrives as a different answer. An earlier design had a private engine ABI beside the
control plane, and every rule then existed twice.

## S3. In-process is a service, not a sidecar

A native child view is process-local on macOS: another process cannot attach a view to this
application's windows, and the engine's message pump needs this process's main queue. Anything that
draws into a pane is therefore linked into the application as a Wails service, not spawned.

That is what `wails-services/wails-service-native-compositor` and
`soksak-plugins/soksak-plugin-browser-native` are: linked Go, listed in the service list, reachable
from the page through their commands.

## S4. Lifetime

- Only the process that spawned a child reaps it. Adopting an orphan is not ownership: the adopter
  did not choose its arguments and cannot know what it was doing.
- Readiness is the child's first stdout line, and that line names its socket. A file appearing on
  disk is not a bind, and polling for one reports ready before the listener exists.
- No polling anywhere else either. An event boundary or a receipt says when something happened.

## S5. Distribution

Two cases, and they are not alike.

| Case | How |
| --- | --- |
| Written here | A subcommand of the one binary. The process splits; the binary does not. |
| A third-party binary (ffmpeg, an agent CLI) | A bundled file, found by the discovery rule below. |

Discovery: a declared path wins. With none, the search fails carrying every location it looked in.
A guessed path leaves only `ENOENT`, which says nothing about where anyone looked.

## S6. Declaration and permission

A plugin declares its sidecars in the manifest (PLUGIN-CONTRACT.md P3) with the contract id and
version range it expects. `app.sidecar.open(name)` is limited to declared names, and the declared
interface is checked against what the binary reports at load: declared equals actual, on both sides.

The `sidecar` permission is disclosed with the declared names, because a sidecar runs code this
application did not write.

## S7. Not in this round

No sidecar is built here. The terminal and the browser are in-process: linked Go plus a native
layer. This document exists first because a boundary defined after the code is a boundary the code
has already crossed.
