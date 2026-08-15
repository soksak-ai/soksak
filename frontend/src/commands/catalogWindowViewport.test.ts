// @vitest-environment jsdom

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke,
  currentWindow: vi.fn(),
  windowByLabel: vi.fn(),
}));
vi.mock("../i18n", () => ({ tmsg: () => "window viewport" }));
vi.mock("../lib/projectRoot", () => ({ validateProjectRoot: vi.fn() }));
vi.mock("../lib/webviewLabels", () => ({
  browserLabelPrefix: vi.fn(),
  currentWindowLabel: () => "win-retina",
}));
vi.mock("../state/windowBoot", () => ({ forgetWindowSlot: vi.fn() }));

import { registerWindowCatalog } from "./catalogWindow";
import { catalogJson, execute, getSpec, unregister } from "./registry";

let registered: string[] = [];

beforeAll(() => {
  const before = new Set(catalogJson().map(({ name }) => name));
  registerWindowCatalog();
  registered = catalogJson().map(({ name }) => name).filter((name) => !before.has(name));
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
  vi.spyOn(document.documentElement, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, width: 1200, height: 800,
  } as DOMRect);
  vi.spyOn(document.body, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, width: 1200, height: 800,
  } as DOMRect);
});

afterAll(() => {
  for (const name of registered) unregister(name);
});

describe("window.viewport native/DOM root receipt", () => {
  it("records the AppKit content, the main WKWebView, and the DOM viewport/root in one generation", async () => {
    invoke.mockResolvedValue({
      window: "win-retina",
      generation: 7,
      sequence: 19,
      trigger: "attach",
      matched: true,
      backingScale: 2,
      contentBounds: { x: 0, y: 0, w: 1200, h: 800 },
      mainRootFrame: { x: 0, y: 0, w: 1200, h: 800 },
      events: [{ sequence: 19, trigger: "attach", matched: true }],
      maxEvents: 64,
    });

    const returns = getSpec("window.viewport")?.returns;
    expect(returns).toContain("mainRootFrame");
    expect(returns).toContain("requestedFrame");
    expect(returns).toContain("corrected");
    expect(returns).toContain("owner");
    expect(returns).toContain("trigger");
    expect(returns).toContain("events");
    const result = await execute("window.viewport", {}, {});
    expect(result).toMatchObject({
      ok: true,
      data: {
        window: "win-retina",
        generation: 7,
        sequence: 19,
        trigger: "attach",
        matched: true,
        backingScale: 2,
        contentBounds: { x: 0, y: 0, w: 1200, h: 800 },
        mainRootFrame: { x: 0, y: 0, w: 1200, h: 800 },
        events: [{ sequence: 19, trigger: "attach", matched: true }],
        maxEvents: 64,
        dom: {
          innerWidth: 1200,
          innerHeight: 800,
          devicePixelRatio: 2,
          documentElement: { x: 0, y: 0, w: 1200, h: 800 },
          body: { x: 0, y: 0, w: 1200, h: 800 },
        },
        fill: { widthRatio: 1, heightRatio: 1, areaRatio: 1, matched: true },
      },
    });
    expect(invoke).toHaveBeenCalledWith("window_viewport_native", { label: "win-retina" });
  });
});
