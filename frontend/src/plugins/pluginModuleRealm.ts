export interface PluginModuleRealm {
  evaluate(code: string): Promise<unknown>;
  dispose(): void;
}

export interface LoadedPluginModule {
  module: unknown;
  dispose(): void;
}

export type PluginModuleRealmFactory = () => PluginModuleRealm;

let realmSequence = 0;
let realmsCreated = 0;
let realmsDisposed = 0;
let realmsOpen = 0;

export function pluginModuleRealmStats(): { open: number; created: number; disposed: number } {
  return { open: realmsOpen, created: realmsCreated, disposed: realmsDisposed };
}

const PARENT_REALM_BINDINGS = `
const window = parent;
const document = parent.document;
const navigator = parent.navigator;
const localStorage = parent.localStorage;
const sessionStorage = parent.sessionStorage;
const Element = parent.Element;
const HTMLElement = parent.HTMLElement;
const HTMLCanvasElement = parent.HTMLCanvasElement;
const HTMLInputElement = parent.HTMLInputElement;
const HTMLTextAreaElement = parent.HTMLTextAreaElement;
const Node = parent.Node;
const Event = parent.Event;
const CustomEvent = parent.CustomEvent;
const FocusEvent = parent.FocusEvent;
const KeyboardEvent = parent.KeyboardEvent;
const MouseEvent = parent.MouseEvent;
const PointerEvent = parent.PointerEvent;
const WheelEvent = parent.WheelEvent;
const CompositionEvent = parent.CompositionEvent;
const InputEvent = parent.InputEvent;
const ClipboardEvent = parent.ClipboardEvent;
const DragEvent = parent.DragEvent;
const ResizeObserver = parent.ResizeObserver;
const MutationObserver = parent.MutationObserver;
const AbortController = parent.AbortController;
const AbortSignal = parent.AbortSignal;
const requestAnimationFrame = parent.requestAnimationFrame.bind(parent);
const cancelAnimationFrame = parent.cancelAnimationFrame.bind(parent);
const setTimeout = parent.setTimeout.bind(parent);
const clearTimeout = parent.clearTimeout.bind(parent);
const setInterval = parent.setInterval.bind(parent);
const clearInterval = parent.clearInterval.bind(parent);
const queueMicrotask = parent.queueMicrotask.bind(parent);
const getComputedStyle = parent.getComputedStyle.bind(parent);
const fetch = parent.fetch.bind(parent);
const atob = parent.atob.bind(parent);
const btoa = parent.btoa.bind(parent);
`;

export function pluginModuleSource(code: string): string {
  return `${PARENT_REALM_BINDINGS}\n${code}`;
}

function createBrowserPluginModuleRealm(): PluginModuleRealm {
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.tabIndex = -1;
  frame.setAttribute("aria-hidden", "true");
  frame.style.display = "none";
  (document.body ?? document.documentElement).append(frame);
  const realmWindow = frame.contentWindow;
  const realmDocument = frame.contentDocument;
  if (!realmWindow || !realmDocument) {
    frame.remove();
    throw new Error("plugin module realm has no document");
  }
  let disposed = false;
  return {
    evaluate(code) {
      if (disposed) return Promise.reject(new Error("plugin module realm is disposed"));
      const sourceUrl = URL.createObjectURL(new Blob([pluginModuleSource(code)], { type: "text/javascript" }));
      const callback = `__soksakPluginModule${++realmSequence}`;
      const bootstrap = [
        `import(${JSON.stringify(sourceUrl)}).then(`,
        `value => globalThis[${JSON.stringify(callback)}](true, value),`,
        `error => globalThis[${JSON.stringify(callback)}](false, String(error)))`,
      ].join("");
      const bootstrapUrl = URL.createObjectURL(new Blob([bootstrap], { type: "text/javascript" }));
      const script = realmDocument.createElement("script");
      script.type = "module";
      script.src = bootstrapUrl;
      const callbacks = realmWindow as unknown as Record<string, unknown>;
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          delete callbacks[callback];
          script.remove();
          URL.revokeObjectURL(bootstrapUrl);
          URL.revokeObjectURL(sourceUrl);
        };
        callbacks[callback] = (ok: boolean, value: unknown) => {
          cleanup();
          if (ok) resolve(value);
          else reject(new Error(String(value)));
        };
        script.addEventListener("error", () => {
          cleanup();
          reject(new Error("plugin module bootstrap failed"));
        }, { once: true });
        realmDocument.head.append(script);
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      frame.remove();
    },
  };
}

export async function loadPluginModule(
  code: string,
  createRealm: PluginModuleRealmFactory = createBrowserPluginModuleRealm,
): Promise<LoadedPluginModule> {
  const realm = createRealm();
  realmsCreated += 1;
  realmsOpen += 1;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    realmsOpen = Math.max(0, realmsOpen - 1);
    realmsDisposed += 1;
    realm.dispose();
  };
  try {
    const module = await realm.evaluate(code);
    return {
      module,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
