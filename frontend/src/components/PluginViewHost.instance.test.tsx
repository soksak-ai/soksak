import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginViewHost } from "./PluginViewHost";
import { useViewRegistry, type PluginViewContext } from "../plugins/viewRegistry";
import type { ContributedView } from "../plugins/spec";
import {
  __resetPluginViewPresentationHostForTest,
  registerPluginViewPresentationHost,
  type PluginViewPresentationHost,
} from "../plugins/viewPresentationHost";
import { pluginViewHostOverlayStatus } from "./pluginViewHostOverlay";
import { pluginViewSurfacePlacementLedger } from "../plugins/viewSurfacePlacementLedger";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DECL = {
  id: "content",
  title: { en: "Browser" },
  placements: ["center"],
  defaultPlacement: "center",
  nativeSurface: true,
} as unknown as ContributedView;

describe("PluginViewHost — instance lifetime is separate from DOM lifetime", () => {
  let host: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    __resetPluginViewPresentationHostForTest();
    useViewRegistry.setState({ views: {}, version: 0, badges: {} });
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    host.remove();
    __resetPluginViewPresentationHostForTest();
  });

  it("connect registers the commandable instance first and mount owns only the DOM", () => {
    const order: string[] = [];
    const disconnect = vi.fn(() => order.push("disconnect"));
    const provider = {
      connect(ctx: PluginViewContext) {
        order.push(`connect:${ctx.viewId}`);
        return disconnect;
      },
      mount() { order.push("mount"); },
      unmount() { order.push("unmount"); },
    };
    act(() => {
      useViewRegistry.getState().register("browser", DECL, provider as never);
      root = createRoot(host);
      root.render(
        <PluginViewHost
          viewKey="browser.content"
          projectId="p1"
          root="/workspace"
          region="center"
          viewId="tab-1"
        />,
      );
    });

    expect(order.slice(0, 2)).toEqual(["connect:tab-1", "mount"]);
    act(() => root!.unmount());
    root = null;
    expect(order.slice(-2)).toEqual(["unmount", "disconnect"]);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("a nativeSurface declaration delegates plugin DOM and native member together to the registered presentation owner", async () => {
    const mount = vi.fn((el: HTMLElement) => { el.textContent = "browser chrome"; });
    const dispose = vi.fn();
    const setLogicalPaneId = vi.fn();
    const setSurfacePlacement = vi.fn();
    const presentationMount = vi.fn((_input: Parameters<PluginViewPresentationHost["mount"]>[0]) => ({
      ready: Promise.resolve(), update: vi.fn(), setSurfacePlacement, setLogicalPaneId, dispose,
    }));
    registerPluginViewPresentationHost({
      presentationPending: vi.fn(() => []),
      presentationSettled: vi.fn(async () => ({
        owner: "view" as const, status: "settled" as const, elapsedMs: 0, labels: [],
      })),
      mount: presentationMount,
    });
    act(() => {
      useViewRegistry.getState().register("browser", DECL, { mount } as never);
      root = createRoot(host);
      root.render(
        <PluginViewHost
          viewKey="browser.content"
          projectId="p1"
          root="/workspace"
          region="center"
          viewId="tab-1"
          logicalPaneId="pan-left"
        />,
      );
    });
    expect(presentationMount).toHaveBeenCalledOnce();
    expect(presentationMount.mock.calls[0]?.[0]).toMatchObject({
      logicalPaneId: "pan-left",
      placementViewId: "tab-1",
      surfacePlacement: { desiredVisible: true, dim: 0, topology: "visible" },
    });
    const initial = presentationMount.mock.calls[0]![0];
    expect(initial.containerGeneration).toBeGreaterThan(0);
    expect(initial.declarationSequence).toBeGreaterThan(0);
    act(() => {
      root!.render(
        <PluginViewHost
          viewKey="browser.content"
          projectId="p1"
          root="/workspace"
          region="center"
          viewId="tab-1"
          logicalPaneId="pan-right"
        />,
      );
    });
    expect(presentationMount).toHaveBeenCalledOnce();
    expect(setLogicalPaneId).toHaveBeenLastCalledWith("pan-right");
    act(() => {
      root!.render(
        <PluginViewHost
          viewKey="browser.content"
          projectId="p1"
          root="/workspace"
          region="center"
          viewId="tab-1"
          logicalPaneId="pan-right"
          surfacePlacement={{
            desiredVisible: false,
            dim: 0,
            topology: "exclusive-hidden",
            declaredPaneFrame: { x: 0, y: 0, w: 0, h: 0 },
          }}
        />,
      );
    });
    expect(setSurfacePlacement).toHaveBeenCalledOnce();
    expect(setSurfacePlacement.mock.calls[0]?.[0]).toMatchObject({
      desiredVisible: false,
      topology: "exclusive-hidden",
    });
    expect(setSurfacePlacement.mock.calls[0]?.[1]).toBeGreaterThan(initial.declarationSequence);
    expect(pluginViewSurfacePlacementLedger.status().current).toContainEqual(expect.objectContaining({
      viewId: "tab-1",
      containerGeneration: initial.containerGeneration,
      declarationSequence: setSurfacePlacement.mock.calls[0]?.[1],
      stage: "host-applied",
      desiredVisible: false,
    }));
    expect(mount).not.toHaveBeenCalled();
    await act(async () => Promise.resolve());
    act(() => root!.unmount());
    root = null;
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("a missing visibility ACK across two mounted native views is kept as a presentation error, not a registry or boot error", async () => {
    const failure = "Error: visibility ACK receipt missing";
    const presentationMount = vi.fn(() => ({
      ready: Promise.reject(new Error(failure)),
      update: vi.fn(),
      setSurfacePlacement: vi.fn(),
      setLogicalPaneId: vi.fn(),
      dispose: vi.fn(),
    }));
    registerPluginViewPresentationHost({
      presentationPending: vi.fn(() => []),
      presentationSettled: vi.fn(async () => ({
        owner: "view" as const, status: "settled" as const, elapsedMs: 0, labels: [],
      })),
      mount: presentationMount,
    });
    act(() => {
      useViewRegistry.getState().register("browser", DECL, {} as never);
      root = createRoot(host);
      root.render(<>
        <PluginViewHost viewKey="browser.content" projectId="p1" root="/workspace"
          region="center" viewId="actual-left" />
        <PluginViewHost viewKey="browser.content" projectId="p1" root="/workspace"
          region="center" viewId="actual-right" />
      </>);
    });
    await act(async () => Promise.resolve());

    expect(presentationMount).toHaveBeenCalledTimes(2);
    const rows = pluginViewHostOverlayStatus().current
      .filter(({ viewId }) => viewId === "actual-left" || viewId === "actual-right");
    expect(rows).toHaveLength(2);
    expect(rows.map(({ viewId, registryPresent, bootPhase, overlayReason, error }) => ({
      viewId, registryPresent, bootPhase, overlayReason, error,
    }))).toEqual([
      { viewId: "actual-left", registryPresent: true, bootPhase: "ready",
        overlayReason: "presentation-error", error: `Error: ${failure}` },
      { viewId: "actual-right", registryPresent: true, bootPhase: "ready",
        overlayReason: "presentation-error", error: `Error: ${failure}` },
    ]);
  });
});
