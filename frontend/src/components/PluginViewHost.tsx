// Single host for plugin views — the same component for every placement (right/left sidebar,
// content) (§0-6). provider.mount/unmount sit behind a try/catch boundary (§0-4): a mount failure
// renders an error card, a missing provider (plugin disabled or removed) renders a placeholder.
// The host clears leftover DOM.

import { moduleState } from "../lib/moduleState";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  getRegisteredView,
  useViewRegistry,
  type PluginViewContext,
  type ViewPresentation,
} from "../plugins/viewRegistry";
import { formatAddress, type Region } from "../commands/address";
import { viewHostAnchors } from "../plugins/viewHostAnchors";
import { bindingIdentity } from "../plugins/viewContext";
import { registerMountedViewFocus } from "../plugins/viewFocus";
import { useSessions } from "../state/sessions";
import { useBootPhase } from "../state/bootPhase";
import { useT } from "../i18n";
import {
  pluginViewPresentationHost,
  type PresentedPluginView,
  type PluginViewSurfacePlacement,
} from "../plugins/viewPresentationHost";
import { viewSurfacePlacement } from "../lib/viewPark";
import { pluginViewSurfacePlacementLedger } from "../plugins/viewSurfacePlacementLedger";
import {
  overlayReasonOf,
  publishPluginViewHostOverlay,
  removePluginViewHostOverlay,
} from "./pluginViewHostOverlay";

