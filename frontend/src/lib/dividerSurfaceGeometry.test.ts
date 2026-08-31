import { beforeEach, describe, expect, it, vi } from "vitest";
import { dividerSurfaceGeometry } from "./dividerSurfaceGeometry";

const rect = (left: number, top: number, width: number, height: number) => ({
  left, top, width, height, right: left + width, bottom: top + height,
  x: left, y: top, toJSON: () => ({}),
});

describe("divider surface geometry", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="host" style="--pane-inset:5px">
        <div data-node="layout/pane/pan-a" data-pane="pan-a">
          <div data-pane="pan-a"><div id="surface" data-native-surface="browser" data-native-surface-id="browser-a"></div></div>
        </div>
      </div>`;
    const host = document.querySelector<HTMLElement>("#host")!;
    const pane = document.querySelector<HTMLElement>("[data-node='layout/pane/pan-a']")!;
    const surface = document.querySelector<HTMLElement>("#surface")!;
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(rect(0, 80, 1000, 500));
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(rect(5, 85, 990, 240));
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(rect(5, 118, 990, 190));
  });

  it("preserves provider chrome offsets while applying the target pane rectangle", () => {
    const host = document.querySelector<HTMLElement>("#host")!;
    expect(dividerSurfaceGeometry(host, [{
      id: "pan-a", rect: { left: 0, top: 0, width: 100, height: 60 },
    }], 0, 0).get("browser-a")).toEqual({ x: 5, y: 118, width: 990, height: 240 });
  });

  it("normalizes arithmetic residue to the public CSS-pixel precision", () => {
    const host = document.querySelector<HTMLElement>("#host")!;
    const frame = dividerSurfaceGeometry(host, [{
      id: "pan-a", rect: { left: 0, top: 0, width: 100, height: 60.00000000000001 },
    }], 0, 0).get("browser-a");
    expect(frame?.height).toBe(240);
  });
});
