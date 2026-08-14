// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetPresentationClockForTest,
  presentationNowUnixMs,
} from "../lib/presentationClock";
import { RailGridSurface, type RailGridSurfaceHandle } from "./RailGridSurface";
import {
  __resetLayoutDecorationClearanceForTest,
  layoutDecorationClearanceFacts,
} from "../lib/layoutDecorationClearance";

describe("RailGridSurface", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
    __resetPresentationClockForTest();
    __resetLayoutDecorationClearanceForTest();
  });

  it("a new native display candidate arm ACKs clearance after the sidebar DOM is removed", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const handle = createRef<RailGridSurfaceHandle>();
    const animation = {
      animationName: "rail-flip-x",
      startTime: null as number | null,
      currentTime: 0,
      playState: "paused",
      play: vi.fn(),
      pause: vi.fn(),
    };
    Object.defineProperty(HTMLElement.prototype, "getAnimations", {
      configurable: true,
      value: () => [animation],
    });
    vi.spyOn(performance, "timeOrigin", "get").mockReturnValue(1_000);
    vi.spyOn(performance, "now").mockReturnValue(100);
    vi.spyOn(Date, "now").mockReturnValue(1_100);

    act(() => root.render(
      <RailGridSurface
        ref={handle}
        traveling
        starting
        railPlane={undefined}
      >
        <div className="pane flip-move" />
      </RailGridSurface>,
    ));
    const prepared = await handle.current!.candidateParticipant.prepare("layout-clear-before-native");
    const candidate = {
      transactionId: "layout-clear-before-native",
      producer: "display-callback" as const,
      clock: "unix-anchored-monotonic" as const,
      sourceGeneration: 1,
      frameSequence: 1,
      commandReceivedAtUnixUs: 1,
      installedAtUnixUs: 2,
      callbackReceivedAtUnixUs: 3,
      callbackObservedAtUnixMs: 1_100,
      callbackObservedAtUnixUs: 1_100_000,
      startAtUnixUs: 1_200_000,
      durationMs: 180,
      documentTimelineBridge: {
        producer: "display-callback-wall-bridge" as const,
        clock: "unix-wall" as const,
        callbackObservedAtUnixUs: 1_100_000,
        startAtUnixUs: 1_200_000,
      },
    };
    await prepared.arm(candidate);
    expect(layoutDecorationClearanceFacts()).toMatchObject({
      owners: [{
        transactionId: "layout-clear-before-native",
        status: "cleared",
        producer: "native-display-callback",
        railRole: "absent",
        railVisibility: "absent",
        callbackCount: 1,
      }],
    });
    act(() => root.unmount());
  });

  it("keeps the rail inside the panel grid and below the content tabs", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => {
      root.render(
        <div className="content">
          <div className="space-tabs" data-testid="tabs" />
          <RailGridSurface
            railPlane={<div className="left-rail-plane" data-testid="rail" />}
          >
            <div className="space-plane" data-testid="grid" />
          </RailGridSurface>
        </div>,
      );
    });

    const tabs = host.querySelector<HTMLElement>("[data-testid=tabs]")!;
    const rail = host.querySelector<HTMLElement>("[data-testid=rail]")!;
    const grid = host.querySelector<HTMLElement>("[data-testid=grid]")!;
    expect(rail.parentElement).toBe(grid.parentElement);
    expect(rail.parentElement?.classList.contains("space-body")).toBe(true);
    expect(tabs.contains(rail)).toBe(false);

    act(() => root.unmount());
  });

  it("creates the destination relation outline on click commit and holds it fixed while traveling", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => root.render(
      <RailGridSurface
        traveling
        railPlane={<div data-testid="rail" />}
        relationOverlay={<div key="destination" data-testid="relation" data-identity="destination" />}
      >
        <div data-testid="grid" />
      </RailGridSurface>,
    ));
    expect(host.querySelector("[data-testid=relation]")).not.toBeNull();
    expect(host.querySelector("[data-testid=relation]")?.getAttribute("data-identity"))
      .toBe("destination");

    act(() => root.render(
      <RailGridSurface
        railPlane={<div data-testid="rail" />}
        relationOverlay={<div data-testid="relation" />}
      >
        <div data-testid="grid" />
      </RailGridSurface>,
    ));
    expect(host.querySelector("[data-testid=relation]")).not.toBeNull();

    act(() => root.unmount());
  });

  it("never rewrites the animation epoch on a render receipt alone", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const paneAnimation = { animationName: "rail-flip-x", startTime: null };
    const railAnimation = { animationName: "rail-flip-x", startTime: null };
    const getAnimations = vi.fn(() => [paneAnimation, railAnimation]);
    Object.defineProperty(HTMLElement.prototype, "getAnimations", {
      configurable: true,
      value: getAnimations,
    });
    vi.spyOn(performance, "timeOrigin", "get").mockReturnValue(1_000);
    vi.spyOn(Date, "now").mockReturnValue(9_999);

    act(() => {
      root.render(
        <RailGridSurface
          traveling
          railPlane={<div className="sidebar flip-move" />}
        >
          <div className="pane flip-move" />
        </RailGridSurface>,
      );
    });

    expect(getAnimations).not.toHaveBeenCalled();
    expect(paneAnimation.startTime).toBeNull();
    expect(railAnimation.startTime).toBeNull();
    act(() => root.unmount());
  });

  it("a WebKit timeOrigin change leaves the animation untouched before a candidate arm", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const paneAnimation = { animationName: "rail-flip-x", startTime: null as number | null };
    Object.defineProperty(HTMLElement.prototype, "getAnimations", {
      configurable: true,
      value: () => [paneAnimation],
    });
    let timeOrigin = 1_000;
    vi.spyOn(performance, "timeOrigin", "get").mockImplementation(() => timeOrigin);
    vi.spyOn(performance, "now").mockReturnValue(100);

    // Layout transactions and display receipts use the process-wide anchored presentation clock.
    expect(presentationNowUnixMs()).toBe(1_100);
    timeOrigin = 970;

    act(() => {
      root.render(
        <RailGridSurface
          traveling
          railPlane={<div className="sidebar flip-move" />}
        >
          <div className="pane flip-move" />
        </RailGridSurface>,
      );
    });

    expect(paneAnimation.startTime).toBeNull();
    act(() => root.unmount());
  });

  it("arms from the candidate transaction-local document bridge, not an independently anchored native epoch", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const handle = createRef<RailGridSurfaceHandle>();
    const animation = {
      animationName: "rail-flip-x",
      startTime: null as number | null,
      currentTime: 0,
      playState: "paused",
      play: vi.fn(),
      pause: vi.fn(),
    };
    Object.defineProperty(HTMLElement.prototype, "getAnimations", {
      configurable: true,
      value: () => [animation],
    });
    vi.spyOn(performance, "timeOrigin", "get").mockReturnValue(3_000);
    vi.spyOn(performance, "now").mockReturnValue(100);
    vi.spyOn(Date, "now").mockReturnValue(3_100);
    expect(presentationNowUnixMs()).toBe(3_100);

    act(() => root.render(
      <RailGridSurface ref={handle} traveling starting railPlane={<div />}><div /></RailGridSurface>,
    ));
    const prepared = await handle.current!.candidateParticipant.prepare("layout-clock-bridge");
    await prepared.arm({
      transactionId: "layout-clock-bridge",
      producer: "display-callback",
      clock: "native-presentation-monotonic",
      sourceGeneration: 1,
      frameSequence: 1,
      commandReceivedAtUnixUs: 1,
      installedAtUnixUs: 2,
      callbackReceivedAtUnixUs: 9_000_000_000_000_000,
      callbackObservedAtUnixMs: 1_092.167,
      callbackObservedAtUnixUs: 1_092_167,
      startAtUnixUs: 1_125_500,
      durationMs: 180,
      documentTimelineBridge: {
        producer: "display-callback-wall-bridge" as const,
        clock: "unix-wall" as const,
        callbackObservedAtUnixUs: 3_092_167,
        startAtUnixUs: 3_125_500,
      },
    } as never);
    expect(animation.startTime).toBe(125.5);
    act(() => root.unmount());
  });

  it("arms an exact candidate while every DOM animation remains paused and can disarm it", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const handle = createRef<RailGridSurfaceHandle>();
    const paneAnimation = {
      animationName: "rail-flip-x",
      startTime: null as number | null,
      play: vi.fn(),
      pause: vi.fn(),
    };
    const railAnimation = {
      animationName: "rail-flip-x",
      startTime: null as number | null,
      play: vi.fn(),
      pause: vi.fn(),
    };
    Object.defineProperty(HTMLElement.prototype, "getAnimations", {
      configurable: true,
      value: () => [paneAnimation, railAnimation],
    });
    vi.spyOn(performance, "timeOrigin", "get").mockReturnValue(1_000);
    vi.spyOn(performance, "now").mockReturnValue(100);
    vi.spyOn(Date, "now").mockReturnValue(1_100);

    act(() => {
      root.render(
        <RailGridSurface
          ref={handle}
          traveling
          starting
          railPlane={<div className="sidebar flip-move" />}
        >
          <div className="pane flip-move" />
        </RailGridSurface>,
      );
    });
    const surface = host.querySelector<HTMLElement>(".space-body")!;
    expect(surface.classList.contains("rail-starting")).toBe(true);

    const participant = handle.current!.candidateParticipant;
    const prepared = await participant.prepare("layout-dom-arm");
    const receipt = {
      transactionId: "layout-dom-arm",
      producer: "display-callback" as const,
      clock: "unix-anchored-monotonic" as const,
      sourceGeneration: 1,
      frameSequence: 7,
      commandReceivedAtUnixUs: 1,
      installedAtUnixUs: 2,
      callbackReceivedAtUnixUs: 9_000_000_000_000_000,
      callbackObservedAtUnixMs: 1_117.5,
      callbackObservedAtUnixUs: 1_117_500,
      startAtUnixUs: 1_125_500,
      durationMs: 180,
      documentTimelineBridge: {
        producer: "display-callback-wall-bridge" as const,
        clock: "unix-wall" as const,
        callbackObservedAtUnixUs: 1_117_500,
        startAtUnixUs: 1_125_500,
      },
    };
    await prepared.arm(receipt);
    expect(paneAnimation.startTime).toBe(125.5);
    expect(railAnimation.startTime).toBe(125.5);
    expect(surface.classList.contains("rail-starting")).toBe(true);

    await prepared.release(receipt);
    expect(paneAnimation.play).toHaveBeenCalledOnce();
    expect(railAnimation.play).toHaveBeenCalledOnce();
    await prepared.rollback(receipt);
    expect(paneAnimation.pause).toHaveBeenCalledOnce();
    expect(railAnimation.pause).toHaveBeenCalledOnce();
    expect(paneAnimation.startTime).toBeNull();
    expect(railAnimation.startTime).toBeNull();

    await prepared.arm(receipt);
    prepared.disarm(receipt);
    expect(paneAnimation.startTime).toBeNull();
    expect(railAnimation.startTime).toBeNull();
    act(() => root.unmount());
  });

  it("release restores the start recomputed by Web Animations play to the exact transaction epoch", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const handle = createRef<RailGridSurfaceHandle>();
    const animation = {
      animationName: "rail-flip-x",
      startTime: null as number | null,
      currentTime: 0,
      playState: "paused",
      play: vi.fn(() => {
        // Web Animations paused→play recomputes startTime, aligning hold time to the current
        // timeline. Production code must reapply the transaction's exact future start after this call.
        animation.startTime = 100;
      }),
      pause: vi.fn(),
    };
    Object.defineProperty(HTMLElement.prototype, "getAnimations", {
      configurable: true,
      value: () => [animation],
    });
    vi.spyOn(performance, "timeOrigin", "get").mockReturnValue(1_000);
    vi.spyOn(performance, "now").mockReturnValue(100);
    vi.spyOn(Date, "now").mockReturnValue(1_100);
    act(() => root.render(
      <RailGridSurface ref={handle} traveling starting railPlane={<div />}><div /></RailGridSurface>,
    ));
    const prepared = await handle.current!.candidateParticipant.prepare("layout-release-start");
    const candidate = {
      transactionId: "layout-release-start",
      producer: "display-callback" as const,
      clock: "unix-anchored-monotonic" as const,
      sourceGeneration: 1,
      frameSequence: 1,
      commandReceivedAtUnixUs: 1,
      installedAtUnixUs: 2,
      callbackReceivedAtUnixUs: 9_000_000_000_000_000,
      callbackObservedAtUnixMs: 1_117.5,
      callbackObservedAtUnixUs: 1_117_500,
      startAtUnixUs: 1_125_500,
      durationMs: 180,
      documentTimelineBridge: {
        producer: "display-callback-wall-bridge" as const,
        clock: "unix-wall" as const,
        callbackObservedAtUnixUs: 1_117_500,
        startAtUnixUs: 1_125_500,
      },
    };
    await prepared.arm(candidate);
    expect(animation.startTime).toBe(125.5);
    await prepared.release(candidate);
    expect(animation.startTime).toBe(125.5);
    act(() => root.unmount());
  });

  it("a release readback with a different double representation is exact at the same integer microsecond epoch", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const handle = createRef<RailGridSurfaceHandle>();
    let storedStartTime: number | null = null;
    const animation = {
      animationName: "rail-flip-x",
      get startTime() { return storedStartTime; },
      set startTime(value: number | null) {
        storedStartTime = value == null ? null : Math.round(value * 1_000) / 1_000;
      },
      currentTime: 0,
      playState: "paused",
      play: vi.fn(),
      pause: vi.fn(),
    };
    Object.defineProperty(HTMLElement.prototype, "getAnimations", {
      configurable: true,
      value: () => [animation],
    });
    let documentNow = 2_300;
    vi.spyOn(performance, "now").mockImplementation(() => documentNow);
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    act(() => root.render(
      <RailGridSurface ref={handle} traveling starting railPlane={<div />}><div /></RailGridSurface>,
    ));
    const prepared = await handle.current!.candidateParticipant.prepare("layout-release-us-identity");
    const candidate = {
      transactionId: "layout-release-us-identity",
      producer: "display-callback" as const,
      clock: "unix-anchored-monotonic" as const,
      sourceGeneration: 2,
      frameSequence: 9,
      commandReceivedAtUnixUs: 1,
      installedAtUnixUs: 2,
      callbackReceivedAtUnixUs: 9_000_000_000_000_000,
      callbackObservedAtUnixMs: 1_000.1,
      callbackObservedAtUnixUs: 1_000_100,
      startAtUnixUs: 1_005_871,
      durationMs: 180,
      documentTimelineBridge: {
        producer: "display-callback-wall-bridge" as const,
        clock: "unix-wall" as const,
        callbackObservedAtUnixUs: 1_000_100,
        startAtUnixUs: 1_005_871,
      },
    };
    await prepared.arm(candidate);
    documentNow = 2_300.000_000_000_000_5;
    await expect(prepared.release(candidate)).resolves.toBeUndefined();
    expect(Math.round(Number(animation.startTime) * 1_000)).toBe(2_305_871);
    act(() => root.unmount());
  });

  it("measures a DOM arm mismatch against the expected document epoch and the actual animation state", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const handle = createRef<RailGridSurfaceHandle>();
    const animation = {
      animationName: "rail-flip-x",
      get startTime() { return 124; },
      set startTime(_value: number | null) {},
      currentTime: 0,
      playState: "paused",
      play: vi.fn(),
      pause: vi.fn(),
    };
    Object.defineProperty(HTMLElement.prototype, "getAnimations", {
      configurable: true,
      value: () => [animation],
    });
    vi.spyOn(performance, "timeOrigin", "get").mockReturnValue(1_000);
    vi.spyOn(performance, "now").mockReturnValue(100);
    vi.spyOn(Date, "now").mockReturnValue(1_100);
    expect(presentationNowUnixMs()).toBe(1_100);

    act(() => root.render(
      <RailGridSurface ref={handle} traveling starting railPlane={<div />}>
        <div />
      </RailGridSurface>,
    ));
    const prepared = await handle.current!.candidateParticipant.prepare("layout-dom-diagnostic");
    await expect(prepared.arm({
      transactionId: "layout-dom-diagnostic",
      producer: "display-callback",
      clock: "unix-anchored-monotonic",
      sourceGeneration: 2,
      frameSequence: 9,
      commandReceivedAtUnixUs: 1,
      installedAtUnixUs: 2,
      callbackReceivedAtUnixUs: 9_000_000_000_000_000,
      callbackObservedAtUnixMs: 1_117.5,
      callbackObservedAtUnixUs: 1_117_500,
      startAtUnixUs: 1_125_500,
      durationMs: 180,
      documentTimelineBridge: {
        producer: "display-callback-wall-bridge",
        clock: "unix-wall",
        callbackObservedAtUnixUs: 1_117_500,
        startAtUnixUs: 1_125_500,
      },
    })).rejects.toMatchObject({
      name: "LayoutPresentationParticipantArmFailure",
      diagnostic: {
        kind: "dom-animation-arm",
        expectedDocumentStartTime: 125.5,
        observedAtUnixUs: 1_100_000,
        remainingLeadMs: 25.5,
        animations: [{
          animationName: "rail-flip-x",
          startTime: 124,
          currentTime: 0,
          playState: "paused",
        }],
      },
    });
    act(() => root.unmount());
  });

  it("arms 7 animations exactly at one document start derived from safe integer Unix-us", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const handle = createRef<RailGridSurfaceHandle>();
    const animations = Array.from({ length: 7 }, () => ({
      animationName: "rail-flip-x",
      startTime: null as number | null,
      currentTime: 0,
      playState: "paused",
      play: vi.fn(),
      pause: vi.fn(),
    }));
    Object.defineProperty(HTMLElement.prototype, "getAnimations", {
      configurable: true,
      value: () => animations,
    });
    vi.spyOn(performance, "timeOrigin", "get").mockReturnValue(1_786_291_851_231);
    vi.spyOn(performance, "now").mockReturnValue(72_910);
    vi.spyOn(Date, "now").mockReturnValue(1_786_291_924_141);
    act(() => root.render(
      <RailGridSurface ref={handle} traveling starting railPlane={<div />}><div /></RailGridSurface>,
    ));
    const prepared = await handle.current!.candidateParticipant.prepare("layout-us-exact");
    await expect(prepared.arm({
      transactionId: "layout-us-exact",
      producer: "display-callback",
      clock: "unix-anchored-monotonic",
      sourceGeneration: 1,
      frameSequence: 1,
      commandReceivedAtUnixUs: 1,
      installedAtUnixUs: 2,
      callbackReceivedAtUnixUs: 9_000_000_000_000_000,
      callbackObservedAtUnixMs: 1_786_291_924_147.6028,
      callbackObservedAtUnixUs: 1_786_291_924_147_603,
      startAtUnixUs: 1_786_291_924_155_936,
      durationMs: 180,
      documentTimelineBridge: {
        producer: "display-callback-wall-bridge", clock: "unix-wall",
        callbackObservedAtUnixUs: 1_786_291_924_147_603,
        startAtUnixUs: 1_786_291_924_155_936,
      },
    } as never)).resolves.toBeUndefined();
    expect(animations.map(({ startTime }) => startTime)).toEqual(Array(7).fill(72_924.936));
    act(() => root.unmount());
  });

  it.each([
    ["divergent", 72_924.935],
    ["null", null],
  ])("a %s animation readback is not an exact canonical arm", async (_name, readback) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const handle = createRef<RailGridSurfaceHandle>();
    const animation = {
      animationName: "rail-flip-x",
      get startTime() { return readback; },
      set startTime(_value: number | null) {},
      currentTime: 0,
      playState: "paused",
      play: vi.fn(),
      pause: vi.fn(),
    };
    Object.defineProperty(HTMLElement.prototype, "getAnimations", { configurable: true, value: () => [animation] });
    vi.spyOn(performance, "timeOrigin", "get").mockReturnValue(1_786_291_851_231);
    vi.spyOn(performance, "now").mockReturnValue(72_910);
    vi.spyOn(Date, "now").mockReturnValue(1_786_291_924_141);
    act(() => root.render(
      <RailGridSurface ref={handle} traveling starting railPlane={<div />}><div /></RailGridSurface>,
    ));
    const prepared = await handle.current!.candidateParticipant.prepare(`layout-us-${_name}`);
    await expect(prepared.arm({
      transactionId: `layout-us-${_name}`,
      producer: "display-callback",
      clock: "unix-anchored-monotonic",
      sourceGeneration: 1,
      frameSequence: 1,
      commandReceivedAtUnixUs: 1,
      installedAtUnixUs: 2,
      callbackReceivedAtUnixUs: 9_000_000_000_000_000,
      callbackObservedAtUnixMs: 1_786_291_924_147.6028,
      callbackObservedAtUnixUs: 1_786_291_924_147_603,
      startAtUnixUs: 1_786_291_924_155_936,
      durationMs: 180,
      documentTimelineBridge: {
        producer: "display-callback-wall-bridge", clock: "unix-wall",
        callbackObservedAtUnixUs: 1_786_291_924_147_603,
        startAtUnixUs: 1_786_291_924_155_936,
      },
    } as never)).rejects.toMatchObject({ name: "LayoutPresentationParticipantArmFailure" });
    act(() => root.unmount());
  });

  it("arms a past Unix-us candidate exactly on a paused animation and leaves the deadline judgement to producer accept", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const handle = createRef<RailGridSurfaceHandle>();
    const animation = {
      animationName: "rail-flip-x", startTime: null as number | null,
      currentTime: 0, playState: "paused", play: vi.fn(), pause: vi.fn(),
    };
    Object.defineProperty(HTMLElement.prototype, "getAnimations", { configurable: true, value: () => [animation] });
    vi.spyOn(performance, "timeOrigin", "get").mockReturnValue(1_000);
    vi.spyOn(performance, "now").mockReturnValue(200);
    vi.spyOn(Date, "now").mockReturnValue(1_200);
    act(() => root.render(
      <RailGridSurface ref={handle} traveling starting railPlane={<div />}><div /></RailGridSurface>,
    ));
    const prepared = await handle.current!.candidateParticipant.prepare("layout-us-past");
    await expect(prepared.arm({
      transactionId: "layout-us-past", producer: "display-callback", clock: "unix-anchored-monotonic",
      sourceGeneration: 1, frameSequence: 1, callbackObservedAtUnixMs: 1_199,
      callbackObservedAtUnixUs: 1_199_000,
      startAtUnixUs: 1_199_000, durationMs: 180,
      documentTimelineBridge: {
        producer: "display-callback-wall-bridge", clock: "unix-wall",
        callbackObservedAtUnixUs: 1_198_000, startAtUnixUs: 1_199_000,
      },
    } as never)).resolves.toBeUndefined();
    expect(animation.startTime).toBe(199);
    expect(animation.play).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
