# Sidecars (v1)

Normative definition of sidecars: shared binaries consumed by plugins. This document
owns the taxonomy, the engine-model C ABI, lifecycle, plugin declaration, and
distribution. PLUGIN-CONTRACT.md §5 defers here for the engine model.

## 1. Taxonomy

The classification axis is **who consumes the contract**:

- **Sidecar** — consumed by *plugins*. A shared binary that plugins drive over a
  private protocol. The core is a blind host/relay: it never understands the
  messages. Never exposed in the `sok` command registry.
- **Extension (core extension)** — consumed by the *core capability seam*: a
  provider of a core capability (e.g. a transport provider). Different concept,
  reserved name; out of scope here.

Sidecars come in two **models** (an orthogonal axis: runtime shape, not identity):

| | `service` | `engine` |
|---|---|---|
| Runs as | separate process (`app.process` spawn) | in-process dylib (core dlopen) |
| Surface | none (headless) | renders into pane surfaces (NSView) |
| Channel | stdio (spawner-bound — see the wire rule below); or NDJSON over a UDS for a survival service (§1 survival clause) | opaque JSON over the hosting ABI |
| Self-description | none (manifest-less, unchanged standard) | exported C symbols (binary is the single truth) |
| Core awareness | none — core doesn't know it is a sidecar | loads + verifies + relays, understands nothing |

Why `engine` must be in-process: on macOS a parent NSView is process-local — a
separate process cannot attach a child view to the app's windows, and the
engine's message pump needs the app's main queue. Loaded into the app process,
it still runs "not as a separate app" (no Dock, no own windows).

**The service `Channel` wire (re-legislated, C4/C5 — 2026-07-11).** The stdio channel
was originally "an argv/stdin private contract" — each plugin invented its own frame
shape. A whole-body investigation found the same NDJSON serve loop hand-rolled across
workflow, speech (mascot/sherpa), and others, with gratuitously different framing. The
service axis now has **one wire and one serve harness**: `soksak-service-spec@1`,
legislated in docs/PLUGIN-SERVICE.md, mandatory for **soksak-authored resident service
sidecars**. **External-tool adapters** — a plugin spawning a third-party binary that
speaks its own protocol (acp → claude/codex over ACP; media pipelines → yt-dlp/ffmpeg
one-shot) — keep a private contract, because we do not own the spawned binary's wire.
The engine axis is untouched, and A14's "unifying the three wires" stays out of scope —
this consolidates only within the stdio-service axis.

The service axis runs in two drive modes on that one wire: **plugin-driven** (core-blind
— the plugin JS spawns and drives it, the row above) and **core-routed** (the core
spawns, frames, and routes its `bind:"service"` commands — declared with a manifest
`service` block, `entry: null` lawful). Both are legislated in docs/PLUGIN-SERVICE.md.
"Plugin service" is the core-routed mode; never call it "service sidecar".

**A survival service uses UDS, not stdio (legislated by the terminal-mirror plan, C4/C5 —
2026-07-12).** Both drive modes above bind the service's lifetime to a pipe: a stdio
service dies when the spawner's fd closes. A **survival service** must outlive every
process that spawned it — `soksak-sidecar-terminal-mirror` (§9) checkpoints shells that
themselves survive an app exit, so it cannot die with the app. It therefore does not use
stdio; it binds a rendezvous socket in the identity home and is reached over NDJSON on that
UDS, with a singleton probe on start and a detached spawn (`process.detached`) — the same
transport shape as the core PTY daemon it peers with. This is a distinct point on the wire
axis, not an exception to `soksak-service-spec@1`: that spec frames spawner-bound stdio
services; a survival service is reached by socket precisely because its reason to exist is
to not share the spawner's lifetime. Its own contract carries the message shapes
(`soksak-sidecar-terminal-mirror-spec@1`), the `hello` handshake isomorphic to the daemon's.

**Names never encode the model** (`soksak-sidecar-<name>` for both): the model is
machine-encoded (attachment path, artifact kind, ABI self-report); putting it in
the name would create a second, driftable truth.

