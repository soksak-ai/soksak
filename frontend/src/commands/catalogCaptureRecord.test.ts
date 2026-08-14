// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { recordWindowFrames } = vi.hoisted(() => ({
  recordWindowFrames: vi.fn(async ({ frames }: { frames: number }) => frames),
}));

vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: vi.fn(),
  frameworkPath: { tempDir: vi.fn(), join: vi.fn() },
}));
vi.mock("../i18n", () => ({ tmsg: () => "record" }));
vi.mock("../lib/contentViews", () => ({
  contentViewHost: vi.fn(),
  hasContentViewHost: () => false,
}));
vi.mock("../lib/layoutMotion", () => ({
  isLayoutMotionActive: () => false,
  onLayoutMotion: vi.fn(),
}));
vi.mock("./catalogDom", () => ({ resolveExposed: vi.fn() }));
vi.mock("../lib/surfaceRect", () => ({ surfaceRectOf: vi.fn() }));
vi.mock("./address", () => ({ formatAddress: vi.fn() }));
vi.mock("../lib/webviewLabels", () => ({ currentWindowLabel: () => "main" }));
vi.mock("./catalog", () => ({ locateTab: vi.fn() }));
vi.mock("../state/sessions", () => ({ useSessions: { getState: vi.fn() } }));
vi.mock("./windowRecorder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./windowRecorder")>()),
  recordWindowFrames,
}));
vi.mock("./captureCalibration", () => ({
  CAPTURE_CALIBRATION_ID: "capture-calibration",
  setCaptureCalibration: vi.fn(),
}));
vi.mock("./captureMotionAnchors", () => ({ setCaptureMotionAnchors: vi.fn() }));

import { registerCaptureCatalog } from "./catalogCapture";
import { catalogJson, execute, getSpec, unregister } from "./registry";

let registered: string[] = [];

beforeEach(() => {
  recordWindowFrames.mockClear();
  const before = new Set(catalogJson().map(({ name }) => name));
  registerCaptureCatalog();
  registered = catalogJson().map(({ name }) => name).filter((name) => !before.has(name));
});

afterEach(() => {
  for (const name of registered) unregister(name);
  registered = [];
});

describe("window.record maxBytes", () => {
  it("exposes the requested byte budget in the public schema and in the response", async () => {
    expect(getSpec("window.record")?.params.maxBytes).toMatchObject({ type: "number" });

    const result = await execute("window.record", {
      dir: "<local-evidence>/budget-record",
      frames: 3,
      intervalMs: 7,
      maxBytes: 4_096,
    }, {});

    expect(result).toMatchObject({
      ok: true,
      data: { dir: "<local-evidence>/budget-record", frames: 3, maxBytes: 4_096 },
    });
    expect(recordWindowFrames).toHaveBeenCalledOnce();
    expect(recordWindowFrames).toHaveBeenCalledWith({
      dir: "<local-evidence>/budget-record",
      frames: 3,
      intervalMs: 7,
      maxBytes: 4_096,
      frameTimeoutMs: 8_000,
    });
  });

  it.each([1, 1_073_741_824])("accepts the boundary value %d bytes as given", async (maxBytes) => {
    const result = await execute("window.record", {
      dir: "<local-evidence>/budget-boundary",
      frames: 1,
      maxBytes,
    }, {});

    expect(result).toMatchObject({ ok: true, data: { maxBytes } });
    expect(recordWindowFrames).toHaveBeenCalledWith(expect.objectContaining({ maxBytes }));
  });

  it("reports an omitted budget as null and invents no limit for the producer", async () => {
    const result = await execute("window.record", {
      dir: "<local-evidence>/unbudgeted-record",
      frames: 1,
    }, {});

    expect(result).toMatchObject({ ok: true, data: { maxBytes: null } });
    expect(recordWindowFrames).toHaveBeenCalledWith({
      dir: "<local-evidence>/unbudgeted-record",
      frames: 1,
      intervalMs: 40,
      frameTimeoutMs: 8_000,
    });
  });

  it.each([
    0,
    -1,
    1.5,
    1_073_741_825,
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("rejects budget %s with INVALID_PARAMS before the producer call", async (maxBytes) => {
    const result = await execute("window.record", {
      dir: "<local-evidence>/rejected-budget",
      frames: 1,
      maxBytes,
    }, {});

    expect(result).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(recordWindowFrames).not.toHaveBeenCalled();
  });
});

describe("window.record producer deadline", () => {
  it("exposes frameTimeoutMs in the public schema, the response, and the producer call", async () => {
    expect(getSpec("window.record")?.params.frameTimeoutMs).toMatchObject({ type: "number" });

    const result = await execute("window.record", {
      dir: "<local-evidence>/deadline-record",
      frames: 3,
      frameTimeoutMs: 25,
    }, {});

    expect(result).toMatchObject({
      ok: true,
      data: { frameTimeoutMs: 25 },
    });
    expect(recordWindowFrames).toHaveBeenCalledWith(expect.objectContaining({ frameTimeoutMs: 25 }));
  });

  it.each([0, -1, 1.5, 60_001, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects frameTimeoutMs %s before the producer runs",
    async (frameTimeoutMs) => {
      const result = await execute("window.record", {
        dir: "<local-evidence>/rejected-deadline",
        frames: 1,
        frameTimeoutMs,
      }, {});
      expect(result).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
      expect(recordWindowFrames).not.toHaveBeenCalled();
    },
  );
});

describe("window.record strict sequence input", () => {
  it.each([0, -1, 1.5, 601, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects frames %s instead of clamping it silently",
    async (frames) => {
      const result = await execute("window.record", {
        dir: "<local-evidence>/rejected-frames",
        frames,
      }, {});
      expect(result).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
      expect(recordWindowFrames).not.toHaveBeenCalled();
    },
  );

  it.each([-1, 1.5, 60_001, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects intervalMs %s instead of clamping it silently",
    async (intervalMs) => {
      const result = await execute("window.record", {
        dir: "<local-evidence>/rejected-interval",
        frames: 1,
        intervalMs,
      }, {});
      expect(result).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
      expect(recordWindowFrames).not.toHaveBeenCalled();
    },
  );
});
