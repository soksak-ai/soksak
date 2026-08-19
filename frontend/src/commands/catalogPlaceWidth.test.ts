// The width of a place a sidebar stands in, read and set by name.
//
// A person drags a boundary and the width follows the pointer. Nothing outside could read that
// width or set it, so a drag was the one layout change with no numeric handle at all: reported as
// stuttering and as the document and the native layer coming apart, and neither could be measured
// (L10 — if verifying needs a command, making it is part of the work).
//
// It is one width per place, held in the store the boot cache reads. Setting it is what a drag does
// on every frame, so this drives the same path a pointer drives.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => mem.get(key) ?? null,
  setItem: (key: string, value: string) => void mem.set(key, value),
  removeItem: (key: string) => void mem.delete(key),
  clear: () => mem.clear(),
});
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: vi.fn(async () => undefined),
}));

import { registerCatalog } from "./catalog";
import { execute } from "./registry";
import {
  PLACE_WIDTH_BOUNDS,
  placeWidth,
  setPlaceWidth,
  __resetPlaceWidthsForTest,
} from "../state/placeWidth";

registerCatalog();

const run = (params: Record<string, unknown>) =>
  execute("sidebar.width", params, {}) as unknown as Promise<{
    ok: boolean;
    code?: string;
    data?: { place?: string; width?: number; min?: number; max?: number };
  }>;

describe("sidebar.width", () => {
  beforeEach(() => {
    mem.clear();
    __resetPlaceWidthsForTest();
  });

  it("answers a place's width with the bounds a drag is held to", async () => {
    const answer = await run({ place: "left" });
    expect(answer.ok).toBe(true);
    expect(answer.data?.place).toBe("left");
    expect(answer.data?.width).toBe(placeWidth("left"));
    expect(answer.data?.min).toBe(PLACE_WIDTH_BOUNDS.left.min);
    expect(answer.data?.max).toBe(PLACE_WIDTH_BOUNDS.left.max);
  });

  it("sets the place that was named, and only that one", async () => {
    const railBefore = placeWidth("rail");
    await run({ place: "left", width: 320 });
    expect(placeWidth("left")).toBe(320);
    expect(placeWidth("rail")).toBe(railBefore);
  });

  it("answers each of the three places", async () => {
    for (const place of ["left", "rail", "right"] as const) {
      const answer = await run({ place });
      expect(answer.data?.place, place).toBe(place);
      expect(typeof answer.data?.width, place).toBe("number");
    }
  });

  it("refuses a width outside the bounds, by number", async () => {
    // A drag is clamped to the same bounds. Accepting past them here would set a width a pointer
    // cannot produce, and then the reading is of a state nobody can reach.
    const tooWide = PLACE_WIDTH_BOUNDS.left.max + 1;
    const answer = await run({ place: "left", width: tooWide });
    expect(answer.ok).toBe(false);
    expect(answer.code).toBe("INVALID_PARAMS");
    expect(placeWidth("left")).not.toBe(tooWide);
  });

  it("refuses a place that is not one", async () => {
    const answer = await run({ place: "centre", width: 200 });
    expect(answer.ok).toBe(false);
    expect(answer.code).toBe("INVALID_PARAMS");
  });
});

describe("the width store", () => {
  beforeEach(() => {
    mem.clear();
    __resetPlaceWidthsForTest();
  });

  it("keeps each place's width apart", () => {
    setPlaceWidth("left", 300);
    setPlaceWidth("rail", 180);
    setPlaceWidth("right", 260);
    expect([placeWidth("left"), placeWidth("rail"), placeWidth("right")]).toEqual([300, 180, 260]);
  });

  it("reads a stored width back, and ignores one outside the bounds", () => {
    // The stored value is a cache written by a build that may have had other bounds. Out of range it
    // is the default, not a clamp: a width nobody chose is worse read as a choice.
    mem.set("soksak.width.left", String(PLACE_WIDTH_BOUNDS.left.max + 500));
    __resetPlaceWidthsForTest();
    expect(placeWidth("left")).toBe(PLACE_WIDTH_BOUNDS.left.def);
  });
});
