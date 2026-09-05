// Neutral test adapter. It does not imitate a product framework: a test that needs concrete framework
// behavior imports that adapter directly or mocks it explicitly. The purpose is to stop shared modules
// from loading against Tauri by accident.
import type { AppFramework, FrameworkWindowHandle } from "./contract";

const unsupported = async (): Promise<never> => {
  throw new Error("the neutral test adapter has no product framework behavior");
};

const testWindow: FrameworkWindowHandle = {
  // The existing test contract represents the current window outside a runtime as an empty label. A
  // product identity invented by the neutral adapter would pollute every command reply and browser label.
  label: "",
  setTitle: unsupported,
  setSize: unsupported,
  setPosition: unsupported,
  setFocus: unsupported,
  setTheme: unsupported,
  outerPosition: unsupported,
  innerPosition: unsupported,
  outerSize: unsupported,
  scaleFactor: unsupported,
  setPhysicalPosition: unsupported,
  setPhysicalSize: unsupported,
  setAlwaysOnTop: unsupported,
  maximize: unsupported,
  unmaximize: unsupported,
  onResized: unsupported,
  onMoved: unsupported,
  onWindowGone: async () => () => {},
    onDragDrop: unsupported,
  listen: unsupported,
};

export const selectedFramework: AppFramework = {
  name: "test",
  dragRegion: {},
  engineProvision: {
    chromium: false,
    nativeChildWebview: false,
    engineModules: false,
    supportsDocumentStart: false,
    supportsInputInjection: false,
  },
  // The neutral adapter has no window. Answering "absent" and leaving it unstated are different facts, so attach a reason.
  titlebarComposition: {
    buttonPositions: { provided: false, reason: "the neutral test adapter has no window chrome" },
    backingPlane: { provided: false, reason: "the neutral test adapter has no window chrome" },
    paintOwner: { provided: false, reason: "the neutral test adapter has no window chrome" },
  },
  emitLocal: () => {},
  // The neutral adapter has no resource protocol — return the file address as is.
  pluginFileUrl: async (path) => `file://${path}`,
  resolveWindowLabel: async () => "",
  install: async () => {},
  presentWindow: async () => {},
  resetNativeSurfaces: async () => {},
  clearNativeSurfaces: async () => {},
  // The neutral adapter has no screen — there is nowhere to apply a zoom factor, so this does nothing.
  setWindowZoom: async () => {},
  invoke: unsupported,
  commands: async () => ({ commands: [], unserved: [] }),
  createStream: () => ({ onmessage: () => {}, close() {} }),
  openStreamCount: () => 0,
  listen: unsupported,
  currentWindow: () => testWindow,
  windowByLabel: unsupported,
  app: { name: unsupported, version: unsupported },
  path: { tempDir: unsupported, join: unsupported },
  dialog: { openDirectory: unsupported },
  notification: {
    isPermissionGranted: unsupported,
    requestPermission: unsupported,
    send: () => {},
    onAction: unsupported,
  },
  deepLink: { onOpenUrl: unsupported, current: unsupported },
};
