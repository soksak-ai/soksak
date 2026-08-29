// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginLayoutMotion, endLayoutMotion, __resetLayoutMotionForTest } from "../lib/layoutMotion";
import { layoutSettlementStatus, waitLayoutSettled } from "./waitLayoutSettled";
import {
  __resetLayoutSettlementForTest,
  invalidateLayout,
  settleLayout,
} from "../lib/layoutSettlement";
import {
  __resetContentViewHostForTest,
  registerContentViewHost,
  type ContentViewHost,
} from "../lib/contentViews";
import {
  __resetPluginViewPresentationHostForTest,
  registerPluginViewPresentationHost,
  type PluginViewPresentationHost,
} from "../plugins/viewPresentationHost";

describe("waitLayoutSettled — event-driven layout transaction barrier", () => {
  afterEach(() => {
    __resetLayoutMotionForTest();
    __resetLayoutSettlementForTest();
    __resetContentViewHostForTest();
    __resetPluginViewPresentationHostForTest();
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, "getAnimations");
  });

  const animations = (values: Animation[]) => {
    Object.defineProperty(document, "getAnimations", {
      configurable: true,
      value: vi.fn(() => values),
    });
  };

  it("does not complete before the edge that closes the active phase", async () => {
    animations([]);
    beginLayoutMotion("move");
    let done = false;
    const waiting = waitLayoutSettled().then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    endLayoutMotion("move");
    await waiting;
    expect(done).toBe(true);
  });

  it("completes after the finished edge of a running CSS animation", async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const animation = {
      playState: "running",
      pending: false,
      animationName: "rail-flip-x",
      finished,
    } as unknown as Animation;
    animations([animation]);
    const getAnimations = document.getAnimations as ReturnType<typeof vi.fn>;
    getAnimations.mockReturnValueOnce([animation]).mockReturnValue([]);
    let done = false;
    const waiting = waitLayoutSettled().then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    finish();
    await waiting;
    expect(done).toBe(true);
  });

  it("confirms a quiet layout on the next paint before accepting settlement", async () => {
    let paint!: FrameRequestCallback;
    const request = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      paint = callback;
      return 41;
    });
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const animation = {
      id: "phase",
      playState: "running",
      pending: false,
      finished,
    } as unknown as Animation;
    const visible: Animation[] = [];
    animations(visible);

    let done = false;
    const waiting = waitLayoutSettled().then(() => { done = true; });
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    expect(done).toBe(false);

    // React's layout effect creates the FLIP after the first quiet inspection but before paint.
    visible.push(animation);
    paint(16);
    await Promise.resolve();
    expect(done).toBe(false);

    visible.length = 0;
    finish();
    await Promise.resolve();
    paint(32);
    await waiting;
    expect(done).toBe(true);
  });

  it("does not complete before the renderer ACKs the state mutation revision", async () => {
    animations([]);
    const revision = invalidateLayout("wsp-4h7kq2");
    let done = false;
    const waiting = waitLayoutSettled().then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    settleLayout("wsp-4h7kq2", revision);
    await waiting;
    expect(done).toBe(true);
  });

  it("a pending revision unrelated to the current workspace does not block settlement of the current window", async () => {
    animations([]);
    invalidateLayout("inactive-workspace");
    const result = await waitLayoutSettled(4_000, "active-workspace");
    expect(result.waitedMs).toBeGreaterThanOrEqual(0);
  });

  it("does not answer before the content host's real presentation barrier completes", async () => {
    animations([]);
    document.body.innerHTML = '<div data-content-view-body="browser.main.tab-current"></div>';
    let present!: () => void;
    const barrier = new Promise<void>((resolve) => { present = resolve; });
    const presentationSettled = vi.fn(() => barrier);
    registerContentViewHost({ presentationSettled } as unknown as ContentViewHost);
    let done = false;
    const waiting = waitLayoutSettled().then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    expect(presentationSettled).toHaveBeenCalledWith(["browser.main.tab-current"], expect.any(Number));
    present();
    await waiting;
    expect(done).toBe(true);
  });

  it("gives the content barrier a shorter deadline than its own, so the reason arrives first", async () => {
    // The surface barrier has its own limit and the words for what is wrong — declared N, committed
    // M, still dirty, observer not running, last error. Its limit was 5,000ms and this wait's was
    // 4,000, so it never once got to say any of it: the caller gave up first and answered TIMEOUT
    // with a pending entry and no cause.
    //
    // Measured 2026-08-19, twice, in the full suite: `ui.layout.wait-settled` failed with
    // `presentationPending [{owner:"content", labels:[], elapsedMs:4101}]` and everything else in
    // the reading said settled. Two deadlines, and the one with nothing to report expires first.
    animations([]);
    document.body.innerHTML = '<div data-content-view-body="browser.main.tab-current"></div>';
    const presentationSettled = vi.fn(() => new Promise<void>(() => {}));
    registerContentViewHost({ presentationSettled } as unknown as ContentViewHost);
    const waiting = waitLayoutSettled(4_000).catch(() => {});
    await Promise.resolve();
    const [, limit] = presentationSettled.mock.calls[0] as unknown as [string[], number];
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThan(4_000);
    vi.useFakeTimers();
    vi.advanceTimersByTime(4_000);
    vi.useRealTimers();
    await waiting;
  });

  it("does not answer before the content surface and the plugin view presentation barrier both close", async () => {
    animations([]);
    document.body.innerHTML = '<div data-content-view-body="browser.main.tab-current"></div>';
    let settleContent!: () => void;
    let settlePluginView!: () => void;
    const contentBarrier = new Promise<void>((resolve) => { settleContent = resolve; });
    const pluginViewBarrier = new Promise<void>((resolve) => { settlePluginView = resolve; });
    const contentPresentationSettled = vi.fn(() => contentBarrier);
    const pluginViewPresentationSettled = vi.fn(() => pluginViewBarrier);
    registerContentViewHost({
      presentationSettled: contentPresentationSettled,
    } as unknown as ContentViewHost);
    registerPluginViewPresentationHost({
      mount: vi.fn(),
      presentationSettled: pluginViewPresentationSettled,
    } as unknown as PluginViewPresentationHost);

    let done = false;
    const waiting = waitLayoutSettled().then(() => { done = true; });
    await Promise.resolve();
    const bothArmedBeforeSettlement = contentPresentationSettled.mock.calls.length === 1
      && pluginViewPresentationSettled.mock.calls.length === 1;

    settleContent();
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    const doneWithPluginViewPending = done;

    settlePluginView();
    await waiting;
    expect(contentPresentationSettled).toHaveBeenCalledWith(["browser.main.tab-current"], expect.any(Number));
    expect(pluginViewPresentationSettled).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(bothArmedBeforeSettlement).toBe(true);
    expect(doneWithPluginViewPending).toBe(false);
    expect(done).toBe(true);
  });

  it("exposes the running presentation owner and provider substage in status and withdraws them after the close", async () => {
    animations([]);
    let settlePluginView!: () => void;
    const pluginViewBarrier = new Promise<void>((resolve) => { settlePluginView = resolve; });
    let pending = true;
    registerPluginViewPresentationHost({
      mount: vi.fn(),
      presentationSettled: vi.fn(async () => {
        await pluginViewBarrier;
        pending = false;
      }),
      presentationPending: vi.fn(() => pending ? [{
        owner: "view", stage: "presented", labels: ["browser.main.tab-current"],
        startedAtUnixMs: 10, elapsedMs: 7,
      }] : []),
    } as unknown as PluginViewPresentationHost);

    const waiting = waitLayoutSettled();
    await Promise.resolve();
    expect(layoutSettlementStatus()).toMatchObject({
      presentationPending: [{
        owner: "view", stage: "presented", labels: ["browser.main.tab-current"], startedAtUnixMs: expect.any(Number),
        elapsedMs: expect.any(Number),
      }],
    });
    settlePluginView();
    await waiting;
    expect(layoutSettlementStatus()).toMatchObject({ presentationPending: [] });
  });

  it("a presentation reject and a timeout both withdraw the pending owner", async () => {
    animations([]);
    let rejectedPending = true;
    registerPluginViewPresentationHost({
      mount: vi.fn(),
      presentationSettled: vi.fn(async () => {
        try { throw new Error("provider rejected"); } finally { rejectedPending = false; }
      }),
      presentationPending: vi.fn(() => rejectedPending ? [{ owner: "view", stage: "visibility" }] : []),
    } as unknown as PluginViewPresentationHost);
    await expect(waitLayoutSettled()).rejects.toThrow("provider rejected");
    expect(layoutSettlementStatus()).toMatchObject({ presentationPending: [] });

    __resetPluginViewPresentationHostForTest();
    let timeoutPending = true;
    registerPluginViewPresentationHost({
      mount: vi.fn(),
      presentationSettled: vi.fn((signal?: AbortSignal) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          timeoutPending = false;
          reject(new Error("aborted"));
        }, { once: true });
      })),
      presentationPending: vi.fn(() => timeoutPending
        ? [{ owner: "view", stage: "composition-settle" }]
        : []),
    } as unknown as PluginViewPresentationHost);
    await expect(waitLayoutSettled(1)).rejects.toThrow(/1ms/);
    expect(layoutSettlementStatus()).toMatchObject({ presentationPending: [] });
  });

  it("the internal deadline preserves the provider pending ledger in the error receipt and then finishes the abort cleanup", async () => {
    animations([]);
    let pending = true;
    registerPluginViewPresentationHost({
      mount: vi.fn(),
      presentationSettled: vi.fn((signal?: AbortSignal) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          pending = false;
          reject(new Error("composition waiter aborted"));
        }, { once: true });
      })),
      presentationPending: vi.fn(() => pending ? [{
        owner: "view", stage: "composition-settle", labels: ["rlm-1", "browser.main.tab-1"],
        startedAtUnixMs: 10, elapsedMs: 7,
      }] : []),
    } as unknown as PluginViewPresentationHost);

    await expect(waitLayoutSettled(1)).rejects.toMatchObject({
      name: "LayoutSettlementTimeout",
      code: "TIMEOUT",
      status: {
        presentationPending: [{
          owner: "view", stage: "composition-settle", labels: ["rlm-1", "browser.main.tab-1"],
        }],
      },
    });
    expect(layoutSettlementStatus()).toMatchObject({ presentationPending: [] });
  });

  it("discards the old barrier result when a new layout motion opens during the check and checks again in the new settlement generation", async () => {
    animations([]);
    let rejectOld!: (error: Error) => void;
    const oldBarrier = new Promise<void>((_resolve, reject) => { rejectOld = reject; });
    const presentationSettled = vi.fn()
      .mockImplementationOnce(() => oldBarrier)
      .mockResolvedValueOnce(undefined);
    registerPluginViewPresentationHost({
      mount: vi.fn(),
      presentationSettled,
    } as unknown as PluginViewPresentationHost);

    let outcome = "pending";
    const waiting = waitLayoutSettled().then(
      () => { outcome = "resolved"; },
      () => { outcome = "rejected"; },
    );
    await Promise.resolve();
    expect(presentationSettled).toHaveBeenCalledTimes(1);

    beginLayoutMotion("move");
    rejectOld(new Error("old pane composition mismatch"));
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    expect(outcome).toBe("pending");

    endLayoutMotion("move");
    await waiting;
    expect(outcome).toBe("resolved");
    expect(presentationSettled).toHaveBeenCalledTimes(2);
  });

  it("does not adopt an old barrier that succeeds late after a new motion as the current settlement", async () => {
    animations([]);
    let settleOld!: () => void;
    const oldBarrier = new Promise<void>((resolve) => { settleOld = resolve; });
    const presentationSettled = vi.fn()
      .mockImplementationOnce(() => oldBarrier)
      .mockResolvedValueOnce(undefined);
    registerPluginViewPresentationHost({
      mount: vi.fn(), presentationSettled,
    } as unknown as PluginViewPresentationHost);

    let done = false;
    const waiting = waitLayoutSettled().then(() => { done = true; });
    await Promise.resolve();
    beginLayoutMotion("move");
    settleOld();
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    expect(done).toBe(false);

    endLayoutMotion("move");
    await waiting;
    expect(presentationSettled).toHaveBeenCalledTimes(2);
  });

  it("a layout settlement revision edge also changes the generation of a running barrier", async () => {
    animations([]);
    let settleOld!: () => void;
    const oldBarrier = new Promise<void>((resolve) => { settleOld = resolve; });
    const presentationSettled = vi.fn()
      .mockImplementationOnce(() => oldBarrier)
      .mockResolvedValueOnce(undefined);
    registerPluginViewPresentationHost({
      mount: vi.fn(), presentationSettled,
    } as unknown as PluginViewPresentationHost);

    let done = false;
    const waiting = waitLayoutSettled(4_000, "workspace-a").then(() => { done = true; });
    await Promise.resolve();
    const revision = invalidateLayout("workspace-a");
    settleOld();
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    expect(done).toBe(false);

    settleLayout("workspace-a", revision);
    await waiting;
    expect(presentationSettled).toHaveBeenCalledTimes(2);
  });

  it("a layout settlement edge of another workspace does not change the barrier generation of the current window", async () => {
    animations([]);
    let settleBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => { settleBarrier = resolve; });
    const presentationSettled = vi.fn(() => barrier);
    registerPluginViewPresentationHost({
      mount: vi.fn(), presentationSettled,
    } as unknown as PluginViewPresentationHost);

    const waiting = waitLayoutSettled(4_000, "workspace-a");
    await Promise.resolve();
    const revision = invalidateLayout("workspace-b");
    settleLayout("workspace-b", revision);
    settleBarrier();
    await waiting;

    expect(presentationSettled).toHaveBeenCalledTimes(1);
  });

  it("a genuine barrier error of the same settlement generation is rejected as is", async () => {
    animations([]);
    let rejectBarrier!: (error: Error) => void;
    const barrier = new Promise<void>((_resolve, reject) => { rejectBarrier = reject; });
    registerPluginViewPresentationHost({
      mount: vi.fn(), presentationSettled: vi.fn(() => barrier),
    } as unknown as PluginViewPresentationHost);

    const waiting = waitLayoutSettled();
    await Promise.resolve();
    rejectBarrier(new Error("current pane composition mismatch"));

    await expect(waiting).rejects.toThrow("current pane composition mismatch");
  });

  it("a content provider rejection is preserved structured as barrier, label, elapsed and the original error", async () => {
    animations([]);
    document.body.innerHTML = '<div data-content-view-body="browser.main.tab-current"></div>';
    registerContentViewHost({
      presentationSettled: vi.fn().mockRejectedValue({
        code: "NATIVE_PRESENTATION_REJECTED",
        message: "content surface rejected",
        data: { label: "browser.main.tab-current", revision: 7 },
      }),
    } as unknown as ContentViewHost);

    await expect(waitLayoutSettled()).rejects.toMatchObject({
      name: "LayoutSettlementFailure",
      code: "PRESENTATION_PROVIDER_FAILED",
      receipt: {
        command: "ui.layout.wait-settled",
        barrier: "content",
        elapsedMs: expect.any(Number),
        labels: ["browser.main.tab-current"],
        providerError: {
          kind: "object",
          code: "NATIVE_PRESENTATION_REJECTED",
          message: "content surface rejected",
          data: { label: "browser.main.tab-current", revision: 7 },
        },
      },
    });
  });

  it("a non-Error InvokeError from a view provider is not discarded as an unknown string", async () => {
    animations([]);
    registerPluginViewPresentationHost({
      mount: vi.fn(),
      presentationSettled: vi.fn().mockRejectedValue({
        code: "INVOKE_ERROR",
        message: "An unknown error occurred",
        data: { command: "webview_presented", label: "rlm-1" },
      }),
    } as unknown as PluginViewPresentationHost);

    await expect(waitLayoutSettled()).rejects.toMatchObject({
      name: "LayoutSettlementFailure",
      code: "PRESENTATION_PROVIDER_FAILED",
      receipt: {
        command: "ui.layout.wait-settled",
        barrier: "view",
        elapsedMs: expect.any(Number),
        labels: [],
        providerError: {
          kind: "object",
          code: "INVOKE_ERROR",
          message: "An unknown error occurred",
          data: { command: "webview_presented", label: "rlm-1" },
        },
      },
    });
  });
});
