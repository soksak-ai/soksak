import type {
  PluginViewContext,
  PluginViewProvider,
} from "./viewRegistry";
import { allGroups, useSessions } from "../state/sessions";
import { CONTENT_VIEW_EVENT } from "../lib/contentViewEvents";
import { viewIdFromSurfaceLabel } from "../lib/surfaceLabels";

interface MountedView {
  container: HTMLElement;
  provider: PluginViewProvider;
  context: () => PluginViewContext;
  registrations: number;
}

interface FocusIntent {
  viewId: string;
  controller: AbortController;
  queued: boolean;
  delivered: boolean;
  retries?: number;
}

// Landing retry limit — covers the measured window where a warm restore (engine reattach) right
// after reload takes several frames. A replaced or aborted intent stops immediately, so the limit
// is only the worst-case reporting point.
const FOCUS_LANDING_RETRY_LIMIT = 30;

interface ViewFocusCoordinatorOptions {
  schedule?: (callback: FrameRequestCallback) => number;
  onError?: (error: unknown) => void;
}

/**
 * Keyboard-focus ownership for mounted plugin views.
 *
 * Core owns the destination view and ordering. A provider owns only how its own
 * container commits transient input and settles on its canonical input element.
 * Mounting is never treated as focus intent; only the latest abortable request
 * may focus, so an asynchronously prepared stale view cannot steal focus.
 */
export class ViewFocusCoordinator {
  private readonly mounted = new Map<string, MountedView>();
  private readonly schedule: (callback: FrameRequestCallback) => number;
  private readonly onError: (error: unknown) => void;
  private intent: FocusIntent | null = null;
  private focusedViewId: string | null = null;

  constructor(options: ViewFocusCoordinatorOptions = {}) {
    this.schedule =
      options.schedule ?? ((callback) => requestAnimationFrame(callback));
    this.onError =
      options.onError ??
      ((error) => console.error("plugin view focus switch failed:", error));
  }

  /** Callers waiting for a mount that has not arrived. Woken only at the moment of mount. */
  private readonly mountWaiters = new Map<string, Set<() => void>>();

