// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createFiniteDomTraceSampler } from "./finiteDomTrace";

describe("finite DOM transition trace", () => {
  it("records exposed nodes and their CSS animation clocks on the recorder frame clock", () => {
    const rail = document.createElement("div");
    const pane = document.createElement("div");
    pane.dataset.contentVisible = "true";
    pane.dataset.surfaceVisible = "false";
    pane.dataset.visibilityReason = "layout-motion";
    Object.assign(pane.style, { display: "block", visibility: "visible", opacity: "0.75" });
    vi.spyOn(rail, "getBoundingClientRect").mockReturnValue({
      x: 10, y: 20, width: 30, height: 40,
      left: 10, top: 20, right: 40, bottom: 60, toJSON: () => ({}),
    });
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue({
      x: 50, y: 20, width: 100, height: 40,
      left: 50, top: 20, right: 150, bottom: 60, toJSON: () => ({}),
    });
    const effect = { getComputedTiming: () => ({ progress: 0.25 }) };
    Object.defineProperty(rail, "getAnimations", {
      value: () => [{ animationName: "rail-flip-x", startTime: 100, currentTime: 25, playState: "running", effect }],
    });
    Object.defineProperty(pane, "getAnimations", {
      value: () => [{ animationName: "rail-flip-x", startTime: 100, currentTime: 25, playState: "running", effect }],
    });
    const trace = createFiniteDomTraceSampler([
      { address: "rail/left", el: rail },
      { address: "layout/pane/a", el: pane },
    ]);

    trace.sample(0, 16);
    trace.sample(1, 32);
    const samples = trace.samples();

    expect(samples).toHaveLength(2);
    expect(samples[0].nodes).toEqual([
      expect.objectContaining({ address: "rail/left", connected: false, rect: { x: 10, y: 20, w: 30, h: 40 } }),
      expect.objectContaining({
        address: "layout/pane/a",
        connected: false,
        rect: { x: 50, y: 20, w: 100, h: 40 },
        dataset: {
          contentVisible: "true",
          surfaceVisible: "false",
          visibilityReason: "layout-motion",
        },
        style: { display: "block", visibility: "visible", opacity: "0.75" },
      }),
    ]);
    expect(samples[0].nodes.map((node) => node.animations[0])).toEqual([
      expect.objectContaining({ name: "rail-flip-x", startTime: 100, currentTime: 25, progress: 0.25 }),
      expect.objectContaining({ name: "rail-flip-x", startTime: 100, currentTime: 25, progress: 0.25 }),
    ]);
    expect(samples.map((sample) => sample.captureFrame)).toEqual([0, 1]);
  });

  it("records the exposed-node paint stack at every positive intersection on the capture frame", () => {
    const sidebar = document.createElement("aside");
    const tabview = document.createElement("main");
    const tabChild = document.createElement("button");
    sidebar.append(document.createElement("span"));
    tabview.append(tabChild);
    document.body.append(sidebar, tabview);
    vi.spyOn(sidebar, "getBoundingClientRect").mockReturnValue({
      x: 10, y: 20, width: 40, height: 60,
      left: 10, top: 20, right: 50, bottom: 80, toJSON: () => ({}),
    });
    vi.spyOn(tabview, "getBoundingClientRect").mockReturnValue({
      x: 30, y: 20, width: 80, height: 60,
      left: 30, top: 20, right: 110, bottom: 80, toJSON: () => ({}),
    });
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: vi.fn(() => [tabChild, tabview, sidebar, document.body]),
    });
    const trace = createFiniteDomTraceSampler([
      { address: "chrome/sidebar/left", el: sidebar },
      { address: "layout/tabview/right", el: tabview },
    ]);

    trace.sample(7, 32);

    expect(trace.samples()[0]).toMatchObject({
      captureFrame: 7,
      intersections: [{
        addresses: ["chrome/sidebar/left", "layout/tabview/right"],
        rect: { x: 30, y: 20, w: 20, h: 60 },
        point: { x: 40, y: 50 },
        hitStack: ["layout/tabview/right", "chrome/sidebar/left"],
        hitTopmostAddress: "layout/tabview/right",
        paintTopmostAddress: "layout/tabview/right",
      }],
    });
  });
});
