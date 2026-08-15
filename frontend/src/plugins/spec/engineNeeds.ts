// What a surface requires of the rendering engine — neither the framework nor the OS is named.
//
// Three axes point at different things:
//   framework = Tauri | Electron        — what provides windows, IPC, native API, packaging
//   platform  = macOS | Linux | Windows — the operating system
//   engine    = WKWebView | Chromium | WebKitGTK — what renders the web
//
// A plugin states only **what its own surface requires**. How that is met is determined by the
// framework × platform combination:
//
//   requiresEngine: "chromium"
//     Tauri × macOS    → WKWebView falls short → promoted to a Chromium sidecar
//     Tauri × Windows  → WebView2 is already Chromium → promotion is a no-op
//     Electron × all   → the framework is Chromium → promotion is a no-op
//
// This table is why a framework name must not be written here. astryx was the first case promoted
// to a Chromium surface because it does not run on macOS WKWebView, and writing that as
// `not: ["electron"]` **would hide that it runs better on Electron.** Electron does not meet the
// requirement less, it meets it more. The axis is inverted.
//
// Basis: docs/multiplatform-engine-strategy.md R4 ("chromium-grade is a grade, not an artefact —
// promotion is a no-op when the platform's OS webview already meets the grade") and §6 ("the unit
// of judgement is surface × platform").

/** The engine grade a surface requires. Unset = grade-independent (default). */
export type EngineGrade = "chromium";

/** What one framework actually provides. The adapter fills this with its own facts. */
export interface EngineProvision {
  /** Whether the webview of this framework/OS combination is chromium grade. */
  chromium: boolean;
  /**
   * Whether a native child webview can be composited onto the window.
   *
   * Tauri/macOS provides it with hole-punch and hitTest swizzling. Electron does not need that
   * machinery at all because its own world is Chromium — it does not fail to provide it, it
   * **does the same thing another way.** So on a framework where this is false, only surfaces
   * that presume a child webview drop out.
   */
  nativeChildWebview: boolean;
  /**
   * Whether an **engine module can be loaded** into this process — dlopen + main thread + window.
   *
   * A different axis from the child view. Of the two composition modes in SIDECARS.md §8, only
   * `windowed` uses a child view; in `offscreen` the engine renders into its own layer (pixels
   * move only through an in-process GPU handle). What both require is not a child view but
   * **whether the module can be brought into this process**.
   *
   * Merging the two axes rejects an offscreen consumer for the wrong reason — the outcome is the
   * same, but a false reason sends the next person to fix the wrong thing.
   */
  engineModules: boolean;
  /** Whether document-start injection is guaranteed before a navigation's first document script. */
  supportsDocumentStart: boolean;
  /** Whether the engine's real user input path can be injected, not a synthetic event. */
  supportsInputInjection: boolean;
}

/** The needs a plugin declares. Each is optional — unwritten means no requirement. */
export interface EngineNeeds {
  requiresEngine?: EngineGrade;
  requiresNativeChildWebview?: boolean;
  /** Whether an engine module must be loaded into this process (independent of composition mode). */
  requiresEngineModules?: boolean;
}

/** The needs that are not met. Empty means it can be loaded. */
export function unmetNeeds(needs: EngineNeeds, has: EngineProvision): string[] {
  const unmet: string[] = [];
  if (needs.requiresEngine === "chromium" && !has.chromium) {
    unmet.push("requiresEngine=chromium");
  }
  if (needs.requiresNativeChildWebview && !has.nativeChildWebview) {
    unmet.push("requiresNativeChildWebview");
  }
  if (needs.requiresEngineModules && !has.engineModules) {
    unmet.push("requiresEngineModules");
  }
  return unmet;
}
