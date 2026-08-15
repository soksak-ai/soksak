---
kind: canonical
status: active
canonical: SIDECARS.md
---

# Sidecars

English canonical: [`SIDECARS.md`](SIDECARS.md). Where the two differ, English wins.

A sidecar is a plugin that runs in its own process. This document is the contract, and this round builds no sidecar.
builds no sidecar.

## S1. The consumer is the classification criterion

- **Sidecar** — a separate process the plugin runs. The core only starts it and relays; it does not interpret
  the messages.
- **Wails service** — extends the host itself (native surface, capture). The `frameworks/wails/host.go`
  service list, cannot be switched off, and is not a sidecar.

The two differ in what depends on them, so they are different folders (REPO-LAYOUT.md L1).

## S2. One envelope, no separate ABI

A sidecar speaks the control envelope of CONTROL-PROTOCOL.md and registers its commands on the same registry.
There is no separate sidecar ABI.

A second protocol is the defect this rule prevents. Two wires diverge, and a diverged protocol does not fail — it arrives
as a different answer. An earlier design had a private engine ABI beside the control plane, so every rule then existed
twice.

## S3. In-process is a service, not a sidecar

On macOS a native child view is valid only inside the process. Another process cannot put a child view into this application's window
cannot attach a view, and the engine's message pump uses this process's main queue. So anything that draws into a pane is
It is a Wails service linked into the application, not a spawn.

`wails-services/wails-service-native-compositor` and
`soksak-plugins/soksak-plugin-browser-native` is that one — linked Go, listed in the service list,
reachable from the page through its commands.

## S4. Lifetime

- Only the process that started a child terminates it. Taking over another process's child is not ownership — the receiving side did not start that
  did not choose its arguments and cannot know what it was doing.
- Readiness is the first line of the child's stdout, and that line contains its own socket. A file appearing on disk is
  is not a bind, and polling for it reads ready before the listener is up.
- Nothing else polls either. An event boundary or a receipt reports what happened.

## S5. Distribution

Two cases, and they are not alike.

| Kind | Method |
| --- | --- |
| What is used here | A subcommand of one binary. The process splits, the binary does not. |
| A third-party binary (ffmpeg, an agent CLI) | A bundled file + the discovery rule below |

Discovery rule: a declared path wins. With none, the search fails and reports every location it looked in. Running an invented path
Only one `ENOENT` line remains, and where it looked is gone.

## S6. Declaration and permission

A plugin declares its sidecars in the manifest (PLUGIN-CONTRACT.md P3). The expected contract id and version
range are recorded with it. `app.sidecar.open(name)` is limited to declared names, and the declared interface is
is checked against what the binary reports at load — declared ≡ actual, on both sides.

The `sidecar` permission is disclosed with the declared name, because a sidecar runs code this application did not write
runs.

## S7. Outside this round

No sidecar is built here. The terminal and the browser are in-process — linked Go plus a native layer.
Why this document comes first: a boundary defined after the code is a boundary the code has already crossed.