## 2. Layout & naming

```
~/.soksak/sidecars/soksak-sidecar-{name}/
  dist/
    soksak-sidecar-{name}            # service model: executable (existing standard)
    soksak-sidecar-{name}.dylib      # engine model: the module
    ...engine runtime payload...     # e.g. framework + helper .apps (engine-owned)
```

- `{name}`: `^[a-z0-9][a-z0-9-]*$` (used in path assembly — traversal-safe).
- No ambient env binary override — the identity home's `sidecars/` directory is the only
  resolution path (A17); dev stages into its own home via `stage.sh`.
- Diagnostics env belongs to the sidecar: `SOKSAK_SIDECAR_{NAME}_*`. Core env
  never carries engine names (NAMING.md).
- No PATH exposure; no `sok` registry surface. Both inherited from the original
  sidecar standard.

## 3. Engine hosting ABI — `soksak-sidecar-engine ABI` v1 (normative)

Two layers: the **hosting ABI** (u32 version, exact match — how any engine module
is loaded and driven; the core validates this) and the **interface id**
(`"<protocol>@<major>"` string — what the messages mean; the core only compares
it against the plugin's declaration and relays).

Module exports (all `#[no_mangle] extern "C"`, every body `catch_unwind`-wrapped —
no unwinding crosses the boundary in either direction; a trapped panic returns -2):

```rust
#[repr(C)] struct SoksakSidecarEngineAbi {
    abi: u32,                 // hosting ABI version — core accepts exactly 1
    interface: *const c_char, // e.g. "soksak-sidecar-browser-spec@1"
    version: *const c_char,   // crate semver (diagnostics)
}
fn soksak_sidecar_engine_abi() -> *const SoksakSidecarEngineAbi;    // self-description handshake
// The model declaration IS the symbol family itself: exporting soksak_sidecar_engine_* = engine
// model. No model field — a field restating what the symbols already prove could drift.

#[repr(C)] struct SoksakSidecarEngineHost {
    abi: u32, ctx: *mut c_void,
    emit: extern "C" fn(ctx, json: *const u8, len: usize),  // module→host event (any thread)
    log:  extern "C" fn(ctx, level: i32, msg: *const u8, len: usize),
}
fn soksak_sidecar_engine_init(host: *const SoksakSidecarEngineHost, cfg_json: *const u8, len: usize) -> i32;
    // once per process, MAIN THREAD (host guarantees). cfg = {"name", "distDir"} only —
    // engine-specific paths derive from distDir (own-location resolution).

#[repr(C)] struct SoksakBuf { ptr: *mut u8, len: usize, cap: usize }
fn soksak_sidecar_engine_message(req: *const u8, len: usize, surface: usize,
                         reply: *mut SoksakBuf) -> i32;
    // opaque request → synchronous JSON reply (module allocates; host must call free).
    // surface = calling window's parent view (NSView as usize), host-injected on every
    // call; the module uses it only where its protocol needs it (e.g. create).
    // Callable from ANY thread — modules queue real work to the main queue internally.
    // Return: 0 ok, -1 protocol error (reply = {"error": ...}), -2 trapped panic.
fn soksak_sidecar_engine_notify(evt: *const u8, len: usize);   // host→module fact, fire-and-forget
fn soksak_sidecar_engine_free(buf: SoksakBuf);
fn soksak_sidecar_engine_shutdown();                            // app exit only, main thread
```

Host notifications (v1): `{"type":"surface-occluded","window":<label>,"occluded":bool}`;
`{"type":"surface-closing","view":<usize>}` — teardown-order contract: the host sends this
on the window's CloseRequested (main thread), and the engine MUST close every child parented
to that surface before the window deallocates. A window never dies under a live engine view —
this rule structurally prevents the wedged-close class (a zombie window that stays in the
window list with a dead webview and unreleased project claims).
— fanned out to every loaded module when a DOM overlay opens/closes over content.

Versioning: additive JSON fields within a major; breaking protocol → interface
`@2`; new host capabilities → new optional symbols (resolved tolerantly).
The `surface` parameter is ambient because every engine is surface-bound by
definition — a future pdf/video engine reuses this ABI unchanged.

Handshake order (core, on first `open`): dlopen → resolve **all** symbols (any
missing = refuse, no partial load — the symbol family's presence IS the model claim) →
`soksak_sidecar_engine_abi()` → check `abi == 1`, `interface ==` plugin declaration (mismatch names
both strings) → `init` on the main thread (rendezvous, 10s timeout) → register.

## 4. Lifecycle

- Loading is **plugin-driven**: nothing loads at app start; the first
  `app.sidecar.open(name)` loads. Loaded = enabled (no env gates).
- Engine modules are **never unloaded**. Chromium-class engines initialize once
  per process and live children reference module code — the core intentionally
  leaks the library handle. `close()` releases only the caller's event channel.
- Repeat `open` reuses the loaded module (new channel handle per caller).
- `soksak_sidecar_engine_shutdown` runs only at app exit (RunEvent, main thread).

## 5. Plugin declaration, permission, conformance

Plugins declare sidecars in the manifest (top-level, parallel to `libraries`):

```json
"permissions": ["sidecar"],
"sidecars": [
  { "name": "chromium", "interface": "soksak-sidecar-browser-spec@1",
    "reach": { "fetch": { "url": { "darwin": "https://.../dist.tar.gz" },
                           "sha256": { "darwin": "<hex>" } } } }
]
```

- `"sidecar"` permission (caution): loads native code into the app process —
  strongest class, disclosed on the consent screen together with the declared
  names/interfaces.
- `app.sidecar.open(name)` is gated to declared names (undeclared = throw), and
  the declared `interface` is verified against the binary self-report at load —
  declared ≡ actual on both sides. Declared-but-never-opened is legal (lazy).
- `reach` is fetch-only (command/vendor are library-axis concepts). Omitted
  reach = dev staging expected (`make sidecar-<name>`).

## 6. Distribution

Install chain (all pinned): plugin install → `sidecars[]` declared → on first
`open`, `sidecar_ensure` provisions if the dylib entry is absent: download →
sha256 pin → unpack (bsdtar, preserves symlinks/exec bits) → entry check →
atomic rename into `dist/`. Any failure leaves the destination untouched.
The archive contains the **contents of `dist/`** at top level.

Dev: `make sidecar-browser-chromium` stages from the engine crate's build output;
`make sidecar-browser-chromium-archive` emits the pinned tar.gz + sha256 for the
manifest. Production signing/notarization of engine payloads is deferred and
tracked here: dev runs ad-hoc signed (the Chromium engine avoids the keychain
prompt via its in-memory profile).

## 7. Authoring an engine sidecar

Skeleton (see the `soksak-ai/soksak-sidecar-browser-chromium` repo — the reference
implementation; its dev checkout lives at the sidecar home):

```
soksak-sidecar-<name>/   (independent repo; dev checkout = the sidecar home)
  Cargo.toml          # cdylib (+ helper [[bin]] if the engine spawns subprocesses)
  src/lib.rs          # ABI surface: exports above, catch_unwind edges, JSON dispatch
  src/engine.rs       # the engine itself
  README.md           # provenance/attribution — the only docs where a consumed
                      # library's name may appear (NAMING.md §2)
```

Rules:
- The crate is standalone (own workspace) and tauri-independent — nothing tauri
  crosses the ABI. The host passes surfaces as raw handles and events go through
  the host vtable.
- Main-thread work is the module's responsibility to queue (the host guarantees
  main thread only for init/shutdown).
- Subprocess-spawning engines (Chromium) own a dedicated helper binary staged as
  macOS `.app` variants (base/Renderer/GPU/Plugin/Alerts) — Chromium launches
  renderers from the `" Helper (Renderer).app"` sibling bundle and fails
  silently without it.

## 8. Chromium engine protocol — `soksak-sidecar-browser-spec@1`

Requests: `caps()→{modes}`, `create(x,y,w,h,url[,mode,scale,owner])→{id}`,
`devtools-open(inspectedId,screencast,x,y,w,h[,owner])→{id}`, `bounds(id,x,y,w,h)`,
`load(id,url)`, `reload(id,ignoreCache)`, `stop(id)`, `back(id)`, `forward(id)`,
`hidden(id,hidden)`, `focus(id)`, `close(id)`,
`eval(id,js)→{ok,evalId}` (host-initiated page JS; the js runs as an async
function body and must `return` a JSON-serializable value — the result arrives
asynchronously as an `eval-result` event; CSP-safe, no eval() in page context),
`stats()→{ids,surfaces:[{id,owner,offscreen}],dbg}`,
`popup-mode(asWindow)`, `query-reply(queryId,success,response[,errorCode,keep])`.

Ownership: `owner` tags the creator (plugin id) and the engine records it —
the engine is the single truth for which surfaces exist and who owns them.
Consumers MUST reconcile from `stats.surfaces` filtered to their own owner;
never reap from a consumer-local ledger (ledgers get lost across reloads and
leave undead surfaces — observed live), and never close a surface owned by
someone else. Empty owner = untagged legacy consumer.
Events: `nav {id,url}`, `title {id,title}`,
`favicon {id,url,urls}` (content fact, same shape as title — url is the first
candidate, empty when the page has none so consumers clear stale icons),
`eval-result {id,evalId,ok,value}` (completion of an `eval` request),
`loading {id,loading,canBack,canForward}` (drives a consumer spinner / stop
button and back/forward enablement — fires on every load-state transition),
`popup-url {id,url}` (new-link routing when popup-mode is "tab"; `id` is the
source browser so multi-window adapters consume only their own),
`query {id,queryId,request}` / `query-canceled {queryId}` (page↔host bridge),
`surface-created {view}` / `surface-destroyed {view}` (windowed only),
`cursor {id,type}` (offscreen only).

### Hosting modes

`create.mode` selects the hosting mode (additive field; absent = `"windowed"`).
The mode never appears in artifact/interface/env names — it is protocol
vocabulary only (NAMING.md §5/§8).

- **`windowed`** (default) — the engine owns a native child view attached under
  the ambient `surface` and emits `surface-created`/`surface-destroyed` so the
  core folds it into hit-testing; input reaches the engine view natively inside
  DOM holes.
- **`offscreen`** — the engine renders off-screen and presents into a
  layer-backed view it owns, inserted under the ambient `surface` below the main
  webview. Rules:
  - `create.scale` (devicePixelRatio) sizes the backing store; `bounds` stays
    logical px, identical to windowed.
  - The pixel path never leaves the process: engine-internal GPU texture →
    engine-owned layer. Frame data must not cross the host vtable, IPC, or JS.
  - The engine does NOT emit `surface-created` — the view takes no part in
    hit-testing. The DOM cell above keeps every input event and the consuming
    plugin forwards input over the protocol (below). `cursor {id,type}` lets
    the plugin mirror the engine cursor onto the cell.
  - `surface-occluded`/`resize-gesture` notifies apply unchanged; occluded =
    painting pauses.
  - Frame driving: the engine invalidates off-screen surfaces while the render
    loop is active (during load / input / animation) so frames land through
    page load without a manual nudge; when activity settles the loop stops and
    the last frame persists on the layer (zero idle cost). Purely animated
    content therefore freezes on its last frame after the idle window until the
    next input — acceptable for v1.
  - Cell transparency: the consuming plugin's DOM cell and every ancestor up to
    the webview root must be transparent, or the hole shows the opaque DOM
    instead of the engine layer beneath the main webview.
  - One surface per view. Offscreen views share the window content view as their
    parent, so two surfaces with overlapping bounds stack and the older one
    occludes the active cell — navigation moves the URL while the pixels stay
    stale. The host re-mounts a view on reparent/re-activate; the consuming
    plugin MUST close the view's prior surface before creating the next and drop
    a create that a newer mount superseded. Never leave a view holding two.
  - Parking a view (tab unpark/park) does not close its surface — send
    `hidden(id,true)` when the cell leaves the viewport, or the parked surface
    keeps compositing over whatever is shown. `hidden(id,false)` on return.
  - Every id-addressed request works identically on offscreen ids, `close(id)`
    included (a windowless browser reaps through the normal CEF close — no native
    view to tear down); `stats` reports both modes.

Input forwarding (offscreen only; coordinates are surface-local CSS px):
`mouse(id,kind:"move"|"down"|"up",x,y[,button,clicks,mods])`,
`wheel(id,x,y,dx,dy[,phase])` — momentum phase is forwarded, never synthesized,
`key(id,kind:"down"|"up"|"char",code[,char,mods])`,
`ime(id,kind:"set"|"commit"|"finish"|"cancel"[,text,caret])`.
Composition text comes from the DOM's native IME (the cell's hidden editable),
bridged as `ime` messages — synthesizing key events to fake composition is
prohibited.

