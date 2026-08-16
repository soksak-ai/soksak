---
kind: canonical
status: active
canonical: self
---

# Architecture


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

That is C6's third question and it is the narrowest of the three, not a door.
The core owns the PTY; it owns no shell's prompt protocol, no list of shell
paths, and no rule about what a byte from a shell means. Whatever a plugin
*could* hold, a plugin holds.

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

The census that applied C6 to every surface is [`CORE-CENSUS.md`](CORE-CENSUS.md): 242 commands, 17
Go packages, 32 components, 43 stores, each with a verdict and a reason. Six were features and all
six left on 2026-08-16.

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
  Gate: `coupling_gate_test.go` scans core sources — `frameworks/` included —
  for a plugin id, a rendering engine, and a **domain concept**. A name and a
  concept are two separate readings, because a core that writes no plugin id and
  still holds `Bookmark { url, title }` is coupled to a browser exactly as hard.
  Measured 2026-08-16: the id scan had been green for a day while the core held
  a bookmarks store, three `bookmark.*` commands, a `bookmarks.changed` plugin
  event, and the browser panel's stylesheet.
- **C2.** Every feature exposes three surfaces — command, status, and DOM — and
  the exposure is operable, not decorative.
  A view with no command fails. A view no status axis can see fails. An element
  reachable only by guessing a selector is not shipped.
  **Operable** means an exposed node is driven from outside: `ui.input.click`,
  `ui.input.drag`, `ui.input.dnd`, `ui.input.key`, `ui.input.fill` act on the
  address `ui.tree` answers, and `ui.input.observe` reports what arrived. An
  address that can only be read is a picture, and a picture is not a seam — two
  builds that answer the same tree and behave differently are indistinguishable
  through it.
- **C3.** Plugins couple to each other by contract only.
  Never reach into another plugin's DOM, internal state, file layout, or load
  order. Never hardcode a plugin id as a capability boundary: providers declare
  `implements` and consumers declare `consumes`, and conformance proves declared
  equals actual.
- **C4.** A contract id is a plain name — `^[a-z0-9][a-z0-9-]*$`, so `browser` and
  `sidebar-file-tree`. Providers publish a full SemVer version, consumers a range.
  The `0.0.1` baseline promises no compatibility, so first-party consumers pin
  exactly `0.0.1`.

  It was `soksak-spec-<kind>-<domain>` until 2026-08-16, and the reason written
  down for the prefix was that a scanner could then tell a contract id from a
  plugin id in core sources. The core names no contract it does not define, so
  nothing in core sources can be confused — and a rule shaped to suit a scanner
  is the scanner writing the rule. The kind is out of the name too: whether a
  plugin or a sidecar provides a thing is the provider's business, and a consumer
  that had to know would be coupled to the implementation (C3).

  Platform schema ids are a different namespace and keep theirs:
  `soksak-spec-plugin@0.0.1` and its siblings stamp an envelope's format version,
  are written into files on disk, and are not names two plugins meet at.
- **C5.** Standards do not weaken silently. A red test against a correct standard
  means fixing the implementation, the fixture, or the exposed interface. A
  standard that is itself wrong changes in the open, with the evidence and the
  tests in the same commit.

- **C6.** Common goes in the core, a feature never does. **A feature is code
  that holds an opinion about what content means or how it should behave.** That
  is the whole test, and the three questions below are how it is applied.

  Two are necessary — fail either and it belongs to a plugin:

  1. **It is named after no domain.** `app.data`, `app.pty`, `ui.input` name a
     mechanism. `bookmark`, `favicon`, `tabstrip` name one kind of content, and
     the name alone shows which plugin the code was written for.
  2. **A plugin that never heard of the first consumer can use it unchanged.**
     A store keyed by namespace serves a browser and a mail client equally. A
     store that holds `{ url, title }` serves one of them.

  Then one of these is the reason it is in the core at all:

  3. **Either it cannot cross the plugin boundary** — a PTY's kernel object, a
     platform webview, the window's pixels; the process that owns the window
     owns them — **or every plugin would otherwise reinvent it**, and reinvent
     it differently. A byte-stream parser for OSC 7/133/633 crosses fine and is
     still the core's: it decodes a protocol and decides nothing, and three
     plugins reading PTY output would each write it again.

  Question three was stated as necessary until it was applied, on the same day.
  Read that way it ejects every pure computation the core is made of — the
  layout solver, the address parser, the digest — because each of them *could*
  sit in a plugin. It is a sufficient reason, not a required one, and the
  corrected form gives the same verdict on all six entries of the census while
  keeping the utilities where they belong.

  The line between the two is the opinion. Parsing OSC 133 is decoding.
  "An output gap of 800ms means the turn ended" is an opinion. "A saved page is
  a url and a title" is an opinion. "A file tab has a code mode and a preview
  mode" is an opinion. Opinions are what a plugin exists to have.

  The failure mode this closes is the pleasant one. A feature reaches the core
  because the core is where it is easiest to write — one store, one command
  table, one stylesheet already there — and nothing about the result looks
  wrong. Then the second plugin of that kind cannot use any of it, because it
  was shaped for the first.

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
