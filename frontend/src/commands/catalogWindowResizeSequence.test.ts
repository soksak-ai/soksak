// @vitest-environment jsdom

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { currentWindow, recordWindowFrames, sampleWindowResizeProbe, setPhysicalSize } = vi.hoisted(() => ({
  currentWindow: vi.fn(),
  recordWindowFrames: vi.fn(),
  sampleWindowResizeProbe: vi.fn(),
  setPhysicalSize: vi.fn(),
}));

vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: vi.fn(),
  currentWindow,
  windowByLabel: vi.fn(),
}));
vi.mock("../i18n", () => ({ tmsg: () => "resize sequence" }));
vi.mock("../lib/workspaceRoot", () => ({ validateWorkspaceRoot: vi.fn() }));
// Do not imitate the grammar — use the real derivation and replace only the window name with this test's.
vi.mock("../lib/webviewLabels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/webviewLabels")>();
  return {
    ...actual,
    browserLabelPrefix: (label: string) => actual.browserLabelPrefixIn(label ?? "main"),
    currentWindowLabel: () => "main",
  };
});
vi.mock("../state/windowBoot", () => ({ forgetWindowSlot: vi.fn() }));
vi.mock("../lib/windowResizeProbe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/windowResizeProbe")>()),
  sampleWindowResizeProbe,
}));
vi.mock("./windowRecorder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./windowRecorder")>()),
  recordWindowFrames,
}));

import { registerWindowCatalog } from "./catalogWindow";
import { catalogJson, execute, getSpec, unregister } from "./registry";

let registered: string[] = [];

beforeAll(() => {
  const before = new Set(catalogJson().map(({ name }) => name));
  registerWindowCatalog();
  registered = catalogJson().map(({ name }) => name).filter((name) => !before.has(name));
});

afterAll(() => {
  for (const name of registered) unregister(name);
});

beforeEach(() => {
  setPhysicalSize.mockReset().mockResolvedValue(undefined);
  currentWindow.mockReset().mockReturnValue({ setPhysicalSize });
  sampleWindowResizeProbe.mockReset().mockResolvedValue({ sample: true });
  recordWindowFrames.mockReset().mockImplementation(({ frames }: { frames: number }) =>
    Object.assign(Promise.resolve(frames), { ready: Promise.resolve() }));
});

describe("window.resizeSequence recording contract", () => {
  it("passes the public byte budget to the recorder unchanged and keeps recording status out of the resize result", async () => {
    expect(getSpec("window.resizeSequence")?.params.recordMaxBytes).toMatchObject({ type: "number" });

    const result = await execute("window.resizeSequence", {
      sizes: [{ w: 800, h: 600 }, { w: 1200, h: 800 }],
      intervalMs: 0,
      recordDir: "/evidence/resize",
      recordFrames: 20,
      recordIntervalMs: 7,
      recordMaxBytes: 4_096,
    }, {});

    expect(result).toMatchObject({
      ok: true,
      data: {
        steps: 2,
        recording: {
          status: "complete",
          mode: "realtime",
          dir: "/evidence/resize",
          requestedFrames: 20,
          frames: 20,
        },
      },
    });
    expect(result).not.toHaveProperty("data.frames");
    expect(recordWindowFrames).toHaveBeenCalledWith(expect.objectContaining({
      dir: "/evidence/resize",
      frames: 20,
      intervalMs: 7,
      maxBytes: 4_096,
      onFrame: expect.any(Function),
    }));
  });

  it("reports the observation before the first resize as baseline and declares it in the response contract", async () => {
    expect(getSpec("window.resizeSequence")?.returns).toContain("baseline");

    let applied = 0;
    setPhysicalSize.mockImplementation(async () => { applied += 1; });
    sampleWindowResizeProbe.mockImplementation(async () => ({ resizesApplied: applied }));

    const result = await execute("window.resizeSequence", {
      sizes: [{ w: 800, h: 600 }, { w: 1200, h: 800 }],
      intervalMs: 0,
    }, {});

    expect(result).toMatchObject({
      ok: true,
      data: {
        steps: 2,
        baseline: { status: "observed", observation: { resizesApplied: 0 } },
        samples: [
          { step: 0, size: { w: 800, h: 600 }, observation: { resizesApplied: 1 } },
          { step: 1, size: { w: 1200, h: 800 }, observation: { resizesApplied: 2 } },
        ],
      },
    });
  });

  it("reports the reason when the baseline observation is rejected and still applies every resize step", async () => {
    let applied = 0;
    setPhysicalSize.mockImplementation(async () => { applied += 1; });
    sampleWindowResizeProbe.mockImplementation(async () => {
      if (applied === 0) throw new Error("no native resize transaction has settled yet");
      return { resizesApplied: applied };
    });

    const result = await execute("window.resizeSequence", {
      sizes: [{ w: 800, h: 600 }, { w: 1200, h: 800 }],
      intervalMs: 0,
    }, {});

    expect(result).toMatchObject({
      ok: true,
      data: {
        steps: 2,
        baseline: { status: "unavailable", reason: "no native resize transaction has settled yet" },
      },
    });
    expect(setPhysicalSize).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["recordFrames", 0],
    ["recordFrames", 601],
    ["recordFrames", 1.5],
    ["recordIntervalMs", -1],
    ["recordIntervalMs", 1_001],
    ["recordIntervalMs", Number.POSITIVE_INFINITY],
    ["recordMaxBytes", 0],
    ["recordMaxBytes", 1_073_741_825],
    ["recordMaxBytes", 1.5],
  ])("rejects %s=%s before the producer and the resize instead of clamping it", async (field, value) => {
    const result = await execute("window.resizeSequence", {
      sizes: [{ w: 800, h: 600 }],
      intervalMs: 0,
      recordDir: "/evidence/resize",
      [field]: value,
    }, {});

    expect(result).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(recordWindowFrames).not.toHaveBeenCalled();
    expect(setPhysicalSize).not.toHaveBeenCalled();
  });

  it("passes the caller's declared step intent to the observation surface unchanged", async () => {
    const result = await execute("window.resizeSequence", {
      sizes: [{ w: 800, h: 600, phase: "shrink" }, { w: 1200, h: 800, phase: "restore" }],
      intervalMs: 0,
    }, {});

    expect(result).toMatchObject({ ok: true });
    expect(sampleWindowResizeProbe).toHaveBeenNthCalledWith(1, { kind: "baseline" });
    expect(sampleWindowResizeProbe).toHaveBeenNthCalledWith(2, {
      kind: "step", step: 0, size: { w: 800, h: 600 }, phase: "shrink",
    });
    expect(sampleWindowResizeProbe).toHaveBeenNthCalledWith(3, {
      kind: "step", step: 1, size: { w: 1200, h: 800 }, phase: "restore",
    });
  });

  it("rejects an unknown step name by that name before the resize", async () => {
    const result = await execute("window.resizeSequence", {
      sizes: [{ w: 800, h: 600, phase: "squish" }],
      intervalMs: 0,
    }, {});

    expect(result).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(String((result as { message?: string }).message)).toContain("squish");
    expect(setPhysicalSize).not.toHaveBeenCalled();
  });
});
