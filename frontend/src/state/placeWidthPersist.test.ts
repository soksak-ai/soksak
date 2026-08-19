// @vitest-environment jsdom
// A width being dragged is written down once, at the end, not on every frame.
//
// `localStorage.setItem` is synchronous and its flush to disk is on the browser's own schedule, so a write
// per frame puts an unpredictable stall in the middle of a gesture. The hook this replaced knew it:
// it wrote on mouse-up and nowhere else.
//
// Measured 2026-08-19 with a write per change: most width changes cost 11-15ms and roughly one in
// three cost 226-402ms, whatever the panes held — terminals only, a browser only, or both. The
// A median that low is not a layout cost; a spread that wide is something intermittent.
//
// So the store keeps the width and the write is its own act. What is on the screen never waits for
// what is on disk.
import { beforeEach, describe, expect, it, vi } from "vitest";

const writes: Array<[string, string]> = [];
vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: (key: string, value: string) => void writes.push([key, value]),
  removeItem: () => {},
  clear: () => {},
});

import {
  placeWidth,
  placeWidthKey,
  persistPlaceWidth,
  setPlaceWidth,
  __resetPlaceWidthsForTest,
} from "./placeWidth";

describe("writing a dragged width down", () => {
  beforeEach(() => {
    writes.length = 0;
    __resetPlaceWidthsForTest();
  });

  it("writes nothing while the width is changing", () => {
    for (const width of [320, 360, 400, 440, 480]) setPlaceWidth("rail", width);
    expect(writes).toEqual([]);
    expect(placeWidth("rail")).toBe(480);
  });

  it("writes the current width when it is asked to", () => {
    setPlaceWidth("rail", 400);
    persistPlaceWidth("rail");
    expect(writes).toEqual([[placeWidthKey("rail"), "400"]]);
  });

  it("writes each place under its own key", () => {
    setPlaceWidth("left", 300);
    setPlaceWidth("right", 260);
    persistPlaceWidth("left");
    persistPlaceWidth("right");
    expect(writes).toEqual([
      [placeWidthKey("left"), "300"],
      [placeWidthKey("right"), "260"],
    ]);
  });
});
