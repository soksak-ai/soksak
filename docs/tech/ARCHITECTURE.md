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

## Principles

All of these are hard.

- **A1.** The core renders no concrete content. A slot is an empty container.
  A window has three regions — `left`, `center`, `right` — and a plugin declares
  which of them its view is placed in, one or several. The region is a place, not
  a role: the core has no notion of what a view is for.
- **A2.** View context is the only channel into a view. No core store, no layout tree.
- **A2a.** A section is a plugin. A file tree, a daemon list, bookmarks, a
  terminal — each is its own plugin declaring the region it is placed in, and no
  plugin provides another's section.

  **What appears with what is a separate question, and the workspace answers it.**
  A manifest declares a region and no companion; which sections are open, in
  which region, split or tabbed and in what order, is the workspace's state —
  arranged by the person, persisted with the workspace, restored with it
  (`leftLayout`, and the same for the right). A plugin cannot say what it appears
  beside, and the core does not decide either.
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

- **C1.** The core has no specific plugin and no specific feature.
  Gate: `coupling_gate_test.go` scans core sources — `frameworks/` included —
  for a plugin id, a rendering engine, and a **domain concept**. A name and a
  concept are two separate readings, because a core that writes no plugin id and
  still holds `Bookmark { url, title }` is coupled to a browser exactly as hard.
  Measured 2026-08-16: the id scan had been green for a day while the core held
  a bookmarks store, three `bookmark.*` commands, a `bookmarks.changed` plugin
  event, and the browser panel's stylesheet.
- **C1a.** The core assembles from what an installation declares, never from its
  own source. No plugin package is linked into the core binary.

  A plugin is installed. What the core reads to assemble it is the manifest and
  the artefacts beside it — not an import. A plugin whose name is in the core's
  source is not installed, it is compiled: removing it breaks the build, adding
  the next one edits the core, and A9 is false for both.

  The installation declaration is the resolved composition graph (COMPOSITION.md), not directory
  presence. Core tests and tasks do not scan sibling plugin or sidecar repositories.

  In-process is not the same as linked, and reading it that way is what put them
  there. A native half that must run in this process — a parent view is
  process-local, and a message pump needs this process's main queue — is an
  **engine module**: a dylib the core loads because the installation declared it,
  described by the symbols it exports, whose messages the core relays without
  understanding (`SIDECARS.md` S3).

  Gate: `coupling_gate_test.go` reads `go list -deps` and refuses a plugin
  package in the core binary's dependency graph. It is red until the two native
  halves move behind the seam that already exists for them.

- **C1b.** What shape a plugin takes is read off what it does, not chosen.

  A plugin's surface is its view, in the document. Anything else it needs takes
  the first shape below that can do the work:

  | What it does | Shape |
  | --- | --- |
  | Draws only in the document | the view alone |
  | Work with its own lifetime, or work this process should not carry | its own process, speaking the control-plane envelope |
  | Draws into a pane's surface | an engine module, loaded by the core (`SIDECARS.md` S3) |

  Every branch is a question of fact — does it draw, does it need to outlive a
  window, can a view leave a process — so two readers reach the same shape.

  The third branch is not a preference. A view does not cross a process
  boundary: measured 2026-08-20, no public API on macOS, a DPI-awareness reset
  on Windows, and nothing at all on GTK4, which is the default this framework
  builds against. A drawing plugin that shipped as its own process would run on
  one of three targets.

- **C1c.** The core owns a content kind only while the platform supplies it and
  the core already depends on it.

  The window's own webview is such a kind: the core is built on it and there is
  one of it. Anything else a pane draws arrives as an engine module.

  **The test: can a second implementation of the same thing be
  installed with no core edit.** Where the answer is no, the core is holding a
  content kind rather than a capability, and it goes out. The test is not an
  opinion — it states which day that is, and the day is not hypothetical:
  the implementation this one succeeds shipped three browsers, one on the
  platform's webview and two on an engine of their own.

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
- **C2a.** Every exposed DOM address is unique in one window. Repeated regions
  add their pane axis to the address; a split must never make two elements
  answer the same region-only path. `ui.tree.duplicates` must therefore be
  empty before an exposed surface is accepted.
