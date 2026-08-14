// JS-owned interpolation (FLIP) for command-driven layout changes — user-confirmed criterion
// (2026-07-26): split, maximize, close, and ratio changes must be real motion, and slow, hold, and trace
// (ui.motion/ui.trace) must apply to that motion itself.
//
// Why not CSS transitions (measured): WKWebView does not start a transition on a calc-consuming property
// when a custom property (--l and the rest) changes, and it does not interpolate transitions of
// @property-registered variables either (computed advances while rect jumps in one frame — ui.trace
// sample). So the core interpolates the rect difference directly with element.animate and adopts it into
// motionDebug so that multiplier and hold apply without exception.
//
// Exclusion rules (each has an owner):
//  - During a phase (isLayoutMotionActive): for drag and travel the existing system owns the movement.
//  - Hole elements (.hole): excluded **regardless of framework**. A slot holding a live content view does
//    not get its geometry interpolated — interpolation changes size and position every frame, and the page
//    cannot relayout and recomposite along with those frames. An out-of-document child cannot follow at
//    all, and an in-DOM guest (<webview> = OOPIF) follows but **leaves a stale surface**.
//
//    I attributed this exclusion wrongly once (2026-08-02): I treated it as a concern only of shells with a
//    child view layer and put it on that axis, and then an in-DOM guest left old pixels at the end of
//    interpolation — one browser row stayed at the boundary while its own pane was empty (user capture).
//    There were two reasons, and one of them is universal.
import { moduleState } from "./moduleState";
import { beginLayoutDecorationMotion } from "./layoutDecorationPresentation";
import { LAYOUT_MOTION_MS, layoutMotionFacts } from "./layoutMotion";
import {
  adoptLayoutAnimation,
  beginJourney,
  endJourney,
  motionDebugState,
  noteRectMotionSkip,
  onMotionDebugChange,
} from "./motionDebug";

