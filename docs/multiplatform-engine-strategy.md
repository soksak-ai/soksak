# Multiplatform Engine Strategy — Stay on Tauri, CEF-sidecar-only (2026-07 decision record)

Korean copy: [multiplatform-engine-strategy.ko.md](multiplatform-engine-strategy.ko.md) — the English text is canonical.

## 1. Question and constraints

Find the answer to "Rust as the main language + full JS/TS/React/Svelte frontend freedom + the simplest possible multiplatform desktop." Candidates: Tauri 2, Wails 3, webui, Electrobun, raw wry+tao, Dioxus/Slint/egui/iced, Verso/Servo, Electron.

Four hard constraints:

- C1 — Rust must be the app's primary backend language.
- C2 — The frontend must be free to use the whole JS/TS ecosystem.
- C3 — Content surfaces must do "everything a browser does / everything browser JS can do."
- C4 — Cover every platform, starting with macOS/Linux/Windows and reaching iOS/Android.

C4 reinterpretation (agreed 2026-07-08): mobile weight is lowered on the heuristic that mobile apps are mostly packaged web apps that use no low-level APIs. iOS forbids process spawning, PTY, dylibs, and CEF, so mobile soksak is necessarily a **remote web client** attaching to a desktop/server daemon — the transport abstraction in §7-1 doubles as the mobile path. So C4 in practice is "desktop 3-OS native + mobile as a web client over transport," and mobile is not a deciding factor in engine choice.

## 2. Method and snapshot caveat

2026-07-08: 20 parallel research agents plus adversarial verification of each result's most load-bearing claim (attempt to refute against primary sources). Verdict spread: confirmed 7 / partially-true 4 / refuted 1. Every framework fact in this document is a **2026-07-08 snapshot** — do not cite this snapshot as a future fact without the re-evaluation triggers in §10.

## 3. Verified landscape

