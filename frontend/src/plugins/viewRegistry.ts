// View registry — the single store of plugin view providers.
// View implementation and placement are orthogonal (§0-6): right sidebar, left sidebar, and the
// content area all consume the same provider registered here through PluginViewHost.
// version is the UI rebuild signal.

import { moduleState } from "../lib/moduleState";
import { tmsg } from "../i18n";
import { create } from "zustand";
import { qualifiedViewId, type ContributedView } from "./spec";

/** How a view is presented at one moment. */
export interface ViewPresentation {
  visible: boolean;
  /** 0 = full brightness, 1 = fully taken off. */
  dim: number;
}

export interface PluginViewContext {
  projectId: string;
  root: string | null;
  // The terminal pane this view tracks (the cwd-tracking target). Sidebar = cwdTabOf (the focused
  // terminal of the active group), other placements = null. Used with app.terminal.getCwd/onCwd for
  // cwd tracking (contract A13/S7). null when there is none.
  paneId: string | null;
  // sessions view.id of a content-placement view (the stable key of this view instance — e.g.
  // app.webview.label(viewId) builds a per-instance webview label). null for sidebar placement.
  viewId: string | null;
  // Rail projection mounts only (§4.4-lite): id of the bound content view this sidebar instance
  // serves. The channel by which a per-view instance connects to its own document/store.
  // Other placements = null.
  boundViewId: string | null;
  // Command this view auto-runs once at mount (agent program — a terminal view runs it over PTY).
  // The program declaration (ContributedProgram.command) is the source. A view-kind-agnostic
  // channel — the view implementation determines whether to auto-run (only terminal views run it
  // over PTY). null when there is no command.
  command: string | null;
  // Restore seam (B3) — on a restart-restore mount this supplies the observed runtime (cwd, state).
  // A terminal view spawns at restore.cwd (restores the last working location). state is the
  // plugin-observed state recorded through setRestoreState (e.g. a browser URL). A newly opened
  // view gets null — residue cannot leak in by construction.
  restore: { cwd: string | null; state: unknown } | null;
  // How this view is presented right now, owned by the core. An inactive slot may keep the same
  // rect to preserve layout, so never infer either value from DOM geometry or IntersectionObserver.
  //
  // `visible` is whether it is shown at all. `dim` is how much the focus lighting takes off it,
  // 0..1, from the same rule the veil paints by: a pane that is not the focused one is dimmed, and
  // a pane wedged where the rail cannot arrive is dimmed further.
  //
  // One channel for both, because they are one fact about one moment. Two would let a view answer a
  // dim from one frame with a visibility from another, and a surface would dim after it was hidden.
  //
  // The veil is an SVG over the document and a native surface is composited above it, so the veil
  // cannot darken one — measured 2026-08-17, the browser area kept its brightness whether its pane
  // was focused or not, while the CSS above it stated that it painted "over a native child outside
  // the document". A view drawn on a surface applies `dim` to the surface's own alpha.
  presentation: () => ViewPresentation;
  // Subscribes to how this view is presented. The current value arrives immediately, then every
  // change: a view that read the value and subscribed a line later missed anything that happened
  // between the two, and its surface then stayed as it was — measured 2026-08-17, a browser surface
  // stayed visible over an open modal on 1 run in 3.
  onPresentationChange: (listener: (presentation: ViewPresentation) => void) => () => void;
  // The person interacted with this view — make it the focused one.
  //
  // A view drawn on a native surface receives its own clicks and the document never sees them, so
  // clicking inside a browser page left the focus where it was (measured 2026-08-17). The view
  // reports the fact; what focus means — which pane, which tab, what the lighting follows — stays
  // the core's. A plugin that moved focus itself would be a second rule about it.
  //
  // Content placements only. A section has no tab of its own to activate.
  requestFocus: () => void;
  // Sidebar tab badge of this view (unread marker). number = count, "dot" = dot, null = clear.
  // Per-window, since each window has its own store (based on that window's active workspace).
  // Recompute the data with app.data.watch.
  setBadge: (badge: number | "dot" | null) => void;
  // Status report of this view (R1) — into sessions view.status. null = withdraw. Valid only for
  // content-placement views (close guard).
  setStatus: (status: { code: string; message?: string } | null) => void;
  // Dynamic tab title update for this view (content placement only — e.g. the browser page
  // <title>). Empty value ignored. Sidebar = no-op.
  setTitle: (title: string) => void;
  // Tab icon update for this view (content placement only — e.g. a browser favicon URL). Empty
  // value = clear (falls back to the manifest icon). A content-fact channel isomorphic to title.
  // Sidebar = no-op.
  setIcon: (icon: string) => void;
  // Plugin-observed runtime state report (B3) — persisted in the view record, returned as
  // restore.state on a restore mount. Do not persist it in plugin kv under a viewId key (viewId
  // reuse collides — a dead view's residue leaks into a new view). JSON-serializable values only.
  // Valid for content placement only, sidebar = no-op.
  setRestoreState: (state: unknown) => void;
}

