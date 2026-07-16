# Plugin Service — the service-axis serve standard

Normative law for the **service axis**: how a soksak-authored resident process communicates
over stdio. There is ONE wire for the whole axis — `soksak-spec-service` (current exact
provider version `0.0.1`), NDJSON over
stdio — and ONE serve harness that every such sidecar borrows. The investigation that
produced this law found the same NDJSON dance (spawn → line-buffer → parse → dispatch →
write → close-stdin-EOF → exit-on-pipe-death) hand-rolled independently across four+ plugins
(workflow ×4, mascot, sherpa, each with a gratuitously different frame shape). This standard
ends that duplication: the wire and the loop are legislated once and shared.

The wire carries commands the same way plugins do — a `bind:"service"` command is a registry
command (P1, §0-1: no plugin-specific call path), and the response is the house envelope
`{ok, code, message, data}` (MESSAGE-PROTOCOL). The transport is a focused stdio wire, not
the socket protocol: keeping it off the socket means a service is never socket-addressable
(no auth surface). A service's outbound cross-plugin calls ride the same stdio pipe as a
`cmd` frame (identity inherent in the pipe) — never a socket callback.

The wire constants and serde types, and the reference serve harness, have one source: the
`soksak-spec-service` crate (`src-tauri/crates/soksak-spec-service`) — consumers depend on
the crate and never copy a constant (the `soksak-spec-pty` discipline). The manifest schema
has one judge: `@soksak-ai/plugin-spec` `parseManifest`.

Cited laws are referenced, never restated: the coupling law C1–C5 (ARCHITECTURE §7), the
sidecar taxonomy (SIDECARS §1) and the sidecar standard (PLUGIN-CONTRACT §5), the response
envelope and the sidecar boundary A14 (MESSAGE-PROTOCOL), contract ids (NAMING §8), the
substrate rules P1–P13 (AI-CONTROL).

## 1. Axes and drive modes

**Two axes** (SIDECARS §1, unchanged): the **engine** axis is an in-process dylib with a C
ABI (function calls, not a byte stream — browser-chromium); the **service** axis is a
separate process over stdio. This law governs the service axis only. The engine axis is
untouched.

**Within the service axis, one wire, two drive modes** — the only difference is who holds
the stdio connection:

