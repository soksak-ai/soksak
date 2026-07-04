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
| Channel | stdio (argv/stdin private contract) | opaque JSON over the hosting ABI |
| Self-description | none (manifest-less, unchanged standard) | exported C symbols (binary is the single truth) |
| Core awareness | none — core doesn't know it is a sidecar | loads + verifies + relays, understands nothing |

Why `engine` must be in-process: on macOS a parent NSView is process-local — a
separate process cannot attach a child view to the app's windows, and the
engine's message pump needs the app's main queue. Loaded into the app process,
it still runs "not as a separate app" (no Dock, no own windows).

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

Requests: `create(x,y,w,h,url)→{id}`, `bounds(id,x,y,w,h)`, `load(id,url)`,
`reload(id,ignoreCache)`, `back(id)`, `forward(id)`, `hidden(id,hidden)`,
`focus(id)`, `devtools(id)` (toggle — opens a separate native DevTools window),
`close(id)`, `popup-mode(asWindow)`.
Events: `{event:"popup-url", url, id}` — new-link routing when popup-mode is
"tab"; `id` is the source browser so multi-window adapters consume only their
own. Reserved (follow-up): `nav`, `title` (urlbar sync).
