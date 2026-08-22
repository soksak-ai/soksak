import type { EngineProvision } from "../plugins/spec";
// App framework contract — the boundary that hides "which framework does this app run on" from the app.
//
// Framework here means Tauri and Electron. Window and webview creation, IPC, native API, and packaging
// come together, so framework is the word that covers all of it. This was once called "shell", but that
// word already names the login shell (zsh, bash), and this repository treats PTY and terminals as core,
// so that collision is real (login_shell.rs, --login-shell, shell_which).
//
// Rule: app code never calls a framework vendor SDK directly. One such call makes the vendor an
// unreplaceable premise, and a replacement attempt then means tearing open 57 files at once (measured
// 2026-07-27: 57 files imported @tauri-apps directly, 193 invoke call sites). Only one file — the
// adapter — references the vendor, and a static gate (frameworkSeam.test.ts) enforces that rule.
//
// This file holds **only what is actually used**. Declaring an unused capability up front leaves a blank
// in every adapter that cannot implement it, and blanks end up filled by vendor bypasses.

/** Unsubscribe — must be idempotent (a duplicate call does not throw). */
export type Unlisten = () => void;

/** Event envelope — fields differ per framework, so this narrows to one payload. */
export interface FrameworkEvent<T> {
  payload: T;
}

/**
 * Stream sink. The core creates it and passes it as a command argument, and the backend pushes frames
 * into it (terminal output, process stdout/stderr, socket messages). The form serialized into the
 * argument differs per framework, so it is **opaque** — the app uses onmessage and nothing else.
 */
export interface Stream<T> {
  /** Frames received before assignment are delivered in order when the handler is installed. */
  onmessage: (msg: T) => void;
}

/** Operation surface for one window — the current window, or one found by label. */
export interface FrameworkWindowHandle {
  readonly label: string;
  setTitle(title: string): Promise<void>;
  /** Logical pixels (scale divided out) — the framework converts to physical pixels. */
  setSize(width: number, height: number): Promise<void>;
  setPosition(x: number, y: number): Promise<void>;
  setFocus(): Promise<void>;
  /** Brightness mode of the window chrome (native exterior). Unsupported platforms ignore it harmlessly. */
  setTheme(mode: "light" | "dark"): Promise<void>;
  /** Physical pixel axis — used when automation and restore handle screen coordinates directly (separate from the logical axis). */
  outerPosition(): Promise<{ x: number; y: number }>;
  /** Screen coordinates (physical) of the window content area — the origin with window chrome subtracted. */
  innerPosition(): Promise<{ x: number; y: number }>;
  outerSize(): Promise<{ width: number; height: number }>;
  scaleFactor(): Promise<number>;
  setPhysicalPosition(x: number, y: number): Promise<void>;
  setPhysicalSize(width: number, height: number): Promise<void>;
  setAlwaysOnTop(on: boolean): Promise<void>;
  maximize(): Promise<void>;
  unmaximize(): Promise<void>;
  onResized(cb: (size: { width: number; height: number }) => void): Promise<Unlisten>;
  onMoved(cb: (pos: { x: number; y: number }) => void): Promise<Unlisten>;
  onDragDrop(cb: (event: unknown) => void): Promise<Unlisten>;
  /** A window of this application is going away, named by its label.
   *
   *  Every window is told, including the one that is closing: a document about to be torn down
   *  acting on it changes nothing, and filtering here would make the host decide which documents
   *  care. What it is for is whatever was kept under that label — a session in a separate process
   *  outlives the window that opened it, and no other reading reports that the window has gone. */
  onWindowGone(cb: (windowLabel: string) => void): Promise<Unlisten>;
  /** Receives only events **targeted** at this window (not a global broadcast). */
  listen<T>(event: string, cb: (e: FrameworkEvent<T>) => void): Promise<Unlisten>;
}

/**
 * The framework's answer for one axis. Absence is answered as absence, **with a reason**.
 *
 * Why absence is answered as a value: a silent no-op makes the caller treat the capability as present
 * and draw accordingly. The same holds for judgment — unmeasured cells and measured-but-wrong cells end
 * up in one pile.
 */
export type TitlebarCompositionFacet =
  | { readonly provided: true }
  | { readonly provided: false; readonly reason: string };

