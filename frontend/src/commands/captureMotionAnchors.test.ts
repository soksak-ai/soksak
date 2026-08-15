// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  CAPTURE_MOTION_ANCHOR_ATTR,
  setCaptureMotionAnchors,
} from "./captureMotionAnchors";

describe("capture motion anchors", () => {
  afterEach(() => setCaptureMotionAnchors(document, []));

  it("marks each declared host without adding a React-owned child", () => {
    const left = document.createElement("div");
    const right = document.createElement("div");
    document.body.append(left, right);
    const result = setCaptureMotionAnchors(document, [
      { address: "win/w/proj/t/chrome/layout/tab/left", color: "#00ffff", host: left },
      { address: "win/w/proj/t/chrome/layout/tab/right", color: "#ffff00", host: right },
    ]);

    expect(result).toMatchObject({ visible: true, count: 2 });
    const anchors = document.querySelectorAll<HTMLElement>(`[${CAPTURE_MOTION_ANCHOR_ATTR}]`);
    expect(anchors).toHaveLength(2);
    expect([...anchors]).toEqual([left, right]);
    expect(left.children).toHaveLength(0);
    expect(right.children).toHaveLength(0);
  });

  it("reapplication replaces the declaration and empty declaration removes it idempotently", () => {
    const host = document.createElement("div");
    document.body.append(host);
    setCaptureMotionAnchors(document, [{ address: "old", color: "#00ffff", host }]);
    setCaptureMotionAnchors(document, [{ address: "new", color: "#ffff00", host }]);

    expect(document.querySelectorAll(`[${CAPTURE_MOTION_ANCHOR_ATTR}]`)).toHaveLength(1);
    expect(document.querySelector(`[${CAPTURE_MOTION_ANCHOR_ATTR}]`)?.getAttribute(
      CAPTURE_MOTION_ANCHOR_ATTR,
    )).toBe("new");
    expect(setCaptureMotionAnchors(document, [])).toMatchObject({ visible: false, count: 0 });
    expect(setCaptureMotionAnchors(document, [])).toMatchObject({ visible: false, count: 0 });
  });

  it("places a visual oracle at an explicit offset inside an exposed chrome surface", () => {
    const host = document.createElement("div");
    document.body.append(host);
    setCaptureMotionAnchors(document, [
      { address: "modal/workspace-new", color: "#ff00ff", host, x: 24, y: 80 },
    ]);

    const anchor = document.querySelector<HTMLElement>(`[${CAPTURE_MOTION_ANCHOR_ATTR}]`);
    expect(anchor?.style.getPropertyValue("--capture-motion-anchor-x")).toBe("24px");
    expect(anchor?.style.getPropertyValue("--capture-motion-anchor-y")).toBe("80px");
  });

  it("restores the finite instrumentation declaration when a React render removes it", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    setCaptureMotionAnchors(document, [
      { address: "sidebar/right", color: "#00ff00", host, x: 24, y: 80 },
    ]);

    host.removeAttribute(CAPTURE_MOTION_ANCHOR_ATTR);
    host.removeAttribute("style");
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(host.getAttribute(CAPTURE_MOTION_ANCHOR_ATTR)).toBe("sidebar/right");
    expect(host.style.getPropertyValue("--capture-motion-anchor-color")).toBe("#00ff00");
  });

  it("anchors static hosts locally and restores their inline positioning on cleanup", () => {
    const host = document.createElement("div");
    document.body.append(host);
    setCaptureMotionAnchors(document, [{ address: "toolbar", color: "#00ffff", host }]);
    expect(host.style.position).toBe("relative");
    setCaptureMotionAnchors(document, []);
    expect(host.style.position).toBe("");
  });
});