| Candidate | 2026-07-08 status (verified) | Verdict |
|---|---|---|
| **Tauri 2** | 2.11.5 stable (2026-07-01), 1–2 week patch cadence. First-class iOS/Android (the only web-frontend framework with both). But `add_child`/multiwebview is still `unstable`-feature-gated (the 2.12 milestone even carries a breaking fix, #15625); Linux webkitgtk graphics failures have env-var workarounds as the official answer | **Winner** |
| Wails 3 | Still alpha (v3.0.0-alpha2.116 nightly, 2026-07-07). Go-only — no non-Go host mechanism (confirmed). Mobile experimental | Fails C1 |
| webui | No stable release ever (latest tag 2.5.0-beta.3, 2025-03); nightly is the official channel. Rust binding absent from crates.io, git-only. Browser mode cannot own window chrome or composite native surfaces | Fails C3/maturity |
| Electrobun | v1.0 (2026-02-06), TS-on-Bun main. **Official Rust main-process SDK committed to `main` 2026-07-04** (2,417 lines + `mainProcess: "rust"` template) — but not in a tagged release (npm latest 1.18.1 is from May). Win/Linux shipped in v1 but with real breakage on all 3 OSes; bus factor 1. No mobile | Eliminated today / **#1 watch item** |
| raw wry+tao | wry 0.55.1 active. But no typed IPC or permission system — "Tauri minus tooling," more work for the same engine | No constraint win, fails simplicity |
| Dioxus / Slint / egui / iced | UI is Rust/RSX/DSL — cannot host a React/Svelte app | Fails C2 |
| Verso | **Repository archived 2025-10-08 (dead)**. `tauri-runtime-verso` has zero releases, no activity since 2025-10-03, GitLab-migration rumor refuted. But Servo itself shipped the `servo` crate 0.1.0 on 2026-04-13 (embeddable engine + LTS) — an engine-as-library signal, not a shell | Eliminated |
| Electron | Rust demoted to napi/sidecar | Fails C1 |

Benchmark footnote (Elanis repo, regenerated 2026-07-05): Tauri Win x64 build ≈3MB. The Tauri Linux CI startup of ≈30.3s is an unexplained anomaly (Wails on the same WebKitGTK posts 245ms — do not cite before real-hardware re-measurement). Win empty-app memory Tauri ≈313MB > Electron ≈275MB (CI only) — do not sell "Tauri is lighter on Windows."

## 4. Structural facts (framework-independent)

- **F1 — iOS forces WebKit.** A single browser engine across all platforms is structurally impossible. As long as C4 holds, the web frontend is forced onto engine-intersection targeting + feature detection.
- **F2 — The skeleton converges.** Webview + per-platform host shell + IPC + plugin mechanism is a shape the platform constraints dictate. Building your own lands on the Tauri shape (Wails = the Go version, Electrobun = the Zig/TS version). Do not spend the innovation budget on the skeleton.
- **F3 — Branching differs by layer.** Rust business logic: no branching. Web frontend: an engine-intersection problem (not Rust). Native surfaces (PTY, webview compositing, dylib loading): per-OS work under any framework.

## 5. Decisions

- **D1 — Stay on Tauri v2.** Rationale: of ~12k Rust LOC, 8–9k is framework-independent; the 36.4k-LOC frontend sits behind an invoke+events boundary. Leaving = re-plumbing 81 commands over IPC on top of the same native porting cost. No surviving alternative (§3).
- **D2 — The browser engine on Windows/Linux is CEF-sidecar-only.** The macOS layer-inversion / hole-punch / hitTest-swizzle subsystem (webview.rs) is **not ported — only replaced.** Windows WebView2 has no hitTest seam (needs CompositionController + a DirectComposition tree); wry's Linux child webview is X11-only (no Wayland, verified). This decision confines `unstable`-feature exposure and the Wayland risk to macOS.
- **D3 — Juxtaposition, no wholesale replacement.** OS webview = the app UI shell / CEF = content surfaces. Replacing the whole UI shell with CEF is not the default plan: Windows OS webview is already Chromium (no gain), going mobile splits the app UI's engine matrix, and it loses Tauri IPC + plugin injection. Keeping the app UI on the OS webview (WebKit intersection) is itself mobile-readiness discipline.
- **D4 — The 7-crate tauri fork (WKWebView leak fix) is per-target gated.** The leak is macOS-only. Win/Linux builds track upstream so fork risk is zero. Add a canary that watches for the upstream leak fix before each rebase (double-free hazard).
- **D5 — The Linux promotion (§7) fires only after a spike measurement.** No pre-adoption.

## 6. Surface promotion rule — per-surface engine routing

D3's juxtaposition generalizes to a per-surface routing rule: **a surface that exceeds the OS webview's guarantees (feature or performance invariant) is promoted to a CEF surface; the rest stay on the OS webview.** The unit of judgment is "plugin surface × platform" — the same surface can have a different answer per platform.

First proof: **astryx** — broken on macOS WKWebView → promoted to a Chromium sidecar surface. The offscreen hosting mode (below) is the mechanism, verified against the engine E2E harness and eyeballed in-app.

- **R1 — Default placement is the OS webview.** Promotion happens only through a plugin manifest declaration. Never promote via code branching or manual placement.
- **R2 — Promotion is justified only by structural inability.** A feature absent from the OS webview, or a documented performance-invariant violation (e.g. [PERFORMANCE.md](PERFORMANCE.md) composite-stretch, webkitgtk's silent WebGL fallback). "A bit slower" is not a reason — on macOS each promotion pays the cost of one more surface in the hole-punch compositing world.
- **R3 — Declaration shape** (plugin-contract sketch — when finalized, the `src/plugins/spec.ts` schema is the single source of truth and this prose is retired):

```ts
engine?: {
  capabilities?: string[]                               // preferred: declare required capabilities ("webgpu", "wasm-threads", ...)
  require?: "chromium-grade"                             // escape hatch: demand it on every platform
  when?: { platform?: ("linux"|"macos"|"windows")[] }   // conditional trigger (e.g. Linux only)
  compositing?: "windowed" | "offscreen"                // hosting mode — SIDECARS.md §8 is canonical
}
```

The compositing axis is proven (2026-07-08): the offscreen hosting mode (shared texture → engine-owned layer) is implemented as additive engine-protocol vocabulary — **zero core change to the feature** (an A9 proof). Pixels, input (mouse/wheel/key/Korean IME), and the cefQuery bridge are asserted by the engine E2E harness. The verified negative knowledge (pixels-over-IPC-into-DOM is impossible) is superseded by this implementation — pixels move only as a GPU handle inside the process. (The separate core-owned host-container isolation is documented in SIDECARS.md and webview.rs.)

- **R4 — "chromium-grade" is an engine grade, not the CEF artifact.** If the platform's OS webview already meets the grade (Windows WebView2 = Chromium), promotion is a no-op. Only a surface needing a pinned engine version forces CEF via a separate declaration.
- **R5 — The verdict is owned solely by the skeleton's routing pure function.** Plugins only declare — they never pick an engine at runtime. The capability × platform support table is owned and maintained by the skeleton. (A13: engine choice is the plugin's; routing is the skeleton's.)
- **R6 — Mobile has no promotion channel** (no CEF). A surface that declares promotion also declares its reduced mode or absence on mobile (the remote web client, §1 C4 reinterpretation).

Default per-platform threshold:

| Platform | OS webview | Expected promotion frequency | Note |
|---|---|---|---|
| macOS | WKWebView | Exceptional | Each promotion pays hole-punch compositing cost — highest threshold. astryx is the exception |
| Windows | WebView2 (Chromium) | Almost never | chromium-grade demand is a no-op; only a pinned-version demand promotes |
| Linux | webkitgtk | Close to default | CEF is resident via D2 — low marginal cost, lowest threshold |
| iOS/Android | (remote web client) | No channel | R6 |

## 7. Linux plan B — full-window CEF promotion estimate

Trigger: only if webkitgtk fails a measurement even for the app UI chrome. Not "a wholesale replacement" but localized to **transport-layer swap + a new serving layer.**

Unchanged (not a cost): all of React (CEF = Chromium, so webkitgtk workarounds shrink), the whole Rust backend, the plugin view layer (DOM mount), bundle weight (CEF is loaded anyway via D2), window management (keep the tao window + CEF as a full-window X11 child).

Work list:

1. **Transport abstraction (the body of the work).** invoke/events are wry-injected scripts, absent in CEF. Add an invoke-transport ↔ websocket-transport abstraction on the frontend, and open the sok daemon to the UI over WebSocket + a local auth token. Because commands are one registry + one envelope, a single adapter moves them all. This abstraction is not a one-off cost but a permanent asset (a framework-exit option, a remote-UI possibility — the completion of ARCHITECTURE.md A13).
2. `asset://` replacement — a CEF custom-scheme handler or local HTTP serving (reuse the mediaproxy pattern).
3. Bootstrap injection — init script + theme CSS variables via the `OnContextCreated` path.
4. `tauri-plugin-webview-capture` replacement — CEF native capture (easier on the Chromium side). Other plugins are Rust commands, so they resolve automatically once they ride the transport.
5. Verification — X11 IME (Korean input), DnD, multiwindow focus, Wayland/Ozone.

Bonus: once the UI is CEF too, the hole-punch problem vanishes on Linux — compose the UI view + content browser view inside a single Chromium world (isomorphic to Electron's WebContentsView model, Rust retained).

## 8. Risk register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | `add_child` unstable-gated, no stabilization commitment (2.12 has breaking fix #15625) | High | D2 confines exposure to macOS; pin Tauri minor; keep the A13 interface so macOS can also move to CEF later |
| 2 | Tauri v3 rework beneath you (tao→winit, GTK4, 1st-party CEF/Servo runtime previews; milestone ~27%) | Med-High | Do not early-adopt v3; treat the 1st-party CEF runtime as a convergence opportunity with the sidecar investment |
| 3 | Fork maintenance + double-free hazard when upstream fixes the leak | Med | D4 per-target gate; keep the `with_webview_balanced` fallback; changelog canary before rebase |
| 4 | Linux webkitgtk graphics failures (main DOM webview) | Med | Isolate GPU-heavy content to CEF panels; ship DMABUF/NVIDIA env-var fallbacks; consider DOM renderer for Linux xterm; do not judge the 30s CI number before real-hardware re-measurement |
| 5 | Wayland: wry child webview is X11-only | High→Low | D2 removes wry-child use on Linux entirely; verify CEF Wayland/Ozone in the spike; XWayland is the last-resort fallback |
| 6 | CEF Win/Linux surface work unproven (HWND pump, X11 reparenting, helper-process family, engine-payload signing) | High | Time-box via the §9 spike; resolve signing/notarization in the same milestone |
| 7 | `ipc.rs`/CLI does not compile on Windows (`std::os::unix` hard import) | Med | tokio named pipes or AF_UNIX-on-Windows behind the existing socket abstraction; fix .app-bundle path assumptions |
| 8 | Media-proxy TLS-fingerprint fragility (wreq rc pin; native-tls JA3 verified on macOS only) | Med | Promote wreq (same forged Chrome fingerprint on all OSes) to primary; per-platform CDN-403 canary |
| 9 | Windows distribution friction (HSM signing, SmartScreen, WebView2 bootstrap) | Low-Med | Azure Key Vault signing (official Tauri path); evergreen bootstrapper |
| 10 | Electrobun as a strategic fast-follower (the only other candidate answering Rust-main + child-webview layering at once) | Informational | Re-evaluate per §10; the transport abstraction (§7-1) bounds the exit cost |

## 9. Spike plan (time-boxed)

- **S1 — Windows first**: a blank CEF panel inside a Tauri window (HWND parenting, Win32 message pump, `CefDoMessageLoopWork`). HWND parenting is the easier case than the macOS NSView path.
- **S2 — Linux**: the same X11 reparenting experiment + CEF Wayland/Ozone status + a real-hardware measurement of the webkitgtk main webview (data for risk 4).
- **S3 — Plan B estimate (1 day)**: a full-window CEF + WebSocket-invoke prototype. Secure the estimate regardless of whether §7 fires.
- Side track: risk 7 (ipc.rs on Windows), engine-payload signing.

## 10. Watch items and re-evaluation triggers

- **Electrobun**: re-evaluate once the Rust main-process reaches a tagged release and stabilizes (target: two quarters out). Not a candidate before then.
- **Tauri v3**: review convergence with the D2 sidecar when a 1st-party CEF/Servo runtime preview ships. Re-evaluate immediately if a signal to remove `add_child` appears.
- **servo crate**: track only the LTS line's maturity at release-note level. Do not track the Verso lineage (confirmed dead).
- **Upstream WKWebView leak fix** merged → fire the D4 canary, review dismantling the fork.

## References

- Related docs: [ARCHITECTURE.md](ARCHITECTURE.md) (A13 engine neutrality, A14 sidecar), [SIDECARS.md](SIDECARS.md), [PERFORMANCE.md](PERFORMANCE.md), [webview-leak-fix.md](webview-leak-fix.md)
- Primary sources (verified at research time): tauri 2.11.5 release + docs.rs unstable-gate marking, wailsapp/wails releases API (alpha2.116), webui-dev/webui releases API (zero stable), blackboardsh/electrobun main commits (2026-07-04 "rust main process") + npm dist-tags, versotile-org/verso archive banner (2025-10-08), servo.org blog (0.1.0, 2026-04-13), Elanis/web-to-desktop-framework-comparison (regenerated 2026-07-05)
