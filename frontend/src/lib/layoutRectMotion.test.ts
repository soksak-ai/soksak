// A layout change during hold stops **in place** — one leaked frame is a flash.
//
// RED evidence (measured 2026-07-28, live app, motion-slow harness): with hold on, pane.resize
// produced the rect series [678.3, 678.3, 678.3, 678.3, **290.7**, 678.3, …]. Start and end match
// but exactly one sample holds the new layout value. On screen that is a one-frame flash, and it
// breaks precisely what the word "hold" promises.
//
// The cause is the timing of the pinning mechanism. An `el.animate()` effect only attaches at the
// next frame timeline update — creating it in useLayoutEffect (before paint) still paints that
// frame with the new layout. An inline style stands immediately but React's next commit clears it
// (measured, see the module header).
//
// So both are needed: the inline style pins **that frame**, the animation holds **everything
// after**. With only one, each returns to its own failure mode — never delete either.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRectMotionTracker, registerRectMotionExclusion } from "./layoutRectMotion";
import { motionJourneys, setMotionDebug } from "./motionDebug";

function rectOf(x: number, y: number, w: number, h: number): DOMRect {
  return {
    x,
    y,
    width: w,
    height: h,
    top: y,
    left: x,
    right: x + w,
    bottom: y + h,
    toJSON: () => ({}),
  } as DOMRect;
}

/** An element whose layout is set by hand — jsdom does not compute layout.
 *
 * `move` travels: a layout motion is a translation, and a change that only resizes is not one. A
 * helper that could only resize could only exercise the case where nothing moves. */
function laidOut(w: number, h: number) {
  const el = document.createElement("div");
  let cur = rectOf(0, 0, w, h);
  el.getBoundingClientRect = () => cur;
  // Some environments have no WAAPI — with it, use it; without it, the inline style alone must hold.
  document.body.appendChild(el);
  return {
    el,
    move: (x: number, y: number, nw = w, nh = h) => (cur = rectOf(x, y, nw, nh)),
    resize: (nw: number, nh: number) => (cur = rectOf(0, 0, nw, nh)),
  };
}

