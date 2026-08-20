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

## S3. Two models, and in-process is not linked

A sidecar takes one of two runtime shapes. The axis is where it runs, not what it is called.

| | `service` | `engine` |
| --- | --- | --- |
| Runs as | its own process | a dylib in this process, loaded at boot |
| Draws | nothing | into a pane's surface |
| Channel | the control-plane envelope over its socket | opaque bytes across the loading ABI |
| Describes itself by | its manifest | the symbols it exports — the binary is the truth |
| The core understands | the envelope, not the payload | nothing; it relays |

`engine` is in this process because a native child view is process-local on macOS: another process
cannot attach a view to this application's windows, and the message pump needs this process's main
queue. That is a fact about the process, and it was read as a fact about the build until 2026-08-20
— this section said such a plugin is "linked into the application as a Wails service, not spawned",
and the browser's and compositor's Go halves were linked accordingly.

**In-process is not linked.** An engine module is installed like any other artefact and loaded
because the manifest declared it. Wails' own service concept cannot carry it: `RegisterService`
takes a Go value and refuses anything after `Run`, so a service is a compile-time fact — which is
the right shape for the *host* that loads engines, and the wrong one for the engines.

One constraint the loading side carries: a module that brings a second Go runtime into this process
is not loadable, because the process already has one. An engine exports a C ABI and holds no runtime
of its own. The Go half of a plugin that needs a window belongs to the host that loads it, not to the
module.

Loading costs Windows nothing, which is the constraint that decides whether this shape is available
at all. `NATIVE-LAYER.md` N3 holds Windows at cgo 0 because that is the one target whose cross
compilation a cgo dependency would break. Measured 2026-08-20 by compiling both halves of a loader:

| Target | How a module is opened, its symbols found, and host callbacks handed back | cgo |
| --- | --- | --- |
| Windows (amd64, arm64) | `syscall.LoadDLL`, `(*DLL).FindProc`, `(*Proc).Call`, `syscall.NewCallback` | 0 |
| macOS, Linux | `dlopen`, `dlsym` | already required by the framework |

A Go function reaches a module as a C function pointer on every target, so the host half of the ABI
needs no platform of its own. The framework itself calls Win32 this way in its own Windows layer, so
this is the path it already takes rather than a new one.

Until that host exists, `wails-services/wails-service-native-compositor` and
`soksak-plugins/soksak-plugin-browser-native` are linked Go, and `ARCHITECTURE.md` C1a is red for
them. The state is written down rather than described as a design.

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

## S7. What is built, and what is not

| Shape | State |
| --- | --- |
| `service` — its own process | Built. The PTY daemon owns the shells so they outlive an application generation, which is the whole reason a process is split. |
| `engine` — a loaded dylib | Not built. Nothing loads a module, so a plugin that must draw into a pane has nowhere to be except the core binary. |

The second row is why `ARCHITECTURE.md` C1a is red. The browser's native half is not linked because
a dylib could not do the work — it is linked because there is no host to load one.

The engine host is what this document exists to bound. A boundary defined after the code is a
boundary the code has already crossed, and this one was: the paragraph above replaced a rule that
had turned the absence of a host into a law that plugins must be compiled in.
