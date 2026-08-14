// A view is a rectangle someone else fills.
//
// The core mounts a provider into an empty element and never learns what
// appears there. Every renderer — terminal, browser, sidebar body — arrives
// through this registry, so adding one costs the core nothing.

/** What a mounted view is told. It receives identity, never core state. */
export interface ViewContext {
  readonly leafId: string;
}

/** Undo a mount. Calling it twice must be harmless. */
export type ViewHandle = () => void;

export type ViewProvider = (host: HTMLElement, context: ViewContext) => ViewHandle;

export interface ViewRegistry {
  register(viewId: string, provider: ViewProvider): void;
  unregister(viewId: string): void;
  /** Absence answers null. A missing view is a legitimate state. */
  resolve(viewId: string): ViewProvider | null;
  /** Registration order, which is the order a plugin declared them. */
  list(): string[];
}

export function createViewRegistry(): ViewRegistry {
  const providers = new Map<string, ViewProvider>();

  return {
    register(viewId, provider) {
      if (!viewId) throw new Error("view id is required");
      // Re-registration replaces. Reloading a plugin re-registers its views,
      // and refusing would leave the previous code rendering after it changed.
      providers.set(viewId, provider);
    },
    unregister(viewId) {
      providers.delete(viewId);
    },
    resolve(viewId) {
      return providers.get(viewId) ?? null;
    },
    list() {
      return [...providers.keys()];
    },
  };
}
