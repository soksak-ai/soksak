import { describe, expect, it } from "vitest";

import { applyParked, parkedStyle } from "./layerPark";

describe("parked DOM lifetime without hidden layout cost", () => {
  it("removes an inactive subtree from layout and restores the same element", () => {
    const element = document.createElement("div");
    applyParked(element, false);
    expect(element.style.visibility).toBe("hidden");
    expect(element.style.contentVisibility).toBe("hidden");

    applyParked(element, true);
    expect(element.style.visibility).toBe("");
    expect(element.style.contentVisibility).toBe("");
  });

  it("declares the same rule for React-owned parked layers", () => {
    expect(parkedStyle(false)).toMatchObject({
      visibility: "hidden",
      contentVisibility: "hidden",
      pointerEvents: "none",
    });
    expect(parkedStyle(true).contentVisibility).toBeUndefined();
  });
});
