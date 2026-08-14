---
kind: canonical
status: active
canonical: self
---

# Architecture

Korean edition: [`ARCHITECTURE_KO.md`](ARCHITECTURE_KO.md). English is canonical.

The core renders no concrete content. Terminals, browsers, and sidebar bodies
arrive as plugins, and the core owns the frame, the registries, and the surfaces
that make all of it observable.

## What the core owns

| Interface | Guarantee |
| --- | --- |
| Layout | One recursive `leaf \| split` tree. Split, move, close, maximise, resize. The tree is opaque to plugins: it changes through commands and is never handed over. |
| Command registry | One registry. Every command — core, framework, plugin — registers once with a typed parameter schema. Commands outside it do not exist. |
| View and program registries | `registerView(viewId, provider)` and `contributes.programs[]`. Mount and unmount own lifetime only. The add menu is a projection of the program registry. |
| Theme | Token slots and chrome attributes. Components consume slots, never values, so a new theme is one document rather than an edit to every rule. |
| Addresses | Structural paths for every operable node, so nothing is reached by guessing a selector. |
| Capture | The window's pixels, without focus and while occluded. |
| Storage, scanning, identity, activity, HTTP | Host-independent answers, reachable with no window at all. |

Native capability stays in the core because a PTY's kernel object and a
platform webview cannot cross a plugin boundary. The core exposes them as
general capabilities and plugins consume them as thin clients.

## The four seams

A plugin attaches through exactly these. There is no private channel, no direct
store import, no back door to a native command.

1. **Program** — `contributes.programs[]` declares an entry; the core routes to it.
2. **View** — `contributes.views[]` plus `registerView`. A provider receives view
   context and nothing else. Reading or focusing another view's DOM is forbidden.
3. **Command** — one registration with a typed schema, automatically reachable
   from the CLI and the control plane.
4. **Capability** — permission-gated `app.*` and the event bus.

What cannot be expressed through these four is what a plugin must not do. **If a
real plugin cannot be built within them, the core is missing a general
capability** — add the capability. Never add a private path.

## Principles

All of these are hard.

- **A1.** The core renders no concrete content. A slot is an empty container.
- **A2.** View context is the only channel into a view. No core store, no layout tree.
- **A3.** General capabilities only. A capability named after one consumer is lock-in.
- **A4.** No core lock-in. Adding a content subsystem costs the core zero edits.
- **A5.** The schema is the single source of truth. Prose adds only what a schema
  cannot enforce.
- **A6.** Idempotent. Activation, mount, and command converge on the same state
  however many times they run.
- **A7.** Independent. Each plugin is its own repository with its own build and
  tests, depending on nothing beyond its declared dependencies.
- **A8.** Removable. Disabling any plugin leaves the core and unrelated plugins
  fully working, with no orphaned native resources.
- **A9.** Zero core diff. A plugin that forces a core edit is a missing capability.

## Coupling law

- **C1.** The core knows no specific plugin and no specific feature.
  Gate: scanning core sources for a plugin id finds nothing outside the
  composition root.
- **C2.** Every feature exposes three surfaces — command, status, and DOM.
  A view with no command fails. A view no status axis can see fails. An element
  reachable only by guessing a selector is not shipped.
- **C3.** Plugins couple to each other by contract only.
  Never reach into another plugin's DOM, internal state, file layout, or load
  order. Never hardcode a plugin id as a capability boundary: providers declare
  `implements` and consumers declare `consumes`, and conformance proves declared
  equals actual.
- **C4.** Contract identity is `soksak-spec-<kind>-<domain>`. Providers publish a
  full SemVer version, consumers a range. The `0.0.1` baseline promises no
  compatibility, so first-party consumers pin exactly `0.0.1`.
- **C5.** Standards do not weaken silently. A red test against a correct standard
  means fixing the implementation, the fixture, or the exposed interface. A
  standard that is itself wrong changes in the open, with the evidence and the
  tests in the same commit.

## One backend, several transports

A command registers once and is reached through every transport. The frontend's
`invoke` and a socket call resolve through the same table, and nothing may
bypass it — a second path drifts from the first, and the drift stays quiet until
the two give different answers.

Registry entries declare an owner. `core` answers the same in a window, in a
headless server, and in a test. `framework` needs this host's window: a process
without one has no background to set and no pending envelope to resend.

The table answers for itself. Alongside what it serves it reports what it
refuses and why, because a caller given only "unknown command" cannot separate
"not written yet" from "impossible here" — and then it re-investigates settled
ground or imitates the command.

## Identity

A process receives its identifier and derives everything else from it, once.
Deriving the home and the identifier separately makes the pair "A's home with
B's name" representable, and a reconnect then lands on the wrong installation.

Homes separate on the environment axis alone — `~/.soksak-<env>`. A framework
axis deliberately does not separate them: one home holds one backend and may
have several frontends.

Nothing in the core reads the process environment. The launcher reads it once
and passes values down, so a rule cannot answer differently depending on who
called it.