  /**
   * Wait until this view can accept commands. Returns true immediately if it already can.
   *
   * Why this is needed: view.open answers as soon as it changes state, but a plugin view mounts on
   * the next render. A command sent to that view in between finds no such view in the plugin
   * (measured: navigate right after view.open returned NO_VIEW — the core reported it created but
   * it was unusable). If a command answered ok, its result must be usable.
   */
  awaitMounted(viewId: string, timeoutMs: number): Promise<boolean> {
    if (this.mounted.has(viewId)) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        this.mountWaiters.get(viewId)?.delete(wake);
        clearTimeout(timer);
        resolve(ok);
      };
      const wake = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      const set = this.mountWaiters.get(viewId) ?? new Set<() => void>();
      set.add(wake);
      this.mountWaiters.set(viewId, set);
    });
  }

  registerMountedView(
    viewId: string,
    container: HTMLElement,
    provider: PluginViewProvider,
    context: () => PluginViewContext,
  ): () => void {
    const previous = this.mounted.get(viewId);
    if (previous?.container === container && previous.provider === provider) {
      // StrictMode or duplicate wiring by the same host is an idempotent acquire of the same
      // generation. Use the latest context, but count leases so the first cleanup does not remove
      // the remaining registrations.
      previous.context = context;
      previous.registrations += 1;
      return this.releaseMountedView(viewId, previous);
    }

    // React may run the previous effect's cleanup after setting up the new effect. viewId is the
    // product identity; the DOM container is the render generation. When a new generation
    // registers, ownership transfers in one transaction and the old generation's late cleanup is
    // ignored by the identity guard.
    if (previous && this.intent?.viewId === viewId) {
      this.intent.controller.abort();
      this.intent = {
        viewId,
        controller: new AbortController(),
        queued: false,
        delivered: false,
      };
    }
    const mounted = { container, provider, context, registrations: 1 };
    this.mounted.set(viewId, mounted);
    // This view can now accept commands — provider.mount has finished, so the plugin has
    // registered its view. Wake the waiting callers (no polling; this single point is the signal).
    const waiters = this.mountWaiters.get(viewId);
    if (waiters) {
      this.mountWaiters.delete(viewId);
      for (const w of waiters) w();
    }
    if (this.intent?.viewId === viewId) this.publishFocused(viewId, true);
    else if (this.focusedViewId === viewId) this.publishFocused(viewId, true);
    this.queueCurrentIntent();

    return this.releaseMountedView(viewId, mounted);
  }

  private releaseMountedView(viewId: string, mounted: MountedView): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.mounted.get(viewId) !== mounted) return;
      mounted.registrations -= 1;
      if (mounted.registrations > 0) return;
      this.mounted.delete(viewId);
      if (this.intent?.viewId !== viewId) return;

      // The old provider may still be waiting for async readiness. Abort it,
      // but retain the destination so a remount can fulfill the same intent.
      this.intent.controller.abort();
      this.intent = {
        viewId,
        controller: new AbortController(),
        queued: false,
        delivered: false,
      };
    };
  }

  transferFocus<T>(
    sourceViewId: string | null,
    targetViewId: string,
    activate: () => T,
  ): T {
    if (sourceViewId && sourceViewId !== targetViewId) {
      const source = this.mounted.get(sourceViewId);
      if (source?.provider.prepareFocusTransfer) {
        try {
          source.provider.prepareFocusTransfer(
            source.container,
            source.context(),
          );
        } catch (error) {
          this.onError(error);
        }
      }
      this.publishFocused(sourceViewId, false);
    }

    const result = activate();
    this.requestFocus(targetViewId);
    return result;
  }

  requestFocus(viewId: string): AbortSignal {
    // State synchronization and the initiating event can report the same intent
    // in one turn. Coalesce only while it is still pending; a later re-click of
    // an already active view creates a fresh request and restores lost focus.
    if (
      this.intent?.viewId === viewId &&
      !this.intent.delivered &&
      !this.intent.controller.signal.aborted
    ) {
      this.publishFocused(viewId, true);
      return this.intent.controller.signal;
    }

    if (this.focusedViewId && this.focusedViewId !== viewId) {
      this.publishFocused(this.focusedViewId, false);
    }
    this.intent?.controller.abort();
    this.intent = {
      viewId,
      controller: new AbortController(),
      queued: false,
      delivered: false,
    };
    this.publishFocused(viewId, true);
    this.queueCurrentIntent();
    return this.intent.controller.signal;
  }

  clear(): void {
    if (this.focusedViewId) this.publishFocused(this.focusedViewId, false);
    this.intent?.controller.abort();
    this.intent = null;
  }

  /**
   * A layout move (the reparent of a projection rearrangement) drops the input focus inside it to
   * body — "delivered" is not "settled", so if focus was lost when the move finished, the same
   * intent is redelivered. Focus the user deliberately placed on another element (not body) is
   * never stolen.
   */
  redeliverIfLost(): void {
    const intent = this.intent;
    if (!intent || intent.controller.signal.aborted) return;
    const target = this.mounted.get(intent.viewId);
    if (!target) return;
    const doc = target.container.ownerDocument;
    const active = doc.activeElement;
    if (active && target.container.contains(active)) return; // already inside the target
    if (active && active !== doc.body) return; // deliberate focus elsewhere — never taken
    intent.delivered = false;
    intent.retries = 0;
    this.queueCurrentIntent();
  }

  zoomView(viewId: string, action: "in" | "out" | "reset"): boolean {
    const mounted = this.mounted.get(viewId);
    if (!mounted?.provider.zoom) return false;
    try {
      mounted.provider.zoom(mounted.container, mounted.context(), action);
    } catch (error) {
      this.onError(error);
    }
    return true;
  }

  snapshot(): {
    requestedViewId: string | null;
    mounted: boolean;
    delivered: boolean;
  } {
    const viewId = this.intent?.viewId ?? null;
    return {
      requestedViewId: viewId,
      mounted: viewId ? this.mounted.has(viewId) : false,
      delivered: this.intent?.delivered ?? false,
    };
  }

  private queueCurrentIntent(): void {
    const intent = this.intent;
    if (
      !intent ||
      intent.queued ||
      intent.delivered ||
      intent.controller.signal.aborted ||
      !this.mounted.has(intent.viewId)
    ) {
      return;
    }
    intent.queued = true;
    this.schedule(() => this.deliver(intent));
  }

  private deliver(intent: FocusIntent): void {
    if (this.intent !== intent || intent.controller.signal.aborted) return;
    intent.queued = false;
    const target = this.mounted.get(intent.viewId);
    if (!target) return;

    const landed = (): boolean => {
      const active = target.container.ownerDocument.activeElement;
      return !!active && target.container.contains(active);
    };
    if (landed()) {
      intent.delivered = true;
      return;
    }

    if (!target.provider.focus) {
      intent.delivered = true;
      return;
    }
    try {
      target.provider.focus(target.container, target.context(), {
        signal: intent.controller.signal,
      });
    } catch (error) {
      this.onError(error);
    }
    // Landing is the basis for declaring delivery — if the provider call did not move input focus
    // (measured signature: activeElement stays on body after a click), redeliver every frame with
    // a finite retry that covers the readiness window, and report which view if it has not landed
    // by the limit (no silence). The window where an engine reattach takes several frames, such as
    // a warm restore right after reload, is the reason this retry exists.
    if (landed()) {
      intent.delivered = true;
      return;
    }
    const retries = (intent.retries ?? 0) + 1;
    intent.retries = retries;
    if (retries < FOCUS_LANDING_RETRY_LIMIT) {
      intent.queued = true;
      this.schedule(() => this.deliver(intent));
      return;
    }
    intent.delivered = true;
    this.onError(
      new Error(
        `focus did not land: ${intent.viewId} — provider.focus did not move input focus`,
      ),
    );
  }

  private publishFocused(viewId: string, focused: boolean): void {
    const mounted = this.mounted.get(viewId);
    if (focused) this.focusedViewId = viewId;
    else if (this.focusedViewId === viewId) this.focusedViewId = null;
    if (!mounted?.provider.setFocused) return;
    try {
      mounted.provider.setFocused(mounted.container, mounted.context(), focused);
    } catch (error) {
      this.onError(error);
    }
  }
}

