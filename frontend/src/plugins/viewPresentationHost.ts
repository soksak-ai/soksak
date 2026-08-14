import { moduleState } from "../lib/moduleState";
import type { PresentationBarrierSuccess } from "../lib/presentationSettlement";
import type { PluginViewContext, PluginViewProvider, RegisteredView } from "./viewRegistry";

export type PluginViewSurfacePlacement = Readonly<{
  desiredVisible: boolean;
  topology: "visible" | "retained-hidden" | "exclusive-hidden";
  declaredPaneFrame: Readonly<{ x: number; y: number; w: number; h: number }> | null;
}>;

export interface PresentedPluginView {
  /** Resolves only once the renderer and the first native member accept commands. */
  readonly ready: Promise<void>;
  update(context: PluginViewContext): void;
  /** Update the workspace pane owner without recreating the plugin or its native surface. */
  setLogicalPaneId(logicalPaneId: string | null): void;
  setSurfacePlacement(placement: PluginViewSurfacePlacement, declarationSequence: number): void;
  dispose(): void;
}

/**
 * Public boundary where a framework that requires an out-of-document renderer mounts plugin views.
 * Core and plugins never branch on the framework name. With an implementation registered, that
 * implementation creates the presentation owner; without one, the plain DOM provider mount is the
 * only path.
 */
export interface PluginViewPresentationHost {
  mount(input: {
    container: HTMLElement;
    registration: RegisteredView;
    provider: PluginViewProvider;
    context: PluginViewContext;
    surfacePlacement: PluginViewSurfacePlacement;
    placementViewId: string;
    containerGeneration: number;
    declarationSequence: number;
    /** Workspace layout pane (`pan-*`), distinct from context.paneId's caller-tab axis. */
    logicalPaneId: string | null;
  }): PresentedPluginView;
  /** Resolves after the mounted external presentation owner has committed geometry, visibility, and paint. */
  presentationSettled(signal?: AbortSignal): Promise<PresentationBarrierSuccess>;
  /** In-flight provider-owned presentation stages. An empty array means no owner is in flight. */
  presentationPending(): readonly unknown[];
}

const state = moduleState("plugins/viewPresentationHost#registered", () => ({
  host: null as PluginViewPresentationHost | null,
}));

export function registerPluginViewPresentationHost(host: PluginViewPresentationHost): void {
  if (state.host && state.host !== host) {
    throw new Error("a plugin view presentation host is already registered");
  }
  state.host = host;
}

export function pluginViewPresentationHost(): PluginViewPresentationHost | null {
  return state.host;
}

export function __resetPluginViewPresentationHostForTest(): void {
  state.host = null;
}