describe("a layout change during hold", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    setMotionDebug({ hold: false, scale: 1 });
  });

  it("the old rect is pinned inline in place — no waiting for the next frame", () => {
    const t = createRectMotionTracker();
    const { el, move } = laidOut(100, 50);
    t.ref(el);
    t.flush(); // take the baseline

    setMotionDebug({ hold: true });
    move(200, 0); // the command moved it
    t.flush();

    expect(el.style.left, "hold is on and the new position leaked for one frame").toBe("-200px");
    expect(el.style.height).toBe("50px");
  });

  // The whole rectangle is interpolated, position and size. Settling the sizes at once was tried on
  // 2026-08-17 and taken back the same day: a region that opens takes its whole width in the render
  // that opens it while the panes slide into place, so for that stretch the band is drawn where the
  // panes still are — and a page composited above the document covers it. The rectangles have to
  // agree at every instant, not only at the ends.
  it("a change that only resizes is a motion too", () => {
    const t = createRectMotionTracker();
    const { el, resize } = laidOut(100, 50);
    t.ref(el);
    t.flush();

    setMotionDebug({ hold: true });
    resize(300, 50);
    t.flush();

    // The old size is pinned: it is where the interpolation starts.
    expect(el.style.width).toBe("100px");
  });

  it("without hold nothing is pinned inline — that position is the interpolation's", () => {
    const t = createRectMotionTracker();
    const { el, move } = laidOut(100, 50);
    t.ref(el);
    t.flush();

    move(200, 0);
    t.flush();

    expect(el.style.left).toBe("");
  });

  it("reconciles a finished animation even when WebKit defers its finish callback", () => {
    const t = createRectMotionTracker();
    const { el, move } = laidOut(100, 50);
    const animation = {
      cancel: vi.fn(),
      pause: vi.fn(),
      play: vi.fn(),
      currentTime: 0,
      playbackRate: 1,
      playState: "running",
    };
    Object.defineProperty(el, "animate", { configurable: true, value: vi.fn(() => animation) });
    t.ref(el);
    t.flush();
    move(200, 0);
    t.flush();
    expect(motionJourneys().at(-1)?.end).toBeNull();

    // A non-key WebKit window can expose the final Animation state before dispatching onfinish.
    // The finite scan reads that state once after its final captured frame; it must not report the
    // already-finished journey as incomplete merely because the callback is still queued.
    animation.playState = "finished";
    expect(motionJourneys().at(-1)?.end).toBe("finish");
  });

  it("accepts a removed animation only after its declared duration and exact landing", () => {
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const t = createRectMotionTracker();
    const { el, move } = laidOut(100, 50);
    const animation = {
      cancel: vi.fn(),
      pause: vi.fn(),
      play: vi.fn(),
      currentTime: 0,
      playbackRate: 1,
      playState: "running",
    };
    Object.defineProperty(el, "animate", { configurable: true, value: vi.fn(() => animation) });
    t.ref(el);
    t.flush();
    move(200, 0);
    t.flush();

    // WKWebView may auto-remove a completed non-key-window animation before dispatching onfinish.
    // Idle alone is ambiguous; elapsed duration plus the exact destination makes it a completion.
    now += 200;
    animation.playState = "idle";
    expect(motionJourneys().at(-1)).toMatchObject({ end: "finish", landed: { x: 200, y: 0, w: 100, h: 50 } });
  });

  it("keeps an early removed animation classified as cancelled even when layout reveals the destination", () => {
    let now = 2_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const t = createRectMotionTracker();
    const { el, move } = laidOut(100, 50);
    const animation = {
      cancel: vi.fn(), pause: vi.fn(), play: vi.fn(), currentTime: 0,
      playbackRate: 1, playState: "running",
    };
    Object.defineProperty(el, "animate", { configurable: true, value: vi.fn(() => animation) });
    t.ref(el);
    t.flush();
    move(200, 0);
    t.flush();

    // Cancelling removes the animation effect and exposes the final layout rectangle. Geometry
    // alone would therefore lie; the declared 160ms duration is the second required fact.
    now += 40;
    animation.playState = "idle";
    expect(motionJourneys().at(-1)?.end).toBe("cancel");
  });

  it("a structural snap replace adopts the new rect as the baseline instead of interpolating the old rect to the destination", () => {
    const t = createRectMotionTracker();
    const { el, move } = laidOut(100, 50);
    const animate = vi.fn(() => ({
      cancel: vi.fn(),
      pause: vi.fn(),
      play: vi.fn(),
      currentTime: 0,
      playbackRate: 1,
    }));
    Object.defineProperty(el, "animate", { configurable: true, value: animate });
    t.ref(el);
    t.flush();

    move(300, 200);
    t.flush("replace");

    expect(animate, "a structural replace transformed the outline and sidebar from the old position to the new one").not.toHaveBeenCalled();
    expect(el.style.left).toBe("");
    expect(el.style.top).toBe("");
    expect(el.style.left).toBe("");
    expect(el.style.height).toBe("");

    // replace consumed the new rect as the baseline, so the next plain flush does not replay the same change.
    t.flush();
    expect(animate).not.toHaveBeenCalled();
  });

  /** With no change, pin nothing — pinning an unchanged value pollutes the baseline of the next comparison. */
  it("with no change, hold pins nothing", () => {
    const t = createRectMotionTracker();
    const { el } = laidOut(100, 50);
    t.ref(el);
    t.flush();

    setMotionDebug({ hold: true });
    t.flush();

    expect(el.style.left).toBe("");
  });

  /**
   * Release **removes** the inline style and starts the glide from that position.
   *
   * Without removal the element's real rect stays at the old value, the measurement at release
   * reads "did not move", and no glide starts — the hold becomes permanent. The opposite of hold
   * is not permanence.
   */
  it("release removes the inline style", () => {
    const t = createRectMotionTracker();
    const { el, move } = laidOut(100, 50);
    t.ref(el);
    t.flush();

    setMotionDebug({ hold: true });
    move(200, 0);
    t.flush();
    expect(el.style.left).toBe("-200px");

    setMotionDebug({ hold: false });

    expect(el.style.left, "released, and the old rect is still pinned").toBe("");
    expect(el.style.height).toBe("");
  });
});