export type ViewBadge = number | "dot" | null;

export interface PluginViewFocusRequest {
  /** A newer focus intent or unmount aborts this signal. Deferred focus must honor it. */
  signal: AbortSignal;
}

// A view implemented by a plugin. React is not required — it draws directly into the container DOM.
export interface PluginViewProvider {
  // Product lifetime of the view instance. Ownership unrelated to DOM nodes, such as command
  // targets and state, is registered here. The same instance contract applies even when the
  // framework draws the DOM in a separate renderer. The returned cleanup runs after the
  // mount/unmount lifetime ends.
  connect?(ctx: PluginViewContext): void | (() => void);
  mount(container: HTMLElement, ctx: PluginViewContext): void;
  unmount?(container: HTMLElement): void;
  // Reports whether the current active chain points at this view. Separate from input-executing
  // focus(), so it is delivered even when a descendant already holds DOM focus.
  setFocused?(container: HTMLElement, ctx: PluginViewContext, focused: boolean): void;
  // Synchronous boundary before leaving for another view. Commit transient input that can be lost,
  // such as composition/preedit, but do not query or focus DOM outside the own container.
  prepareFocusTransfer?(container: HTMLElement, ctx: PluginViewContext): void;
  // Zoom intent (optional surface — PLUGIN-CONTRACT §Zoom). The view responds by its own
  // convention: terminal = font step, browser = page zoom, editor = body font. Never touch the row
  // grid (header/toolbar bands) — that is the zoom invariant. The core ignores it when
  // unimplemented (omission is allowed).
  zoom?(
    container: HTMLElement,
    ctx: PluginViewContext,
    action: "in" | "out" | "reset",
  ): void;
  // Close intent for the active view (⌘W). "handled" means the view consumed it — a view holding
  // several panes closed one of them and stays open. "pass" means the core closes the view. An
  // absent hook is "pass", so a view that holds one thing needs no opinion.
  closeIntent?(container: HTMLElement, ctx: PluginViewContext): "handled" | "pass";
  // Applies the core's latest focus intent to the view's own canonical input. If async preparation
  // is needed, keep request.signal and never focus after it is aborted.
  focus?(
    container: HTMLElement,
    ctx: PluginViewContext,
    request: PluginViewFocusRequest,
  ): void;
  // Live update — **when the binding axis changes** the host calls this instead of remounting and
  // hands the same instance a new ctx. The single truth for the axis is VIEW_CONTEXT_AXIS in
  // viewContext (do not list field names here — a list diverges from the contract, and a diverged
  // list is silent).
  //
  // There is one obligation: **redraw with the ctx received.** An implementation that applies only
  // some fields violates the contract — the host does not report which field changed, and once it
  // did, that report would itself become a hand-maintained list.
  //
  // Implemented, a binding switch does not recreate the whole view (file tree canvas rebuild ~36ms,
  // no loss of expanded folders). Not implemented, the host remounts on a binding change — the
  // honest path left for a provider with no notification channel: losing structural state beats
  // continuing to draw another binding's data.
  update?(container: HTMLElement, ctx: PluginViewContext): void;
}

