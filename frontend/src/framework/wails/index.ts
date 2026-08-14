// Wails adapter — the only leaf in this repository with vendor-specific code.
//
// The contract (contract.ts) is defined by the app; this file only translates that contract into
// Wails vocabulary. A rule placed here stops being true on any other host.
//
// A command the backend does not serve yet **fails with its name**. A silent no-op makes the
// caller treat the feature as present and render as if it were.

import { Events, Window as WailsWindow } from "@wailsio/runtime";
import type { EngineProvision } from "@soksak-ai/plugin-spec";

import type {
  AppFramework,
  FrameworkEvent,
  FrameworkWindowHandle,
  Stream,
  TitlebarCompositionProvision,
  Unlisten,
} from "../contract";

/** What this host does not answer yet. The error names what is missing. */
const unserved = (what: string) => (): never => {
  throw new Error(`wails adapter does not serve ${what} yet`);
};

// This window's name. The contract requires a synchronous `label` while the framework returns it
// asynchronously, so boot reads it once. An empty label produces a `win//...` address, and that
// address points the producer and the resolver at different windows — measured 2026-08-15:
// ui.input.click rejected an address emitted by ui.tree with NOT_EXPOSED.
let currentLabel = "";

 *
export async function resolveWindowLabel(): Promise<string> {
  try {
    currentLabel = await WailsWindow.Name();
  } catch {
    currentLabel = "";
  }
  return currentLabel;
}

function windowHandle(label: string): FrameworkWindowHandle {
  const win = label ? WailsWindow.Get(label) : WailsWindow;
  return {
    label,
    setTitle: async (title) => { win.SetTitle(title); },
    setSize: async (width, height) => { win.SetSize(width, height); },
    setPosition: async (x, y) => { win.SetPosition(x, y); },
    setFocus: async () => { win.Focus(); },
    // Light/dark mode for window chrome is not on this framework's public surface. Treated like
    // an unsupported platform and ignored harmlessly — the contract specifies that.
    setTheme: async () => {},
    outerPosition: async () => win.Position(),
    innerPosition: async () => win.Position(),
    outerSize: async () => win.Size(),
    scaleFactor: async () => 1,
    setPhysicalPosition: async (x, y) => { win.SetPosition(x, y); },
    setPhysicalSize: async (width, height) => { win.SetSize(width, height); },
    setAlwaysOnTop: async (on) => { win.SetAlwaysOnTop(on); },
    maximize: async () => { win.Maximise(); },
    unmaximize: async () => { win.UnMaximise(); },
    onResized: async (cb) => Events.On("window:resized", () => { void win.Size().then(cb); }),
    onMoved: async (cb) => Events.On("window:moved", () => { void win.Position().then(cb); }),
    onDragDrop: async (cb) => Events.On("window:filedrop", (event) => cb(event.data)),
    listen: async <T,>(event: string, cb: (e: FrameworkEvent<T>) => void) =>
      Events.On(event, (received) => cb({ payload: received.data as T })),
  };
}

const engineProvision: EngineProvision = {
  // WKWebView is not Chromium, and the native compositor owns child surfaces.
  chromium: false,
  nativeChildWebview: true,
  engineModules: false,
  supportsDocumentStart: false,
  supportsInputInjection: false,
};

const titlebarComposition: TitlebarCompositionProvision = {
  // Wails v3 uses standardWindowButton internally only and does not expose its rect
  // (pin commit 3ae6893b, measured 2026-08-15). Unexposed is unknown, not absent, so this
  // reports not-provided with a reason.
  buttonPositions: { provided: false, reason: "wails does not expose the traffic light button rect" },
  backingPlane: { provided: false, reason: "the wails adapter does not draw the plane behind the traffic lights" },
  paintOwner: { provided: false, reason: "no traffic light paint owner ledger" },
};

export const wailsFramework: AppFramework = {
  name: "wails",

  // Wails sets the window drag region with CSS.
  dragRegion: { style: { "--wails-draggable": "drag" } as never },

  engineProvision,
  titlebarComposition,

  emitLocal: (event, payload) => { Events.Emit(event, payload); },

  // The asset server serves unit files on the same origin — no serialization crosses the boundary.
  // The path goes in the query, and the serving side checks whether it is outside the home
  // (frameworks/wails/unitassets.go). A webview checking an address the webview built is no check.
  unitFileUrl: async (path) =>
    `${window.location.origin}${UNIT_FILE_ROUTE}?path=${encodeURIComponent(path)}`,

  resolveWindowLabel,

  install: async () => {
    const { installWailsSurfaces } = await import("./install");
    await installWailsSurfaces();
  },

  // This host does not create windows hidden. There is no native/DOM receipt to verify before the
  // first frame, so this boundary is an idempotent no-op.
  presentWindow: async () => {},

  suspendNativeSurfaces: async () => {
    const { suspendNativeSurfaces } = await import("./nativeSurfaces");
    await suspendNativeSurfaces();
  },

  setWindowZoom: async (factor) => { WailsWindow.SetZoom(factor); },

  invoke: async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    const { invokeCommand } = await import("./invoke");
    return invokeCommand<T>(cmd, args);
  },

  createStream: <T,>(): Stream<T> => ({ onmessage: () => {} }),

  listen: async <T,>(event: string, cb: (e: FrameworkEvent<T>) => void): Promise<Unlisten> =>
    Events.On(event, (received) => cb({ payload: received.data as T })),

  currentWindow: () => windowHandle(currentLabel),
  windowByLabel: async (label) => windowHandle(label),

  app: {
    name: async () => "soksak-core",
    version: async () => "0.0.1",
  },

  path: {
    tempDir: unserved("path.tempDir"),
    join: async (...parts) => parts.filter(Boolean).join("/"),
  },

  dialog: { openDirectory: unserved("dialog.openDirectory") },

  notification: {
    isPermissionGranted: unserved("notification.isPermissionGranted"),
    requestPermission: unserved("notification.requestPermission"),
    send: () => { throw new Error("wails adapter does not serve notification.send yet"); },
    onAction: unserved("notification.onAction"),
  },

  deepLink: {
    onOpenUrl: unserved("deepLink.onOpenUrl"),
    current: unserved("deepLink.current"),
  },
};