`caps` reports `{ok, modes:[…], version}` for feature detection before `create`;
a build without off-screen support reports `modes:["windowed"]` and consumers
must not send `mode:"offscreen"` to it. `version` is the resident-module
identity probe: a dylib replaced on disk never affects the already-loaded
module (§4 never-unload), so E2E must verify `caps.version` matches the
expected build before trusting results — do not assume disk state equals
loaded state.

Popup widgets (`<select>` dropdowns, autocomplete) ARE composited: PET_POPUP
frames land on a sublayer above the view layer, driven by on_popup_show/size
(view-local DIP rect, y-flipped into layer geometry). Remaining v1 offscreen
limitation (explicit, not silent): the engine context menu is not composited.
In-page UI (anchor-positioned popovers, the design-canvas pattern) was never
affected.
Diagnostics: `stats.dbg.framesPresented` counts presented offscreen frames
(0 while idle/hidden is correct — presents stop when nothing changes).

## 9. Terminal-mirror service — `soksak-sidecar-terminal-mirror-spec@1`

A **service-model survival sidecar** (§1): headless, separate process, reached over NDJSON
on a UDS in the identity home. It owns the terminal domain's screen work — the VT mirror,
ANSI serialization, and checkpoint policy — while the core PTY daemon (`soksak-ptyd`) keeps
byte survival, the raw ring with a monotonic sequence, the tee face, and a content-agnostic
sealed-blob store (ARCHITECTURE A13; RESTORE.md). The full contract lives in the sidecar
repo's `SPEC.md`; this entry is the core-doc index.

