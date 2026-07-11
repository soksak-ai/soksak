import type {
  PluginViewContext,
  PluginViewProvider,
} from "./viewRegistry";
import { allGroups, useSessions } from "../state/sessions";

interface MountedView {
  container: HTMLElement;
  provider: PluginViewProvider;
  context: () => PluginViewContext;
}

interface FocusIntent {
  viewId: string;
  controller: AbortController;
  queued: boolean;
  delivered: boolean;
}

interface ViewFocusCoordinatorOptions {
  schedule?: (callback: FrameRequestCallback) => number;
  onError?: (error: unknown) => void;
}

/**
 * Keyboard-focus ownership for mounted plugin views.
 *
 * Core owns the destination view and ordering. A provider owns only how its own
 * container commits transient input and reaches its canonical input element.
 * Mounting is never treated as focus intent; only the latest abortable request
 * may focus, so an asynchronously prepared stale view cannot steal focus.
 */
export class ViewFocusCoordinator {
  private readonly mounted = new Map<string, MountedView>();
  private readonly schedule: (callback: FrameRequestCallback) => number;
  private readonly onError: (error: unknown) => void;
  private intent: FocusIntent | null = null;

  constructor(options: ViewFocusCoordinatorOptions = {}) {
    this.schedule =
      options.schedule ?? ((callback) => requestAnimationFrame(callback));
    this.onError =
      options.onError ??
      ((error) => console.error("플러그인 뷰 포커스 전환 실패:", error));
  }

  registerMountedView(
    viewId: string,
    container: HTMLElement,
    provider: PluginViewProvider,
    context: () => PluginViewContext,
  ): () => void {
    if (this.mounted.has(viewId)) {
      throw new Error(`이미 마운트된 포커스 대상 뷰: ${viewId}`);
    }
    const mounted = { container, provider, context };
    this.mounted.set(viewId, mounted);
    this.queueCurrentIntent();

    return () => {
      if (this.mounted.get(viewId) !== mounted) return;
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
      return this.intent.controller.signal;
    }

    this.intent?.controller.abort();
    this.intent = {
      viewId,
      controller: new AbortController(),
      queued: false,
      delivered: false,
    };
    this.queueCurrentIntent();
    return this.intent.controller.signal;
  }

  clear(): void {
    this.intent?.controller.abort();
    this.intent = null;
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

    const active = target.container.ownerDocument.activeElement;
    if (active && target.container.contains(active)) {
      intent.delivered = true;
      return;
    }

    intent.delivered = true;
    if (!target.provider.focus) return;
    try {
      target.provider.focus(target.container, target.context(), {
        signal: intent.controller.signal,
      });
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
  const project = state.tabs.find((item) => item.id === state.activeId);
  const space = project?.contents.find(
    (item) => item.id === project.activeContentId,
  );
  const panel = space
    ? allGroups(space.layout).find((item) => item.id === space.activeGroupId)
    : null;
  return panel?.activeViewId ?? null;
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

export function viewFocusSnapshot(): ReturnType<
  ViewFocusCoordinator["snapshot"]
> {
  return coordinator.snapshot();
}
