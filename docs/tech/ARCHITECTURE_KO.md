---
kind: canonical
status: active
canonical: ARCHITECTURE.md
---

# Architecture

The English canonical is [`ARCHITECTURE.md`](ARCHITECTURE.md). Where the two differ, English wins.

The core renders no concrete content. Terminals, browsers and sidebar bodies arrive as plugins, and
the core owns the frame, the registries, and the surfaces that make all of it observable.

## What the core owns

| Interface | Guarantee |
| --- | --- |
| Layout | One recursive `leaf \| split` tree. Split, move, close, maximise, resize. The tree is opaque to plugins — it changes through commands and is never handed over. |
| Command registry | One registry. Every command — core, framework, plugin — registers once with a typed parameter schema. Commands outside it do not exist. |
| View and program registries | `registerView(viewId, provider)` and `contributes.programs[]`. Mount and unmount own lifetime only. The + menu is a projection of the program registry. |
| Theme | Token slots and chrome attributes. Components consume slots, not values, so a new theme is one document rather than an edit to every rule. |
| Addresses | Structural path for every operable node. Nothing is addressed by guessing a selector. |
| Capture | The window's pixels — without focus, and while occluded. |
| Storage, scanning, identity, activity, HTTP | A host-independent answer. Available with no window. |

Native capability stays in the core because a PTY's kernel object and a platform webview cannot cross a plugin
is not possible. The core exposes them as general capabilities and plugins consume them as thin clients.

## Four seams

A plugin attaches through exactly these. There is no private channel, no direct store import, and no native command
back door.

1. **Program** — `contributes.programs[]` declares the item and the core routes it.
2. **View** — `contributes.views[]` + `registerView`. The provider receives the view context only.
   reading or focusing another view's DOM is forbidden.
3. **Command** — registered once with a typed schema. Automatically available from the CLI and the control plane.
4. **Capability** — permission-gated `app.*` and the event bus.

What cannot be expressed with these four is what a plugin must not do. **If a real plugin cannot be built inside
cannot be built within them, the core is missing a general capability** — add the capability.
A private path is never added.

## Principles

All of them are HARD.

- **A1.** The core renders no concrete content. A slot is an empty container.
- **A2.** The view context is the only channel into a view. Not the core store, not the layout tree.
- **A3.** General capabilities only. A capability named after one consumer is lock-in.
- **A4.** No core lock-in. Adding a content subsystem takes 0 core edits.
- **A5.** The schema is the single truth. Prose adds only what the schema cannot enforce.
- **A6.** Idempotent. Activation, mount, and command converge to the same state however many times they run.
- **A7.** Independent. Each plugin is its own repository with its own build and tests, and beyond its declared dependencies
  depends on nothing.
- **A8.** Removable. With any plugin turned off, the core and unrelated plugins work in full,
  with no unreclaimed native resources.
- **A9.** Core diff 0. A plugin that forces a core edit means a missing capability.

## Coupling rules

- **C1.** The core references no specific plugin and no specific feature.
  Gate: scanning core sources for a plugin id finds nothing outside the composition root.
- **C2.** Every feature exposes three surfaces — command · status · DOM.
  A view with no command fails. A view no status axis can see fails. An element reachable only by guessing a selector
  is not shipped.
- **C3.** Coupling between plugins goes through a contract only.
  Never reach into another plugin's private DOM, internal state, file layout, or load order. Never hardcode a plugin id as a capability
  boundary: providers declare `implements` and consumers declare `consumes`, and
  conformance proves declared ≡ actual.
- **C4.** The contract identity is `soksak-spec-<kind>-<domain>`. The provider gives a full SemVer, the consumer a range.
  The `0.0.1` baseline has no compatibility promise, so the first-party consumption range is exactly `0.0.1`.
- **C5.** A standard is not weakened in silence. When a test is red against a correct standard, the implementation, the fixture, or the exposure
  interface. A standard that is itself wrong changes in the open, with the evidence and the tests in the same commit.

## One backend, many transports

A command registers once and arrives through every transport. The frontend's `invoke` and a socket call resolve through the same
through it, and neither may bypass it — a second path drifts from the first, and that drift
quiet until the two give different answers.

Registry entries declare an owner. `core` gives the same
answer in a window, in a headless server, and in a test. `framework` needs this host's window — a process without one has no background to paint and
no pending envelope to resend.

The table answers for itself. Alongside what it serves it reports what it refuses and why. One "unknown command"
A caller given only the line cannot separate "not written yet" from "impossible here", so settled ground is gone over
again, or imitates that command.

## Identity

A process **receives** an identifier and derives the rest from it at once. Reading the home and the identifier separately
read separately, "B's name in A's home" becomes representable, and a reconnect then lands on another installation.

Homes separate on the environment axis alone — `~/.soksak-<env>`. The framework axis deliberately does not separate them:
one home holds one backend and may have several frontends.

Nothing in the core reads the process environment. The launcher reads it once and passes values down.
The same rule cannot answer differently depending on who called it.