| | plugin-driven (core-blind) | core-routed (this law's primary form) |
|---|---|---|
| Who spawns / holds stdio | the plugin JS (`app.process`) | the core (ServiceManager) |
| Manifest | `sidecars[]` | `sidecars[]` + `service` block |
| Command surface | the plugin's own registry commands call it | the core routes `bind:"service"` commands natively |
| Entry | plugin has an entry module | `entry: null` lawful (pure contract) |
| Examples | speech (mascot/sherpa) | workflow |
| Wire | `soksak-spec-service` NDJSON stdio (shared harness; provider `0.0.1`) | same |

Both modes speak the identical wire and use the identical serve harness on the sidecar side;
the plugin-driven mode uses the shared JS client, the core-routed mode uses the
ServiceManager. Nothing forces a private per-plugin wire any more.

**Authored vs external boundary (the standard's scope).** The shared serve wire is
**mandatory for soksak-authored resident service sidecars** (we write the binary — workflow,
speech). It does **not** apply to **external-tool adapters**: a plugin that spawns a
third-party binary speaking its own protocol (acp bridging claude/codex over ACP JSON-RPC;
playbox spawning yt-dlp/ffmpeg one-shot) keeps a private contract, because we do not own the
spawned binary's protocol. That is a legitimately different category, not an exception to be
closed.

The engine axis and the plugin-driven service model are otherwise as SIDECARS §1 defines
them; this document is the service-axis wire and lifecycle law that both drive modes share.

## 2. Rules (PS1–PS16)

**PS1 — The core knows no specific service.** The service machinery (ServiceManager, route
branch, mediation, bridges) is generic: it resolves everything from manifest data and the
bind ledger. Zero plugin ids in core source (C1 scan). Zero command-name strings in core
source — dispatch is data-driven off the manifest, never a hardcoded verb. Never park the
mechanism under a feature namespace.

**PS2 — The manifest owns the surface; the service exposes none of its own.** Commands live
in `contributes.commands` — the plugin service adds no CLI, no socket, no file interface.
The command registry is the single control surface (PLUGIN-CONTRACT §5). A repo-internal
harness that drives the service binary directly is unit-level tooling and is **never
completion evidence**; completion and operation are judged only through the registry
(`sok plugin.*`) real path.

**PS3 — Command specs are manifest data.** A `bind:"service"` command declares its full
spec in the manifest: `params`, `description`, `returns`, `danger`, `title`. The registry
registers it from data alone — the forwarding handler is synthesized, never authored.
Declared ≡ actual is bidirectional at spawn: the service's hello `ops[]` must equal the
manifest's `bind:"service"` set exactly; any mismatch in either direction refuses the bind.

**PS4 — `entry: null` is lawful only for a pure contract plugin.** Conditions, enforced by
`parseManifest`: the manifest declares `service`, every command carries `bind:"service"`,
and no code-requiring contribution exists (`views`, `overlays`, `nodes`, `fileViewers`,
`iconSets` are forbidden — each needs a runtime provider or sandbox DOM;
data-only contributions — `programs`, `events`, `skill`, `configuration` — remain lawful).
`headerActions` and `statusItems` are also lawful when they reference a service-bound command:
the host renders them and routes the click, so no plugin callback/provider is required.
Any other `entry: null` combination is rejected. The loader activates such a plugin without
reading an entry module; transparency gates (C2) apply unchanged.

**PS5 — The wire id is `soksak-spec-service`; its provider version is `0.0.1`.** NDJSON both directions over stdio; one JSON
frame per line; a line never exceeds 4 MB — an oversized or unparseable line is a protocol
fault and enters the restart path (PS10), never a silent skip. The first service line is
`hello` (transport protocol version, exact provider `{id, version}`, `ops[]`, `subscribe[]`);
the core matches it against the manifest consumer `{id, range}` with the public SemVer rules,
verifies transport compatibility with the `soksak-spec-socket` verdict grammar, then
answers `ready`. Frames: `req`/`res` (command execution, id-multiplexed), `ev` (progress,
tied to a req id), `act` (activity, standalone), `cmd`/`cmdres` (mediated outbound call),
`push` (subscribed events, core→service), `shutdown`. The error code set is a closed enum
in the proto crate; the core maps any unknown code to `INTERNAL` and never leaks a raw
service string past the envelope.

**PS6 — Contract ids in core source never match the plugin-id grammar.** The C1 scan flags
`soksak-plugin-*` tokens in core; therefore the wire contract is `soksak-spec-service`
and the crate is `soksak-spec-service`. Never mint a contract id that the plugin-id
scanner would sanction. The id follows NAMING §8 (`soksak-spec-<kind>-<domain>`); it appears in
the manifest `service.interface` declaration — amending NAMING §8's surface list to admit
that declaration is part of this legislation, never a silent addition (C4).

**PS7 — The envelope is the message seam.** A service `res` carries `ok`, `code`,
`message`, `hints[]`, `data` as first-class fields — the human sentence is owned by the
command implementation exactly as MESSAGE-PROTOCOL §3 rules, delivered over the wire
instead of a JS closure. The registry accepts envelope-provided `message`/`hints` **only**
for `bind:"service"` commands; every other command keeps the runtime-function seam. A
hint's `cmd` carries the command shape only — never a `sok`/`sok-dev`/`sok-debug` prefix. The
app prepends its own CLI name at the single response seam, so the suggestion runs against this
app's socket, not another environment's; a producer that hardcodes the prefix double-stamps. A
missing message degrades to the label and surfaces in conformance (`messagesMissing`),
never a load-time refusal. Progress `ev` frames map to standard `command.progress`; this
absorbs the A14 adapter role into the protocol for this form (MESSAGE-PROTOCOL amendment
lands with the seam commit).

**PS8 — Interior opaque, boundary transparent.** The core interprets protocol frames and
nothing else — plugin domain data passes through uninspected (A14). Every execution is
visible: a natively dispatched command records `command.executed` on the activity feed with
the same fidelity as the webview path (AI-CONTROL P12); service state transitions
(`spawned`, `draining`, `restarted`, `backoff`, `error`) are published as activity events.
Silent degradation is forbidden.

**PS9 — Bind is declarative and window-free.** Bind = installed ∧ enabled ∧ consented ∧
manifest declares `service`. The boot source is the **bind ledger** — a core-owned derived
file under the identity home (path derivation lives in the proto crate). The app rewrites
the ledger on every enablement/consent/install transition (event-driven, never polled);
the core reads it at boot and binds without any workspace window. Rust never re-parses
manifests — the single judge stays `@soksak-ai/plugin-spec`, and the ledger carries the
already-judged subset. Spawn follows the sidecar staging law (staged real file, atomic
rename, no symlinks), injects `SOKSAK_HOME`, and injects declared secrets into the spawn
environment only — secrets never cross stdio. Bind is idempotent under a generation
counter: two racing binds cannot adopt two processes.

**PS10 — Restart is drain-first; crash is loud.** Environment or secret changes take
effect through a **drain restart**: in-flight ops complete (bounded by the zombie
backstop), new reqs queue bounded, then the process is replaced — triggered by the change
event, never by polling. A crash respawns with exponential backoff (1→2→4→8→16 s, cap 5);
a deterministic immediate exit (death before `ready`) takes no retries — it goes straight
to the error state. The cap and the error state publish `status:"error"` with the reason
on the activity feed and in the plugin status surface. A successful respawn pokes the
plugin's schedules once. `shutdown` grants a drain grace, then SIGKILL; app exit leaves
zero resident service processes.

**PS11 — Routing is native and focus-blind.** A `bind:"service"` command dispatches inside
`route()` directly to the ServiceManager — before, and instead of, the webview emit. No
window is consulted and none is required: the dispatch is identical whatever holds focus,
including the control plane. The route branch records its own `command.executed` outcome.
Window-originated calls reach the same ServiceManager through a synthesized proxy handler,
registered once per window at load from manifest data (never re-registered across service
restarts — the registry's duplicate-throw stands). Execution truth is the ServiceManager
alone; the proxy holds no state.

**PS12 — Delivery is effective-once.** The core stamps every `req` with an idempotency
key; the service deduplicates by key and replays the cached `res` for a repeated key. A
destroyed window's pending bridge entries are cancelled at destruction, never left to
expire. A req's deadline extends while progress `ev` frames arrive, up to the zombie
backstop — long-running ops survive without a webview lease.

**PS13 — Outbound calls are mediated; identity is core-stamped.** A service calls other
commands only through `cmd` frames. The core mediates with the full inbound gate set:
management-command block, danger-tier permission, declared-dependency check — undeclared
target plugins are refused (C3 ladder; never a name-pin convenience). The core stamps
`origin` and `parent` itself — a service's self-reported identity is never trusted. When
a mediated call needs a webview target, the core selects deterministically among the
windows hosting the target plugin — never `LAST_FOCUSED`, never the control plane, and
never by moving focus; with no eligible window the call queues bounded and flushes on
window arrival (event-driven).

**PS14 — Schedules are manifest data with core-owned lifecycle.** `contributes.schedules`
declares triggers as data (`name`, `command`, `params`, `trigger`, `timeoutMs`,
`zombieBackstopMs`). The core stamps `owner` with the plugin id, registers at bind, pokes
once after bind (the boot scan), and cancels by owner at unbind — a service schedule can
never orphan. A schedule firing a `bind:"service"` command dispatches natively (PS11);
it never depends on a window existing.

**PS15 — Inbound events are bridged, deduplicated, delivered once.** hello `subscribe[]`
names bus topics the service consumes. The core bridges window-bus emissions into a
core-side hub with a monotonic `seq` (the ActivityHub discipline), deduplicates across
windows by seq, and pushes each event to the service exactly once. Structure carries this
guarantee — never a documentation warning.

**PS16 — Serialization is the service's law; standards never weaken.** State-mutating ops
execute under a single mutex inside the service — concurrent mutation of shared state is
forbidden by contract, read ops may run concurrently. Every gate this law names is
blocking. A criterion changes only with an explicit problem statement, a versioned
contract change, and matching conformance updates.

**PS17 — The serve loop is a shared harness, not hand-rolled.** The framing every service
needs — line-buffered NDJSON read, one-JSON-per-line write with flush, hello emission,
id-multiplexed req/res, streaming `ev`, close-stdin as EOF, exit on pipe death, the
state-mutation mutex of PS16 — lives once in `soksak-spec-service` as `serve(handlers)`.
A sidecar author writes op handlers and nothing else; the loop is borrowed, never
reimplemented. The core side (ServiceManager framing/routing) and the sidecar side
(`serve`) depend on the same crate — the wire has one source, read from both ends. A future
non-Rust sidecar implements the wire directly against the crate's spec; the Rust `serve` is
the reference, the wire is the standard.

**PS18 — One wire, two drive modes.** The same wire and the same `serve` harness serve both
the **core-routed** mode (the core holds the stdio and routes `bind:"service"` commands —
PS9/PS11) and the **plugin-driven** mode (the plugin JS holds the stdio via `app.process`
and drives the wire with the shared JS client). The plugin-driven mode is the SIDECARS
`service` model, now on the standard wire instead of a private per-plugin contract. A
soksak-authored resident service sidecar (speech, workflow) MUST speak this wire in
whichever mode it runs; it may not invent a private frame shape. Legacy augmentation is part
of this structure (R1): the speech sidecar and its plugin client migrate onto the shared
harness — that migration is the proof the wire is a standard, not a workflow patch.

**PS19 — External-tool adapters are out of scope, by principle not exception.** A plugin
that spawns a **third-party** binary speaking its own protocol (acp → claude/codex over ACP
JSON-RPC; playbox → yt-dlp/ffmpeg one-shot) keeps a private contract, because we do not own
the spawned binary's wire and cannot make it speak ours. This is a distinct category, not an
exception to be closed. The authored-vs-external line is the scope boundary of PS17/PS18:
the shared wire is mandatory only where soksak authors the resident binary.

## 3. Manifest declaration

```jsonc
{
  "entry": null,                          // PS4 — pure contract plugin
  "permissions": ["service", "..."],     // "service" is a caution permission (consent emphasis)
  "sidecars": [
    { "name": "workflow", "interface": {
        "id": "soksak-spec-sidecar-workflow", "range": "0.0.1" },
      "reach": { "fetch": { "url": "...", "sha256": "..." } } }
  ],
  "service": {
    "sidecar": "workflow",                // names the sidecars[] entry that is the resident binary
    "interface": { "id": "soksak-spec-service", "range": "0.0.1" },
                                                // compatible wire requirement (PS5, PS6)
    "subscribe": ["bus:kanban:changed"]   // PS15
  },
  "contributes": {
    "commands": [
      { "name": "run", "title": { "en": "Run", "ko": "실행" },
        "bind": "service",
        "description": "Start a workflow run from a draft document.",
        "params": { "doc": { "type": "string", "required": true } },
        "returns": "object" }
    ],
    "schedules": [
      { "name": "reconcile", "command": "reconcile", "trigger": { "reconcile": true },
        "timeoutMs": 1800000, "zombieBackstopMs": 3600000 }
    ]
  }
}
```

Distribution, staging, naming, and integrity of the binary inherit the sidecar law
unchanged (SIDECARS; `sidecars[].reach` fetch + sha256). The `service` block adds the
core-routing bind and nothing else.

## 4. Gates

| Clause | Gate | Surface |
|---|---|---|
| PS1 | `core-decoupling-scan.mjs` (C1) | `make gates` |
| PS3, PS4 | `parseManifest` fixtures (valid + must-fail) | `make spec-gate` |
| PS5, PS12 | proto crate unit tests + ServiceManager fixture-service tests | `cargo test` |
| PS7 | registry seam tests (service-only acceptance) | `pnpm test` |
| PS9–PS15 | ServiceManager + route + schedule + bridge tests, PS-numbered | `cargo test` / `pnpm test` |
| PS17 | `serve()` harness fixture-sidecar tests (loop, hello, multiplex, EOF) | `cargo test` |
| PS18 | shared JS client tests + speech-sidecar migration on the shared harness | `pnpm test` / `cargo test` |
| PS2 (completion) | `sok plugin.*` real-path scenario gates | e2e |

Every RED test that enforces this law cites its clause number. The CI ledger row for
`make verify` gains the new gates in the same commit that adds them (CI-STATUS discipline).

## Contract identity

- Version: `0.0.1`
- Status: authoritative
- Owner: the public `soksak-spec` repository
- Rust service wire and harness: `soksak-spec-service`
- Plugin manifest schema: the TypeScript platform-spec Git package

---

Version: 0.0.1
Status: AUTHORITATIVE
Single source of truth: public `soksak-spec` source and release artifacts