/**
 * Traffic light (window control button) composition — the facts this framework can answer about window
 * chrome.
 *
 * Why it is in the contract: splitting this axis by name (`framework === "electron"`) makes the judgment
 * read a name instead of a capability. A name-reading judgment keeps refusing on the day the capability
 * arrives, and has no answer at all on the day a third framework arrives. If an adapter omits it,
 * compilation fails.
 *
 * The three axes are different facts, so they are not folded into one boolean: backing can be drawn even
 * when positions cannot be read, and the ledger can exist without backing.
 */
export interface TitlebarCompositionProvision {
  /** Whether the physical rect of the native traffic light buttons is readable from a public surface — the axis to compare against the DOM reservation. */
  readonly buttonPositions: TitlebarCompositionFacet;
  /** Whether this framework owns and draws the opaque backing plane behind the traffic lights. */
  readonly backingPlane: TitlebarCompositionFacet;
  /** Whether a single paint owner ledger records who placed the buttons last. */
  readonly paintOwner: TitlebarCompositionFacet;
}

export interface FrameworkNotification {
  isPermissionGranted(): Promise<boolean>;
  requestPermission(): Promise<string>;
  send(options: {
    title: string;
    body?: string;
    actionTypeId?: string;
    extra?: Record<string, unknown>;
  }): void;
  /** Notification click — the app reads only the extra attached at send time (routing information). */
  onAction(cb: (action: { extra?: Record<string, unknown> }) => void): Promise<Unlisten>;
}

export interface AppFramework {
  /**
   * Deliver an event to this window's subscribers **directly** — without crossing the framework.
   *
   * Some events that happen inside a window are already available inside that window. In a framework
   * where the content view is in the DOM, events such as navigation, title, and load are already in this
   * renderer, and sending them out of the process and back is a round trip to itself.
   *
   * The name and the payload must be **identical** to what the framework emits — subscribers get no
   * origin information, and a difference makes the same code see different things per framework.
   */
  emitLocal(event: string, payload: unknown): void;

  /**
   * Turn one file of an installed plugin into **an address the webview can fetch directly**.
   *
   * The scope is the active plugin paths declared by settings. The framework rejects any other path.
   *
   * Why it is in the contract: the amount moved at boot is the wait, and a value crossing a process
   * boundary is serialized as a string. Measured 2026-08-08 — of a 23.8MB plugin bundle, about 15MB spent
   * 818ms crossing that boundary, and batching 34 items into one call changed nothing (the cost was the
   * amount, not the round trip count). The engine can read the same file through its own resource load
   * path, and that path has no serialization.
   *
   * How the address is built differs per framework, and neither side has the other's method — so it is
   * asked here.
   */
  pluginFileUrl(path: string): Promise<string>;

  /**
   * The property that marks "dragging this element moves the window" for the framework.
   *
   * The mechanism differs per framework. In Tauri the webview intercepts the `data-tauri-drag-region`
   * attribute; Electron reads CSS `-webkit-app-region: drag`. Neither one recognizes the other.
   *
   * Why it is in the contract: this failure **leaves nothing behind.** A wrong marker neither throws nor
   * logs, the window simply does not move — it does not look like an error, so it stays unseen for a long
   * time (measured 2026-07-28). It is returned as props spread onto the element, so the app needs no
   * information about what gets attached.
   */
  readonly dragRegion: Record<string, unknown>;

  /**
   * What this framework provides — the supply-side facts for plugin requirements (requiresEngine and the
   * rest).
   *
   * Why it is in the contract: if an adapter omits it, compilation fails. Made optional, a new framework
   * attaches silently undeclared, and the app then cannot separate "no requirement" from "unknown".
   */
  readonly engineProvision: EngineProvision;

  /**
   * What this framework can answer about traffic light composition — the only channel the core and the
   * judgment read.
   *
   * Why it is in the contract: made optional, a new framework attaches undeclared, and the core then
   * cannot separate "no capability" from "not declared". Undeclared is unknown, not absent.
   */
  readonly titlebarComposition: TitlebarCompositionProvision;

  /** Adapter name — recorded in diagnostics and the ledger ("which framework did this happen in"). */
  readonly name: string;