const coordinator = new ViewFocusCoordinator();

export function registerMountedViewFocus(
  viewId: string,
  container: HTMLElement,
  provider: PluginViewProvider,
  context: () => PluginViewContext,
): () => void {
  return coordinator.registerMountedView(viewId, container, provider, context);
}

/** Can that view accept commands — true when it can, false if it cannot within the timeout. */
export function awaitViewMounted(viewId: string, timeoutMs = 5000): Promise<boolean> {
  return coordinator.awaitMounted(viewId, timeoutMs);
}

export function requestViewFocus(viewId: string): AbortSignal {
  return coordinator.requestFocus(viewId);
}

export function transferViewFocus<T>(
  sourceViewId: string | null,
  targetViewId: string,
  activate: () => T,
): T {
  return coordinator.transferFocus(sourceViewId, targetViewId, activate);
}

export function activeSessionViewId(): string | null {
  const state = useSessions.getState();
  const workspace = state.workspaces.find((item) => item.id === state.activeId);
  const space = workspace?.spaces.find(
    (item) => item.id === workspace.activeSpaceId,
  );
  const panel = space
    ? allGroups(space.layout).find((item) => item.id === space.activePaneId)
    : null;
  return panel?.activeTabId ?? null;
}

/** Keep focus intent aligned with every active-chain state transition. */
export function startViewFocusSync(): () => void {
  let activeViewId = activeSessionViewId();
  if (activeViewId) coordinator.requestFocus(activeViewId);
  return useSessions.subscribe(() => {
    const next = activeSessionViewId();
    if (next === activeViewId) return;
    activeViewId = next;
    if (next) coordinator.requestFocus(next);
    else coordinator.clear();
  });
}

/**
 * The other direction: a surface reports it was clicked, and the session follows.
 *
 * `startViewFocusSync` takes the session's active view to the mounted views. Nothing took the
 * reverse path, so a view drawn on a native surface — which receives its own clicks, the document never
 * seeing them — could not become the focused one by being clicked. Measured on the running build
 * 2026-08-17: a click inside a browser page left the focus where it was.
 *
 * `content-view-activated` was already the name for it in both vocabularies, with nothing emitting
 * it and nothing subscribing. The core acts on it rather than offering it to plugins: which pane and
 * which tab focus means is the core's, and a plugin moving focus itself would be a second rule.
 */
export function startSurfaceActivationSync(
  subscribe: (event: string, onLabel: (label: string) => void) => () => void,
): () => void {
  return subscribe(CONTENT_VIEW_EVENT.activated, (label) => {
    const viewId = viewIdFromSurfaceLabel(label);
    if (!viewId) return;
    const sessions = useSessions.getState();
    const workspace = sessions.workspaces.find((w) => w.id === sessions.activeId);
    if (!workspace) return;
    const space = workspace.spaces.find((c) => c.id === workspace.activeSpaceId);
    if (!space) return;
    const pane = allGroups(space.layout).find((g) => g.tabs.some((v) => v.id === viewId));
    if (!pane) return;
    sessions.setActiveGroup(workspace.id, pane.id);
    sessions.setActiveView(workspace.id, viewId);
  });
}

export function viewFocusSnapshot(): ReturnType<
  ViewFocusCoordinator["snapshot"]
> {
  return coordinator.snapshot();
}

/** Called at the end of a layout move — redelivers the focus the move dropped under the same intent. */
export function redeliverViewFocusIfLost(): void {
  coordinator.redeliverIfLost();
}

/** Zoom intent delegation (plan golden-swinging-lynx) — calls the optional zoom hook of a mounted
 * view. False when the hook is unimplemented or the view is unmounted. The core owns routing only;
 * the view defines the meaning (font zoom or page zoom). */
export function zoomFocusedView(
  viewId: string,
  action: "in" | "out" | "reset",
): boolean {
  return coordinator.zoomView(viewId, action);
}