- **C3.** A plugin crosses another plugin boundary only through declarations.
  It never reads another plugin's DOM, internal state, file layout or load order.

  Two dependency forms exist and represent different requirements:

  - an implementation dependency names a plugin, sidecar or kit id and version. Use it when that
    implementation is required. Plugin is the only user-facing activation root.
  - `consumes` names one exact public contract version. A provider declares the
    same exact contract version in `implements`. Use it when any implementation
    of that exact contract is valid.

  Both are optional. An independent plugin declares neither. A contract is
  introduced only after multiple implementations or consumers require the same
  public behavior.
- **C3a.** A shared contract covers common behavior only. Implementation-specific
  settings, commands and status remain in the plugin's own specification.

  Contract declarations are not permissions by themselves. The ordinary command,
  process and data permission gates still apply. At a cross-plugin call boundary,
  either the exact plugin dependency or a compatible consumed/provided contract
  must match. An absent, malformed or incompatible declaration is refused.

- **C4.** The core has one spec and a plugin has its own. `CORE_SPEC` is the
  version the core stamps into the envelopes it defines — the plugin-runtime
  transport, both ends of which are the core's. A plugin's manifest is that
  plugin's spec, and the plugin id names it. A shared domain contract is a
  separate versioned document outside the core. Providers and consumers reference
  it; the core compares ids and versions without interpreting domain fields.

  A document the core reads and does not publish is stamped by its publisher, and
  the core reads that stamp: the registry index, a release manifest, a conformance
  report, and a plugin, sidecar or kit manifest. Each document format has one
  declared version.

  A format is per document kind: `soksak-spec-plugin@` is the manifest format
  every plugin shares. A format per plugin would duplicate the identity already
  carried by the plugin id (C1).

- **C5.** Standards do not weaken silently. A red test against a correct standard
  means fixing the implementation, the fixture, or the exposed interface. A
  standard that is itself wrong changes in the open, with the evidence and the
  tests in the same commit.

- **C6.** Common goes in the core, a feature never does. **A feature is code
  that holds an opinion about what content means or how it should behave.** That
  is the whole test, and the three questions below are how it is applied.

  Two are necessary — fail either and it is owned by a plugin:

  1. **It is named after no domain.** `app.data`, `app.process`, `ui.input` name
     a mechanism. `bookmark`, `favicon`, `tabstrip` name one kind of content, and
     the name alone shows which plugin the code was written for.
  2. **A plugin that never heard of the first consumer can use it unchanged.**
     A store keyed by namespace serves a browser and a mail client equally. A
     store that holds `{ url, title }` serves one of them.

  Then one of these is the reason it is in the core at all:

  3. **Either it cannot cross the plugin boundary** — a platform webview, the
     window's pixels; the process that owns the window owns them — **or every
     plugin would otherwise reinvent it**, and reinvent it differently. A
     byte-stream parser for OSC 7/133/633 crosses fine and is still the core's:
     it decodes a protocol and determines nothing, and three plugins reading a
     terminal byte stream would each write it again.

     A PTY is a shared **capability**, never a reason to put terminal semantics
     in the core. The capability's implementation is declared and installed:
     `soksak-sidecars/soksak-sidecar-pty` against `soksak-spec-pty`. Then a
     second implementation — a console API on another platform, a shell on
     another machine — installs with no core edit, which is the test C1c
     applies, and the core holds no device layer for one kind of content.

  The line between the two is the opinion. Parsing OSC 133 is decoding.
  "An output gap of 800ms means the turn ended" is an opinion. "A saved page is
  a url and a title" is an opinion. "A file tab has a code mode and a preview
  mode" is an opinion. Opinions are what a plugin exists to have.

  The failure mode this closes is the pleasant one. A feature arrives at the core
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

Built projects use `com.<project>.core` and separate directly as `~/.<project>`.
The project name also owns the application and CLI binary names. Explicit test
run identities may use an environment axis; a framework name never separates a
project home.

Nothing in the core reads the process environment. The launcher reads it once
and passes values down, so a rule cannot answer differently depending on who
called it.