- **Consumers:** the terminal plugin *family*, not one plugin. `soksak-plugin-terminal`
  (xterm) declares `sidecars: [{ "name": "terminal-mirror", "interface":
  "soksak-sidecar-terminal-mirror-spec@1" }]`; a ghostty terminal plugin declares the
  identical entry. One binary, one contract, shared — input is a raw byte stream and output
  is ANSI paint, so no consumer couples to the engine.
- **Two faces:** a *server* face — plugins request `rehydrate`/`coldPaint`/`status` for
  warm/cold restore — and a *consumer* face — the sidecar subscribes to the daemon tee and
  pushes serialized plaintext to the daemon's sealed-blob store; it never touches a key.
- **Discovery / spawn:** the consuming plugin spawns it through the `process` capability
  with the detached option; the core resolves `cmd "sidecar:terminal-mirror"` via
  `resolve_sidecar_cmd` (src-tauri/src/process.rs) to
  `<home>/sidecars/soksak-sidecar-terminal-mirror/dist/soksak-sidecar-terminal-mirror` —
  the identity home is the only resolution path (A17); no PATH, no `sok` registry (§2).
- **Failure:** sidecar death leaves shells and the live path untouched (the daemon owns
  byte survival); only restore fidelity degrades, announced loudly, with a fall to the seal
  path (the plugin fetches the sealed blob from the daemon and opens it with the app vault)
  and a respawn. Never silent.
- **Engine:** the VT state machine (alacritty_terminal today) is an internal, replaceable
  dependency — it names nothing in the contract, the messages, or the artifact (§1,
  NAMING.md §2).
