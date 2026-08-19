// @vitest-environment jsdom
// Every rect in a flush is read from one layout, before anything writes to it.
//
// The flush walked the registered elements one at a time: cancel the running animation, measure,
// then start a new one — so element two was measured against a layout element one had already
// perturbed. Each measurement forced a synchronous layout of its own, and the cost is the number of
// elements times a reflow.
//
// Measured 2026-08-19 on a running window, dragging the left edge in `push` mode, where every pane
// re-lays out on every frame: `panes.flush` 315ms, the frame gap 315ms, and the commit that could
// not be answered for the same 315ms — the native side had done its work in 0.2ms and the transport
// had taken 1ms. The document and the page came apart by 200 points, and 15 of 21 frames were out
// of line. In `overlay`, where the panes do not move, the same drag measured 0 points off and 13ms
// worst.
//
// Reads together, writes after. One layout for the set rather than one per element — and one
// instant for every rect, which is what the readings elsewhere in this build already require.
import { beforeEach, describe, expect, it } from "vitest";
import { createRectMotionTracker } from "./layoutRectMotion";

/** An element that records when it is measured and when it is written to. */
function member(order: string[], name: string): HTMLElement {
  const el = document.createElement("div");
  el.dataset.node = name;
  document.body.append(el);
  let box = { x: 0, y: 0, width: 100, height: 100 };
  el.getBoundingClientRect = () => {
    order.push(`read:${name}`);
    return { ...box, top: box.y, left: box.x, right: box.x + box.width, bottom: box.y + box.height, toJSON: () => box } as DOMRect;
  };
  el.animate = (() => {
    order.push(`write:${name}`);
    return { cancel: () => {}, finished: Promise.resolve(), currentTime: 0, playState: "running" } as unknown as Animation;
  }) as HTMLElement["animate"];
  // The move a flush interpolates: the second reading differs from the first.
  Object.defineProperty(el, "__move", {
    value: () => { box = { ...box, x: box.x + 40 }; },
    writable: false,
  });
  return el;
}

describe("a flush over several elements", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("reads every rect before it writes to any of them", () => {
    const order: string[] = [];
    const tracker = createRectMotionTracker();
    const a = member(order, "a");
    const b = member(order, "b");
    const c = member(order, "c");
    for (const el of [a, b, c]) tracker.ref(el);

    tracker.flush(); // baseline — nothing to interpolate against yet
    order.length = 0;
    for (const el of [a, b, c]) (el as unknown as { __move: () => void }).__move();
    tracker.flush();

    const firstWrite = order.findIndex((step) => step.startsWith("write:"));
    const lastRead = order.map((step) => step.startsWith("read:")).lastIndexOf(true);
    expect(order.filter((s) => s.startsWith("read:")).length, order.join(" ")).toBe(3);
    expect(firstWrite, order.join(" ")).toBeGreaterThan(-1);
    expect(lastRead, order.join(" ")).toBeLessThan(firstWrite);
  });

  it("measures each element exactly once", () => {
    // A second measurement of the same element in one flush is a second layout, and the two answers
    // are from different instants.
    const order: string[] = [];
    const tracker = createRectMotionTracker();
    const a = member(order, "a");
    const b = member(order, "b");
    for (const el of [a, b]) tracker.ref(el);
    tracker.flush();
    order.length = 0;
    tracker.flush();
    expect(order.filter((s) => s === "read:a").length).toBe(1);
    expect(order.filter((s) => s === "read:b").length).toBe(1);
  });
});