  /**
   * Everything this framework attaches to core surfaces — implementations, devices, styles.
   *
   * **Only the selected adapter is called.** The bundle is one and contains both adapters, so attaching
   * on load alone attaches the unselected framework's pieces too (measured 2026-08-03: `electron.css` was
   * present in the Tauri build as well — harmless only because it was `-webkit-app-region`, but the same
   * leak). So the attach point moves to **after selection**.
   *
   * Why it is in the contract: if a new framework omits it, compilation fails. Made optional, boot
   * proceeds with nothing attached, and that silence appears only as "the browser does not work on this
   * framework".
   *
   * The core does not ask what got attached. A surface with nothing attached does nothing.
   *
   * **It is async — the attaching code is fetched at that point.** The adapter must be a leaf that
   * translates the vendor SDK, but the attaching side touches app modules (plugin bus, store, DOM) and
   * those modules reference the framework door again. Binding it statically makes that cycle stop the
   * adapter from being a leaf, and depending on load order it steps on a binding not yet established
   * (measured 2026-08-03: "invoke is not a function" killed 13 whole test suites). As a bonus, the
   * unselected framework's attaching code is **never even fetched.**
   *
   * Boot **waits** for this — without the wait it becomes a timing guess ("nobody calls in between"), and
   * that guess is wrong eventually.
   */
  /**
   * Fix this window's label — boot waits for this before anything else.
   *
   * Why it is in the contract: the label is the first segment of an address and is cached once read. Read
   * late, an empty label hardens first and every address after it becomes `win//...` — the side that
   * builds the address and the side that resolves it then point at different windows, and that mismatch
   * appears only as "no such address" (measured 2026-08-15). Frameworks answer the label at different
   * times, so that difference is absorbed here.
   */
  resolveWindowLabel(): Promise<string>;

  install(): Promise<void>;

  /**
   * Reveal the current framework window after its initial DOM has committed.
   *
   * Some native frameworks must create a window hidden and validate a native/DOM composition
   * receipt before the first visible frame. DOM-native frameworks already have one compositor and
   * complete this as an idempotent no-op. The application owns only the lifecycle boundary; each
   * adapter owns its presentation mechanism.
   */
  presentWindow(): Promise<void>;

  /**
   * Remove every native child surface from the current window in one framework-owned commit.
   * Reload and renderer bootstrap call this before their DOM inventory exists. Frameworks whose
   * content is already in the DOM complete the lifecycle boundary as an idempotent no-op.
   */
  resetNativeSurfaces(): Promise<void>;
  /** Stop watching and destroy this window's native children — for a window that is about to go. */
  clearNativeSurfaces(): Promise<void>;

  /**
   * Apply one zoom factor to everything this window shows.
   *
   * The value has one owner (the `windowZoom` setting); how it arrives on screen does not. Where
   * content is in native child webviews, the framework scales the window and its children in
   * one native call. Where content is in the DOM as guest elements, the document's own zoom
   * applies to them and each guest receives the same factor.
   *
   * Why it is in the contract: if the core calls one side's command name, the other side **rejects it on
   * every boot** (measured 2026-08-08: `webview_zoom` was rejected on Electron, leaving one reject line in
   * the activity feed every boot). Putting the axis in the contract makes compilation fail when a new
   * framework omits it.
   */
  setWindowZoom(factor: number): Promise<void>;

  /** Backend command call. Whether the framework uses an in-process call or a socket is not exposed to the app. */
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;

  /** Create a stream sink — pass it through as an invoke argument unchanged. */
  createStream<T>(): Stream<T>;

  /** Global (broadcast) event subscription. Window-targeted signals use currentWindow().listen. */
  listen<T>(event: string, cb: (e: FrameworkEvent<T>) => void): Promise<Unlisten>;

  currentWindow(): FrameworkWindowHandle;
  windowByLabel(label: string): Promise<FrameworkWindowHandle | null>;

  app: {
    name(): Promise<string>;
    version(): Promise<string>;
  };

  path: {
    tempDir(): Promise<string>;
    join(...parts: string[]): Promise<string>;
  };

  dialog: {
    /** Directory selection — cancel returns null. */
    openDirectory(options?: { title?: string; defaultPath?: string }): Promise<string | null>;
  };

  notification: FrameworkNotification;

  deepLink: {
    onOpenUrl(cb: (urls: string[]) => void): Promise<Unlisten>;
    current(): Promise<string[] | null>;
  };
}