describe("a viewport resize is not layout motion", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    setMotionDebug({ hold: false, scale: 1 });
  });

  it("a flush after the window bounds changed creates no per-element FLIP", () => {
    let viewportWidth = 1200;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      get: () => viewportWidth,
    });
    const t = createRectMotionTracker();
    const { el, move } = laidOut(600, 400);
    const animate = vi.fn(() => ({
      cancel: vi.fn(),
      pause: vi.fn(),
      play: vi.fn(),
      currentTime: 0,
      playbackRate: 1,
    }));
    Object.defineProperty(el, "animate", { configurable: true, value: animate });
    t.ref(el);
    t.flush();

    viewportWidth = 900;
    move(450, 400);
    t.flush();

    expect(animate, "a viewport reflow was promoted to per-element motion").not.toHaveBeenCalled();
  });
});

describe("the interpolation exclusion is not the core's", () => {
  // Re-legislated 2026-08-03 — the old rule was "never key the hole exclusion on the framework
  // axis", based on the 2026-08-02 measurement: an in-DOM guest left old pixels at the end of the
  // interpolation.
  //
  // **That basis is gone.** Back then the guest hung on a global layer and was pushed by
  // coordinates (domHost copied an out-of-document model into the document). Now the guest is a
  // child of its own slot and inherits the ancestor's transform — that is composition, not
  // relayout, so falling behind is not possible.
  //
  // One reason remains and it is not universal: "the surface under that slot does not follow the
  // slot's transform" is true only when the content is outside the document. If the core holds
  // that rule, then on a framework where it never happens, that one pane arrives instantly while
  // its neighbours slide — the exclusion creates a defect that did not exist.
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "layoutRectMotion.ts"),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("the core holds no hole rule — the registering side answers which slot is excluded", () => {
    expect(src, "the core excludes the hole itself").not.toMatch(/classList\.contains\("hole"\)/);
    expect(src, "the core keys on the framework axis").not.toMatch(/nativeChildWebview/);
    // The hook must exist — without it there is no way to exclude at all, and that is a different defect.
    expect(src).toMatch(/registerRectMotionExclusion/);
  });

  it("with nothing registered a hole slot is interpolated too — no defect is created on a framework where it never happens", () => {
    setMotionDebug({ hold: true }); // the path that pins the old rect inline — observation is certain
    const t = createRectMotionTracker();
    const { el, move } = laidOut(100, 50);
    el.classList.add("hole");
    t.ref(el);
    t.flush();
    move(200, 0);
    t.flush();
    // If it is interpolated, the old width stands there. If excluded, nothing stands.
    expect(el.style.left, "the hole slot was excluded by the core").toBe("-200px");
  });

  it("with it registered the slot is excluded — the judgement is the registering side's", () => {
    setMotionDebug({ hold: true });
    const off = registerRectMotionExclusion((e) => e.classList.contains("hole"));
    try {
      const t = createRectMotionTracker();
      const { el, move } = laidOut(100, 50);
      el.classList.add("hole");
      t.ref(el);
      t.flush();
      move(200, 0);
      t.flush();
      expect(el.style.left, "registered, and the hole slot was still interpolated").toBe("");
      // Oracle survival — a non-hole slot is still interpolated (the exclusion does not swallow everything).
      const other = laidOut(100, 50);
      t.ref(other.el);
      t.flush();
      other.move(200, 0);
      t.flush();
      expect(other.el.style.left).toBe("-200px");
    } finally {
      off();
    }
  });
});