interface Snap {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RectMotionTracker {
  /** Passed as ref inside the map render — registration only; flush collects dead elements through isConnected. */
  ref: (el: HTMLElement | null) => void;
  /** Once right after commit (useLayoutEffect) — compares against the previous rect and interpolates the delta. */
  /**
   * `replace` is the target DOM commit of a structural snap. The previous rect is not a starting point but
   * a structure to discard, so it is not interpolated and the new rect is adopted only as the baseline for
   * the next change.
   */
  flush: (mode?: "animate" | "replace") => void;
}

/**
 * **The framework attaches** the slots to exclude from interpolation.
 *
 * There is one reason to exclude: the surface under that slot **does not follow** the slot's `transform`.
 * That is true only in a framework where the content is outside the document — there the surface is in
 * another compositor and its coordinates must be written separately, and writing them on every
 * interpolation frame makes the surface fall behind and leave old pixels.
 *
 * When the content is inside the document that **cannot happen.** The surface is a child of the slot, and
 * an ancestor's `transform` is compositing, not relayout, so the guest rides along. Excluding anyway makes
 * that one pane arrive instantly on its own while its neighbors slide — the exclusion creates a defect
 * that did not exist.
 *
 * So the core does not hold the judgment. The side that attached it answers with its own reason (that
 * adapter's install).
 */
const exclusions = moduleState(
  "lib/layoutRectMotion#exclusions",
  () => new Set<(el: HTMLElement) => boolean>(),
);

export function registerRectMotionExclusion(fn: (el: HTMLElement) => boolean): () => void {
  exclusions.add(fn);
  return () => {
    exclusions.delete(fn);
  };
}

function excluded(el: HTMLElement): boolean {
  for (const fn of exclusions) if (fn(el)) return true;
  return false;
}

export function createRectMotionTracker(decorationScope = "global"): RectMotionTracker {
  const els = new Set<HTMLElement>();
  const prev = new WeakMap<HTMLElement, Snap>();
  // An OS window bounds change is a different event from a command-driven panel rearrangement.
  // FLIP-interpolating a commit whose viewport changed makes every pane and tab cancel and recreate its
  // animation on each resize event, and publish to the activity ledger as well. A live resize must reflow
  // to the new viewport immediately, so the whole flush is excluded from interpolation by comparing against
  // each tracker's last viewport. No dependence on framework events or vendor names.
  let viewport = { w: window.innerWidth, h: window.innerHeight };
  // One active interpolation per element — a new change cancels the previous one and starts from there.
  // Overlapping without a cancel leaves two animations alive at once, producing overlap and afterimages
  // (measured: user's screen), and taking the in-flight gBCR (an interpolated value) as prev contaminates
  // the starting point of the next FLIP too.
  const running = new WeakMap<HTMLElement, Animation>();
  // Whether the previous flush was flip-move (owned by the CSS rail travel) — used to skip settlement on the removal commit.
  const wasFlipMove = new WeakMap<HTMLElement, boolean>();
  // Freeze of a change born during hold — pinning through pause/currentTime loses to the browser's pending
  // commit timing (measured: 1 frame of progress despite the pin, 3/10).
  //
  // The pin is **two layers**. The inline style holds that frame (the effect of animate() only attaches at
  // the next frame's timeline update — with one layer, one frame leaks), and a fill:"forwards" animation
  // guards behind it (with the inline style alone, React's next commit rewrites the style object and erases
  // it). Both came from measurement — remove neither.
  //
  // On the release transition the inline styles are cleared and FLIP starts from there (hold release = travel start).
  const frozen = new Map<HTMLElement, { was: Snap; pin: Animation | null }>();
  const startFlip = (el: HTMLElement, was: Snap, now: Snap): void => {
    const dx = was.x - now.x;
    const dy = was.y - now.y;
    const dw = was.w - now.w;
    const dh = was.h - now.h;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(dw) < 0.5 && Math.abs(dh) < 0.5)
      return;
    const cs = getComputedStyle(el);
    const L = parseFloat(cs.left) || 0;
    const T = parseFloat(cs.top) || 0;
    const releaseDecoration = beginLayoutDecorationMotion(decorationScope);
    try {
      const a = el.animate(
        [
          {
            left: `${L + dx}px`,
            top: `${T + dy}px`,
            width: `${now.w + dw}px`,
            height: `${now.h + dh}px`,
          },
          { left: `${L}px`, top: `${T}px`, width: `${now.w}px`, height: `${now.h}px` },
        ],
        { duration: LAYOUT_MOTION_MS, easing: "ease" },
      );
      running.set(el, a);
      const j = beginJourney(el.dataset.node ?? el.className, was, now);
      const landRect = () => {
        const lr = el.getBoundingClientRect();
        return { x: lr.x, y: lr.y, w: lr.width, h: lr.height };
      };
      a.onfinish = () => {
        if (running.get(el) === a) running.delete(el);
        releaseDecoration();
        endJourney(j, "finish", landRect());
      };
      a.oncancel = () => {
        releaseDecoration();
        endJourney(j, "cancel", landRect());
      };
      adoptLayoutAnimation(a, el.dataset.node ?? el.className, LAYOUT_MOTION_MS);
    } catch {
      releaseDecoration();
      /* Environment without animation (test jsdom and the like) — the immediate application stands */
    }
  };
  // Hold release transition — clear the frozen state and start the travel from there.
  onMotionDebugChange(() => {
    if (motionDebugState().hold || frozen.size === 0) return;
    for (const [el, f] of [...frozen]) {
      frozen.delete(el);
      try {
        f.pin?.cancel();
      } catch {
        /* already gone */
      }
      // Clear the inline styles **first**. Left in place, the element's actual rect stays at the old value,
      // so the measurement below reads "did not move" and no travel starts — the hold becomes permanent.
      el.style.left = "";
      el.style.top = "";
      el.style.width = "";
      el.style.height = "";
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      startFlip(el, f.was, { x: r.x, y: r.y, w: r.width, h: r.height });
    }
  });
  return {
    ref: (el) => {
      if (el) els.add(el);
    },
    flush: (mode = "animate") => {
      const facts = layoutMotionFacts();
      const nextViewport = { w: window.innerWidth, h: window.innerHeight };
      const viewportReflow =
        nextViewport.w !== viewport.w || nextViewport.h !== viewport.h;
      viewport = nextViewport;
      // Precise condition for the phase skip — a blanket skip was the cause of the intermittent 1/50 instant
      // jump (measured: with another travel phase open at the moment of a resize, the FLIP of unrelated panes
      // was killed wholesale and they jumped instantly).
      //  · resize phase (drag): blanket skip — immediate following is the contract.
      //  · move phase: skip only the tab slots inside the scope (that movement is owned by the stand-in
      //    system — no double drive). Elements outside the scope and the pane family are interpolated. A
      //    global (scope null) move takes a conservative blanket skip.
      const skipAll =
        facts.active && (facts.kinds.includes("resize") || facts.scope === null);
      for (const el of els) {
        if (!el.isConnected) {
          els.delete(el);
          continue;
        }
        // Cancel the previous interpolation before measuring — cancel restores the style to its final value,
        // so the rect measured now is always "the layout's true present" (blocks contamination by
        // interpolated intermediate values).
        const prevAnim = running.get(el);
        if (prevAnim) {
          try {
            prevAnim.cancel();
          } catch {
            /* already finished */
          }
          running.delete(el);
        }
        const r = el.getBoundingClientRect();
        const now: Snap = { x: r.x, y: r.y, w: r.width, h: r.height };
        const was = prev.get(el);
        prev.set(el, now);
        if (mode === "replace") {
          const held = frozen.get(el);
          if (held) {
            frozen.delete(el);
            try {
              held.pin?.cancel();
            } catch {
              /* already gone */
            }
          }
          el.style.left = "";
          el.style.top = "";
          el.style.width = "";
          el.style.height = "";
          noteRectMotionSkip(el.dataset.node ?? el.className, "structural-replace");
          continue;
        }
        // A newly registered element has no previous rect to compare against. Visibility transitions are
        // split by ref registration and release, so only visible→visible layout changes reach this point.
        if (!was) continue;
        // Framework-attached exclusion — "the surface under this slot does not follow the slot's transform".
        // The core does not ask what got attached. With nothing attached, nothing is excluded.
        if (excluded(el)) {
          noteRectMotionSkip(el.dataset.node ?? el.className, "framework-excluded");
          continue;
        }
        // Movement owned by the rail travel (CSS rail-flip-x) is not interpolated — one movement, one motion.
        // On a commit with flip-move attached, CSS draws the travel, and the rect change on the removal
        // commit is that travel's real-coordinate settlement (measured ledger 2026-07-27: one click produced
        // a CSS travel, then 350ms later a JS FLIP journey for the same movement — the screen slid twice.
        // User measurement: "it moves twice").
        const fm = el.classList.contains("flip-move");
        const fmWas = wasFlipMove.get(el) === true;
        wasFlipMove.set(el, fm);
        if (fm || fmWas) {
          noteRectMotionSkip(el.dataset.node ?? el.className, "rail-flip-owned");
          continue;
        }
        const tabId = el.dataset.node?.startsWith("layout/tab/")
          ? el.dataset.node.slice("layout/tab/".length)
          : null;
        const skip =
          viewportReflow ||
          skipAll ||
          (facts.active && tabId !== null && (facts.scope?.has(tabId) ?? false));
        if (skip) {
          noteRectMotionSkip(
            el.dataset.node ?? el.className,
            viewportReflow ? "viewport-reflow" : facts.kinds.join("+") || "live",
          );
          continue;
        }
        const dxq = was.x - now.x;
        const dyq = was.y - now.y;
        const dwq = was.w - now.w;
        const dhq = was.h - now.h;
        if (
          Math.abs(dxq) < 0.5 &&
          Math.abs(dyq) < 0.5 &&
          Math.abs(dwq) < 0.5 &&
          Math.abs(dhq) < 0.5
        )
          continue;
        // A change during hold — the old rect is pinned with WAAPI fill:"forwards" (see the frozen preamble).
        // An inline style pin is erased by a later rewrite of the style object React owns (measured: the
        // held-frozen skip was recorded exactly, yet the rect jumped to the final value — the presence of a
        // later commit is what made it intermittent). A finished-fill animation is a layer above inline, so
        // a commit cannot erase it.
        if (motionDebugState().hold) {
          if (!frozen.has(el)) {
            const cs0 = getComputedStyle(el);
            const L0 = parseFloat(cs0.left) || 0;
            const T0 = parseFloat(cs0.top) || 0;
            // The inline style holds **this frame**. The effect of animate() only attaches at the next
            // frame's timeline update, so even when created before paint (useLayoutEffect) that frame
            // already has the new layout — one frame of flash remains during hold (measured: in the rect
            // time series [678.3 …] one sample alone was 290.7). The animation below guards **behind it**.
            el.style.left = `${L0 + dxq}px`;
            el.style.top = `${T0 + dyq}px`;
            el.style.width = `${now.w + dwq}px`;
            el.style.height = `${now.h + dhq}px`;
            let pin: Animation | null = null;
            try {
              pin = el.animate(
                [
                  {
                    left: `${L0 + dxq}px`,
                    top: `${T0 + dyq}px`,
                    width: `${now.w + dwq}px`,
                    height: `${now.h + dhq}px`,
                  },
                ],
                { duration: 1, fill: "forwards" },
              );
            } catch {
              /* Environment without animation — the single inline layer holds it */
            }
            // Registration is independent of whether the animation exists. Pinning the inline styles and
            // skipping registration makes release unable to find that element, and it stays pinned at the
            // old rect **permanently** — that is breakage, not a freeze.
            frozen.set(el, { was, pin });
          }
          noteRectMotionSkip(el.dataset.node ?? el.className, "held-frozen");
          continue;
        }
        // A keyframe list has two entries, start and end — a single keyframe is interpreted as `to` in WAAPI
        // and snaps back to the start value at the end (measured). The body is owned by startFlip (extracted above).
        startFlip(el, was, now);
      }
    },
  };
}