// Container generation counter — incremented per registration (reg) generation. It is module
// global, so every host in the window shares it, but the value is used only for key uniqueness,
// so there is no collision.
// Outside the hot-swap boundary — when these values are replaced, the "already done" record and
// the lazy init go with them, and the filling side does not fill again.
const ms = moduleState("components/PluginViewHost.#state", () => ({
  containerGeneration: 0,
}));
// memo boundary (principle 2).
export const PluginViewHost = memo(function PluginViewHost({
  viewKey,
  projectId,
  root,
  region,
  paneId = null,
  logicalPaneId = null,
  viewId = null,
  boundViewId = null,
  command = null,
  restore = null,
  instanceId = null,
  surfacePlacement = viewSurfacePlacement(true, false),
}: {
  viewKey: string; // "<pluginId>.<viewId>"
  projectId: string;
  root: string | null;
  region: Region; // left|content|right — the region segment of the container absolute address
  // Terminal pane this view follows (cwd follow target). Unspecified = null (contract A13/S7).
  // The sidebar host passes cwdTabOf.
  paneId?: string | null;
  // Workspace layout pane identity. Host-only: this is not the plugin context's caller-tab paneId.
  logicalPaneId?: string | null;
  // Content placement: the sessions view.id (status report target). Sidebar: null (no close guard
  // → setStatus is a no-op).
  viewId?: string | null;
  // Id of the bound content view this rail projection mount serves (§4.4-lite) — passed by
  // ProjectionSlots only.
  boundViewId?: string | null;
  // Auto-run command this view receives at mount (agent program — the terminal view runs it on the
  // PTY). null when absent.
  command?: string | null;
  // Restore seam (B3) — on a restart-restore mount, the observed runtime (cwd, state). New views
  // leave it unspecified (null).
  restore?: { cwd: string | null; state: unknown } | null;
  // Address uniqueness axis (axiom A1) — separates two mounts of the same viewKey in one region.
  // Falls back to viewId when unspecified. The mount site declares its own instance, so the host
  // does not guess.
  instanceId?: string | null;
  // Single decision for the content active-chain. Placements without separate parking, such as the
  // sidebar, default to true.
  surfacePlacement?: PluginViewSurfacePlacement;
}) {
  // Absolute address of this view container (baseAddress for node scans). workspace is a path (slash
  // collision), so the active qualifier is omitted — <region>/view/<viewKey>. Omitted win = current
  // window. Stable segments (region, qualifiedViewId) make it idempotent. ui.tree reads it.
  const viewAddr = formatAddress({
    region,
    view: viewKey,
    tab: instanceId ?? viewId ?? undefined,
  });
  const t = useT();
  // Subscribe to version → re-evaluate on register/unregister. The RegisteredView object keeps the
  // same reference when unchanged (zustand spread) — an unrelated version bump causes no remount.
  useViewRegistry((s) => s.version);
  const reg = getRegisteredView(viewKey);
  const containerRef = useRef<HTMLDivElement>(null);
  const presentationRef = useRef<ViewPresentation>({
    visible: surfacePlacement.desiredVisible,
    dim: surfacePlacement.dim,
  });
  presentationRef.current = {
    visible: surfacePlacement.desiredVisible,
    dim: surfacePlacement.dim,
  };
  const presentationListenersRef = useRef(new Set<(presentation: ViewPresentation) => void>());
  const presentedRef = useRef<PresentedPluginView | null>(null);
  const placementDeclarationRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  // When the provider implements live update, a paneId change is delivered through update instead
  // of a remount (see the deps below).
  const supportsUpdate = typeof reg?.provider.update === "function";
  // Container generation — each structural remount gets a new DOM owner identity.
  const generation = useMemo(() => ++ms.containerGeneration, [reg]);

  // Keep the newest ctx in a ref — the mount/update effect reads the current value without growing
  // its deps.
  const ctxRef = useRef<PluginViewContext | null>(null);
  ctxRef.current = {
    projectId,
    root,
    paneId,
    viewId: viewId ?? null,
    boundViewId: boundViewId ?? null,
    command: command ?? null,
    restore: restore ?? null,
    presentation: () => presentationRef.current,
    onPresentationChange: (listener) => {
      presentationListenersRef.current.add(listener);
      return () => presentationListenersRef.current.delete(listener);
    },
    // The person interacted with this view. The core owns what that means: the pane it is in becomes
    // the focused one and this view becomes its active tab, which is what the lighting follows.
    requestFocus: () => {
      if (!viewId) return;
      const sessions = useSessions.getState();
      if (paneId) sessions.setActiveGroup(projectId, paneId);
      sessions.setActiveView(projectId, viewId);
    },
    // Tab badge for that view in this window (per-window — each window has its own store). The
    // plugin recomputes it when its data changes.
    setBadge: (badge) => useViewRegistry.getState().setViewBadge(viewKey, badge),
    // Status report (R1) — only content placements (viewId present) go to sessions view.status.
    // Sidebar is a no-op.
    setStatus: (status) =>
      viewId
        ? void useSessions.getState().setViewStatus(projectId, viewId, status)
        : undefined,
    // Dynamic tab title update — content placements (viewId present) only. Sidebar is a no-op.
    setTitle: (title) =>
      viewId
        ? useSessions.getState().setViewTitle(projectId, viewId, title)
        : undefined,
    // Tab icon (a content fact — favicon etc.) — content placements only. Empty value = clear.
    setIcon: (icon) =>
      viewId
        ? useSessions.getState().setViewIcon(projectId, viewId, icon)
        : undefined,
    // Plugin observation state (B3) — persisted on the view record (same lifetime as the view).
    // Content placements only.
    setRestoreState: (state) =>
      viewId
        ? useSessions.getState().setViewRuntime(projectId, viewId, { state })
        : undefined,
  };

  // Presentation is a core fact every plugin view consumes, not a side effect of native placement.
  // A provider mount reads the initial value through presentation(), and after that both DOM and
  // native implementations get exactly one notification on the same layout-commit edge.
  useLayoutEffect(() => {
    for (const listener of presentationListenersRef.current) {
      listener(presentationRef.current);
    }
  }, [surfacePlacement.desiredVisible, surfacePlacement.dim]);

  useLayoutEffect(() => {
    if (!reg?.decl.nativeSurface || !pluginViewPresentationHost()) return;
    const placementViewId = viewId ?? viewAddr;
    const declared = pluginViewSurfacePlacementLedger.declare({
      viewId: placementViewId,
      containerGeneration: generation,
      placement: surfacePlacement,
    });
    pluginViewSurfacePlacementLedger.hostApplied({
      viewId: placementViewId,
      containerGeneration: generation,
      declarationSequence: declared.sequence,
      placement: surfacePlacement,
    });
    placementDeclarationRef.current = declared.sequence;
    presentedRef.current?.setSurfacePlacement(surfacePlacement, declared.sequence);
    return () => pluginViewSurfacePlacementLedger.dispose({
      viewId: placementViewId,
      containerGeneration: generation,
      declarationSequence: declared.sequence,
    });
  }, [
    generation,
    surfacePlacement.declaredPaneFrame?.h,
    surfacePlacement.declaredPaneFrame?.w,
    surfacePlacement.declaredPaneFrame?.x,
    surfacePlacement.declaredPaneFrame?.y,
    surfacePlacement.desiredVisible,
    surfacePlacement.topology,
    reg,
    viewAddr,
    viewId,
  ]);

  // Binding identity — every binding-axis value of ctx (the axis declaration in viewContext is the
  // single truth). Field names are not listed here: listing them drops new fields silently, and a
  // dropped field means "the binding changed but the screen is old" (measured — boundViewId was on
  // no axis, so a shared projection drew someone else's content).
  const binding = bindingIdentity(ctxRef.current!);

  // Structural mount/unmount. **For a provider that implements update, binding is excluded from
  // deps** (a separate effect pushes it) — implementing update is the declaration that the instance
  // is kept, and with that declaration there is no recreation. For a provider without it the only
  // honest path is recreation: losing structural state beats drawing someone else's binding data.
  // viewKey/reg (= provider swap) always remounts, regardless of binding.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !reg) return;
    setError(null);
    let disconnected = false;
    const disconnect = reg.provider.connect?.(ctxRef.current!);
    const disconnectInstance = () => {
      if (disconnected) return;
      disconnected = true;
      disconnect?.();
    };
    const presentationHost = reg.decl.nativeSurface
      ? pluginViewPresentationHost()
      : null;
    if (presentationHost) {
      try {
        const presented = presentationHost.mount({
          container: el,
          registration: reg,
          provider: reg.provider,
          context: ctxRef.current!,
          logicalPaneId,
          surfacePlacement,
          placementViewId: viewId ?? viewAddr,
          containerGeneration: generation,
          declarationSequence: placementDeclarationRef.current,
        });
        presentedRef.current = presented;
        let unregisterFocus: (() => void) | null = null;
        let disposed = false;
        void presented.ready.then(() => {
          if (disposed || !viewId) return;
          unregisterFocus = registerMountedViewFocus(
            viewId,
            el,
            reg.provider,
            () => ctxRef.current!,
          );
        }).catch((e) => {
          if (disposed) return;
          console.error(`plugin presentation prepare failed (${viewKey}):`, e);
          setError(String(e));
        });
        return () => {
          disposed = true;
          unregisterFocus?.();
          if (presentedRef.current === presented) presentedRef.current = null;
          presented.dispose();
          disconnectInstance();
          el.replaceChildren();
        };
      } catch (e) {
        disconnectInstance();
        console.error(`plugin presentation mount failed (${viewKey}):`, e);
        setError(String(e));
        return;
      }
    }
    try {
      reg.provider.mount(el, ctxRef.current!);
    } catch (e) {
      console.error(`plugin view mount failed (${viewKey}):`, e);
      setError(String(e));
      el.replaceChildren(); // Drop the remains of a partial render.
      return;
    }
    const unregisterFocus = viewId
      ? registerMountedViewFocus(
          viewId,
          el,
          reg.provider,
          () => ctxRef.current!,
        )
      : null;
    return () => {
      // Abort deferred focus before provider teardown so a stale async mount can
      // never focus after this container has ceased to own the view.
      unregisterFocus?.();
      try {
        reg.provider.unmount?.(el);
      } catch (e) {
        console.error(`plugin view unmount failed (${viewKey}):`, e);
      }
      disconnectInstance();
      el.replaceChildren(); // For a provider with no unmount — the host guarantees the cleanup.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reg, viewKey, supportsUpdate ? "" : binding]);

  // Moving a persistent tab between layout panes updates only the host ownership ledger. The
  // plugin instance and native surface keep their lifetime; identity repair must not reload them.
  useEffect(() => {
    presentedRef.current?.setLogicalPaneId(logicalPaneId);
  }, [logicalPaneId]);

  // Live binding update — pushes the new ctx to the mounted view without a remount. Without update
  // implemented, the effect above includes binding in its deps and remounts, so this is a no-op.
  // It also runs once right after mount, but update is idempotent.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !reg || !supportsUpdate) return;
    if (presentedRef.current) {
      presentedRef.current.update(ctxRef.current!);
      return;
    }
    try {
      reg.provider.update!(el, ctxRef.current!);
    } catch (e) {
      console.error(`plugin view update failed (${viewKey}):`, e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [binding, supportsUpdate, reg]);

  // A structural remount always builds new container DOM. attachShadow is irreversible, so the
  // previous generation's shadow root and any incomplete provider teardown leftovers are not
  // carried into the next mount.
  const containerKey = [
    generation,
    viewKey,
    supportsUpdate ? "" : binding,
  ].join("\u0000");

  // Boot phase — an unregistered view before ready means "not yet", not "absent" (the contract
  // that prevents a blank being read as missing).
  const bootPhase = useBootPhase((s) => s.phase);
  const overlayReason = overlayReasonOf({
    registryPresent: !!reg,
    bootPhase,
    error,
  });
  useLayoutEffect(() => {
    publishPluginViewHostOverlay({
      viewKey,
      viewId,
      containerGeneration: generation,
      registryPresent: !!reg,
      bootPhase,
      overlayReason,
      error,
    });
    return () => removePluginViewHostOverlay({
      viewKey,
      viewId,
      containerGeneration: generation,
    });
  }, [viewKey, viewId, generation, reg, bootPhase, overlayReason, error]);
  // The container always renders (the ref stays) — error and absent states are drawn on top, so a
  // re-registration recovers.
  const overlay = !reg ? (
    bootPhase !== "ready" ? (
      <div className="plugin-loading">{t("plugin.view.loading")}</div>
    ) : (
      <div className="plugin-empty">{t("plugin.view.missing")}</div>
    )
  ) : error ? (
    <div className="plugin-error">
      <div className="plugin-error-title">{t("plugin.view.error")}</div>
      <div className="plugin-error-msg">{error}</div>
    </div>
  ) : null;

  return (
    <div className="plugin-body">
      <div
        key={containerKey}
        // The Tauri compositor fills in the exact pane identity after native registration.
        // undefined creates no DOM attribute at all, so an incomplete inventory is never exposed
        // to an observer.
        data-wv-pane={undefined}
        data-wv-generation={generation}
        // The old name stays alongside — the commands-layer selector (catalogDom) still finds this
        // root by it. Removal condition: once the 3 `.plugin-view-container` selectors in
        // catalogDom move to `.tab-viewer`, drop the second token (verification = ui.tree still
        // exposes the view node).
        className={`tab-viewer plugin-view-container${reg?.decl.transparent ? " transparent" : ""}`}
        {...viewHostAnchors(viewAddr, viewId)}
        ref={containerRef}
        style={overlay ? { display: "none" } : undefined}
      />
      {overlay}
    </div>
  );
});