export interface PluginViewPresentationRuntime {
  source: string;
  pluginId: string;
  app: () => unknown;
}

const presentationRuntimes = moduleState(
  "plugins/viewRegistry#presentationRuntimes",
  () => new WeakMap<PluginViewProvider, PluginViewPresentationRuntime>(),
);

/** Attaches loader-only runtime material. It does not mutate the public provider object, so there is no field a plugin can forge. */
export function attachViewPresentationRuntime(
  provider: PluginViewProvider,
  runtime: PluginViewPresentationRuntime,
): PluginViewProvider {
  presentationRuntimes.set(provider, runtime);
  return provider;
}

export function viewPresentationRuntime(
  provider: PluginViewProvider,
): PluginViewPresentationRuntime | null {
  return presentationRuntimes.get(provider) ?? null;
}

export interface RegisteredView {
  pluginId: string;
  decl: ContributedView; // Manifest declaration (title/icon/placement) — single truth of display info
  provider: PluginViewProvider;
}

interface ViewRegistryState {
  views: Record<string, RegisteredView>; // key = "<pluginId>.<viewId>"
  version: number; // Increments on every register/unregister — the consumer (UI) rebuild signal
  // Per-view badge (unread marker). Separate from version so a badge change does not remount the
  // view (independent subscription).
  badges: Record<string, ViewBadge>;
  register: (
    pluginId: string,
    decl: ContributedView,
    provider: PluginViewProvider,
  ) => () => void;
  setViewBadge: (key: string, badge: ViewBadge) => void;
}

// The registry is held outside the module boundary — if a hot swap replaces this store every
// registered view disappears, and the plugins are already active so they do not register again.
// That loss appears only as "the tab + gives nothing" (the + menu comes from registered programs).
export const useViewRegistry = moduleState("plugins/viewRegistry#store", () =>
  create<ViewRegistryState>((set, get) => ({
  views: {},
  version: 0,
  badges: {},

  register: (pluginId, decl, provider) => {
    const key = qualifiedViewId(pluginId, decl.id);
    if (get().views[key]) {
      // §0-3 no silent failure — a duplicate registration is a bug (reactivated without unregistering).
      throw new Error(tmsg("plugin.view.duplicate", { view: key }));
    }
    set((s) => ({
      views: { ...s.views, [key]: { pluginId, decl, provider } },
      version: s.version + 1,
    }));
    return () => {
      set((s) => {
        if (!s.views[key]) return s; // Already unregistered — idempotent
        const views = { ...s.views };
        delete views[key];
        const badges = { ...s.badges };
        delete badges[key]; // Clear the badge too when the view is unregistered
        return { views, badges, version: s.version + 1 };
      });
    };
  },

  // Badge setter — does not increment version (prevents a view remount). Equal value = no-op
  // (blocks an unnecessary render).
  setViewBadge: (key, badge) =>
    set((s) => {
      const cur = s.badges[key] ?? null;
      const next = badge === 0 ? null : badge; // Normalize 0 to none
      if (cur === next) return s;
      const badges = { ...s.badges };
      if (next == null) delete badges[key];
      else badges[key] = next;
      return { badges };
    }),
})),
);

// Views per placement (for the icon rail / tab strip) — registration order preserved.
export function viewsOnSurface(
  surface: import("./spec").ViewSurface,
): { key: string; view: RegisteredView }[] {
  const { views } = useViewRegistry.getState();
  return Object.entries(views)
    .filter(([, v]) => v.decl.surfaces.includes(surface))
    .map(([key, view]) => ({ key, view }));
}

export function getRegisteredView(key: string): RegisteredView | null {
  return useViewRegistry.getState().views[key] ?? null;
}

// View ids this plugin actually registered (the actual of declared≡actual). Registration order
// (Object insertion order) preserved.
export function registeredViewIds(pluginId: string): string[] {
  return Object.values(useViewRegistry.getState().views)
    .filter((v) => v.pluginId === pluginId)
    .map((v) => v.decl.id);
}
