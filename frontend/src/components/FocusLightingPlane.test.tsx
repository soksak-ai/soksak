// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FocusLightingPlane, type LightingRegion } from "./FocusLightingPlane";
import { railLightingExemption } from "./focusLightingGeometry";

const region = (id: string, left: number, moving = false): LightingRegion => ({
  id,
  moving,
  style: {
    "--l": `${left}%`,
    "--t": "0%",
    "--w": "50%",
    "--h": "100%",
  } as React.CSSProperties,
});

describe("FocusLightingPlane — dark by default, lit only at the focus", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("one lighting plane that never touches content cuts the focus aperture", async () => {
    await act(async () => {
      root.render(
        <FocusLightingPlane
          scopeId="space-a"
          baseAmount={0.5}
          focused={region("focused", 50, true)}
          blocked={[]}
          exempt={[]}
          content={[region("left", 0), region("right", 50)]}
        />,
      );
    });

    const plane = host.querySelector<SVGSVGElement>("[data-node='focus-lighting/space-a']");
    expect(plane).not.toBeNull();
    expect(plane?.getAttribute("aria-hidden")).toBe("true");
    expect(host.querySelector("mask")?.getAttribute("data-node")).toBe(
      "focus-lighting/space-a/mask",
    );
    expect(host.querySelectorAll("[data-lighting-base]")).toHaveLength(1);
    expect(host.querySelector("[data-lighting-base]")?.getAttribute("data-node")).toBe(
      "focus-lighting/space-a/base",
    );
    expect(host.querySelector("[data-lighting-base]")?.getAttribute("fill-opacity")).toBe("0.5");

    const aperture = host.querySelector<SVGRectElement>("[data-lighting-aperture='focused']");
    expect(aperture).not.toBeNull();
    expect(aperture?.getAttribute("data-node")).toBe(
      "focus-lighting/space-a/aperture/focused",
    );
    expect(aperture?.classList.contains("flip-move")).toBe(true);
    expect(aperture?.style.getPropertyValue("--l")).toBe("50%");
  });

  it("blocked is excluded from the base veil and painted once at its own density", async () => {
    await act(async () => {
      root.render(
        <FocusLightingPlane
          scopeId="space-b"
          baseAmount={0.5}
          focused={region("focused", 50)}
          blocked={[{ ...region("blocked", 0), amount: 0.7 }]}
          exempt={[]}
          content={[region("blocked", 0), region("focused", 50)]}
        />,
      );
    });

    // The mask's blocked cutout prevents base and blocked veil from overlapping. An implementation
    // that paints 0.7 over 0.5 and lands at 0.85 is not allowed.
    expect(host.querySelectorAll("[data-lighting-cutout='blocked']")).toHaveLength(1);
    expect(
      host.querySelector("[data-lighting-cutout='blocked']")?.getAttribute("data-node"),
    ).toBe("focus-lighting/space-b/cutout/blocked");
    const blocked = host.querySelector<SVGRectElement>("[data-lighting-blocked='blocked']");
    expect(blocked?.getAttribute("data-node")).toBe(
      "focus-lighting/space-b/blocked/blocked",
    );
    expect(blocked?.getAttribute("fill-opacity")).toBe("0.7");
  });

  it("the left rail area under the work surface is excluded from the lighting mask exactly", async () => {
    const exempt = railLightingExemption(240, 50);
    await act(async () => {
      root.render(
        <FocusLightingPlane
          scopeId="space-c"
          baseAmount={0.5}
          blocked={[]}
          exempt={[exempt]}
          content={[region("left", 0), region("right", 50)]}
        />,
      );
    });

    const cutout = host.querySelector<SVGRectElement>("[data-lighting-exempt='left-rail']");
    expect(cutout).not.toBeNull();
    expect(cutout?.style.getPropertyValue("x")).toBe("calc(50% - 120px)");
    expect(cutout?.style.getPropertyValue("y")).toBe("0px");
    expect(cutout?.style.getPropertyValue("width")).toBe("240px");
    expect(cutout?.style.getPropertyValue("height")).toBe("100%");
  });

  it("an inactive tabview overlapping the rail restores the pane veil and leaves only the exposed rail lit", async () => {
    await act(async () => {
      root.render(
        <FocusLightingPlane
          scopeId="space-d"
          baseAmount={0.5}
          focused={region("right", 50)}
          blocked={[]}
          exempt={[railLightingExemption(240, 50)]}
          content={[region("left", 0), region("right", 50)]}
        />,
      );
    });

    const mask = host.querySelector("[data-node='focus-lighting/space-d/mask']")!;
    const layers = [...mask.children].map((node) => (
      node.getAttribute("data-lighting-exempt")
      ?? node.getAttribute("data-lighting-content")
      ?? node.getAttribute("data-lighting-aperture")
      ?? "base"
    ));
    expect(layers).toEqual(["base", "left-rail", "left", "right", "right"]);
    expect(mask.querySelector("[data-lighting-content='left']")?.getAttribute("fill")).toBe("white");
    expect(mask.querySelector("[data-lighting-exempt='left-rail']")?.getAttribute("fill")).toBe("black");
  });
});
