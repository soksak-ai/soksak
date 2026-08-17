// Every frame, not every other one.
//
// A reading taken through the control plane costs a round trip — 15 to 25ms on this machine — and a
// frame is 16.7ms. So a page that is behind its pane for one or two frames lands in one sample or
// two depending on where the frames fall between them, and a person watching the screen sees
// something the reading cannot state. The person was right and the instrument was coarse.
//
// This records inside the window instead: once per animation frame, before the paint, the document
// half of the alignment — every declared surface's box, every region, every pane. The native half is
// the answer to the last commit, which already holds the applied rectangles, so no round trip is
// made for it and the recorder does not slow the window it watches. Each frame writes down how old
// that answer is, which is the pipeline's latency rather than the instrument's. Nothing here judges
// anything; it writes down what each frame held, and whoever reads it does the judging.
import { lastAppliedSurfaces } from "./contentViews";
import { alignmentOf, documentAlignment, type LayoutAlignment } from "./layoutAlignment";
import { mainThreadCosts, sinceCommitMs } from "./mainThreadCost";
import { moduleState } from "./moduleState";
import { presentationNowUnixMs } from "./presentationClock";

/** One frame of the trace. */
export interface LayoutTraceFrame {
  /** Frames since the trace started — the unit a verdict about motion is counted in. */
  frame: number;
  /** When the document half was read, on the presentation clock. */
  atUnixMs: number;
  /** How old the native half is, in milliseconds: the time since the commit that carried it was
   *  answered. Not an artefact of the reading — no round trip is made for it — but the pipeline's
   *  own latency, which is the number a verdict about "do they move together" is made of. */
  appliedAgeMs: number;
  /** Which clock recorded this reading: the window's frame clock, or the timer that keeps the
   *  recording honest when the window is not drawing. Only the first kind can carry a verdict about
   *  motion — the second measures the recorder. */
  drawn: boolean;
  /** How long since the frame before it. A window drawing at 60Hz answers about 17; a window whose
   *  main thread is busy laying out an animation answers more, and then nothing on the screen is
   *  moving at the rate it was asked to. */
  sinceLastMs: number;
  /** How long before this reading the last render committed. A frame that arrives 100ms after the
   *  commit spent that time in the engine — style, layout, paint — and no timer inside a component
   *  can see it. */
  sinceCommitMs: number;
  /** What this recording cost the frame it was taken in. A watcher that is itself the stall would
   *  report a window that is only slow while it is watched. */
  tickMs: number;
  /** Commits answered since the trace started. One per frame means a round trip per frame. */
  commits: number;
  /** What each path this application owns last cost on the main thread. Whatever the frame gaps
   *  hold that these do not account for is the engine's own render and paint. */
  costs: Record<string, number>;
  /** What the native layer itself held that commit for. Everything between this and `commitMs` is
   *  the bridge and a thread that was busy with something else. */
  appliedMs: number;
  /** What the commit that carried the native half cost, from the rectangles being measured to the
   *  native layer answering. A page cannot be closer to its pane than this. */
  commitMs: number;
  /** How long that commit took to reach the backend. -1 before the first stamped receipt. */
  carriedMs: number;
  regions: LayoutAlignment["regions"];
  panes: LayoutAlignment["panes"];
  frames: LayoutAlignment["frames"];
  boundaries: LayoutAlignment["boundaries"];
  surfaces: LayoutAlignment["surfaces"];
  worstOff: number;
  worstLag: number;
  worstDrift: number;
  worstOver: number;
}

/** How long a trace may run. A recorder left on writes a frame every 16ms forever. */
const TRACE_LIMIT_MS = 10_000;

/** How many frames are kept. Ten seconds at 60Hz, and the oldest go first. */
const TRACE_LIMIT_FRAMES = 600;

interface TraceState {
  frames: LayoutTraceFrame[];
  running: boolean;
  startedAtUnixMs: number;
  stopAtUnixMs: number;
  /** The frame clock and the wall clock, both scheduled. Whichever comes first records. */
  handle: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  frame: number;
}

const trace = moduleState<TraceState>("lib/layoutTrace#state", () => ({
  frames: [],
  running: false,
  startedAtUnixMs: 0,
  stopAtUnixMs: 0,
  handle: null,
  timer: null,
  frame: 0,
}));

// How long the recorder waits for a frame before recording on the wall clock instead.
//
// A window the system has stopped drawing produces no animation frame at all, and a recorder that
// only listens for those writes down nothing and reports a still window as untested — measured
// 2026-08-17, one run in four. The frame clock is the right one while the window is drawing; the
// timer is what keeps the recording honest when it is not, and every reading states the gap it was
// taken after.
const WALL_CLOCK_MS = 12;

// Each clock re-arms only itself.
//
// Re-arming both from either cancelled whichever frame callback was already pending, and the
// 12ms timer beats a 16.7ms frame every time — so the timer kept killing the frame clock and
// the recording said the window had stopped drawing while it was drawing normally. Measured
// 2026-08-17: three of six focus moves reported 50 to 136ms stalls in which the timer answered
// every 13 to 17ms, our own paths cost under 5ms, and no commit went out. That gap was this
// function.
const scheduleFrame = (): void => {
  trace.handle = requestAnimationFrame(() => tick(true));
};

const scheduleTimer = (): void => {
  trace.timer = setTimeout(() => tick(false), WALL_CLOCK_MS);
};

// Both clocks, for a recording that is starting.
const schedule = (): void => {
  if (trace.handle !== null) cancelAnimationFrame(trace.handle);
  if (trace.timer !== null) clearTimeout(trace.timer);
  scheduleFrame();
  scheduleTimer();
};

/** How long a start waits for the window to draw its first frame before refusing. */
const FIRST_FRAME_LIMIT_MS = 1_000;

/**
 * Starts a trace, discarding whatever the last one held.
 *
 * The answer waits for the first recorded frame. A window the system has stopped drawing — covered
 * by another, occlusion detection still on — records nothing at all, and a start that answered
 * anyway left the caller holding an empty trace with no reason in it. Measured 2026-08-17: the same
 * gate wrote down 85 readings in one run and none in the next.
 */
export async function startLayoutTrace(ms: number): Promise<{ ms: number; frames: number }> {
  stopLayoutTrace();
  const limited = Math.max(1, Math.min(TRACE_LIMIT_MS, Math.round(ms)));
  trace.frames = [];
  trace.running = true;
  trace.frame = 0;
  trace.startedAtUnixMs = presentationNowUnixMs();
  trace.stopAtUnixMs = trace.startedAtUnixMs + limited;
  schedule();
  const until = Date.now() + Math.min(FIRST_FRAME_LIMIT_MS, limited);
  while (trace.frames.length === 0 && Date.now() < until) {
    await new Promise((done) => setTimeout(done, 8));
  }
  if (trace.frames.length === 0) {
    stopLayoutTrace();
    throw new Error(
      `this window recorded nothing in ${FIRST_FRAME_LIMIT_MS}ms: neither its frame clock nor a ` +
        `${WALL_CLOCK_MS}ms timer ran, which is a window that is not running`,
    );
  }
  return { ms: limited, frames: trace.frames.length };
}

/** Stops a running trace and keeps what it recorded. */
export function stopLayoutTrace(): void {
  if (trace.handle !== null) cancelAnimationFrame(trace.handle);
  if (trace.timer !== null) clearTimeout(trace.timer);
  trace.handle = null;
  trace.timer = null;
  trace.running = false;
}

/** What the trace holds. */
export function layoutTrace(): {
  running: boolean;
  startedAtUnixMs: number;
  frames: LayoutTraceFrame[];
} {
  return {
    running: trace.running,
    startedAtUnixMs: trace.startedAtUnixMs,
    frames: trace.frames,
  };
}

function tick(drawn: boolean): void {
  if (!trace.running) return;
  const atUnixMs = presentationNowUnixMs();
  // Both clocks are scheduled and either may arrive first. A second reading in the same breath as
  // the last one measures nothing and doubles the record — so the timer's is dropped. The frame's
  // never is: whether the window drew is the verdict, and a frame thrown away for landing beside a
  // timer reading is a gap this recording invented.
  const last = trace.frames[trace.frames.length - 1];
  if (!drawn && last && atUnixMs - last.atUnixMs < 4) {
    // Re-armed on the clock that fired, so a dropped reading costs that clock nothing.
    scheduleTimer();
    return;
  }
  // The document half, inside the frame callback and before the paint: this is the geometry the
  // frame about to be drawn holds, interpolations included. The native half is whatever the last
  // commit was answered with — no round trip, so nothing here slows the window it is watching.
  const applied = lastAppliedSurfaces();
  const previous = trace.frames[trace.frames.length - 1];
  const alignment = alignmentOf(documentAlignment(), applied.surfaces);
  trace.frames.push({
    frame: trace.frame,
    atUnixMs,
    drawn,
    sinceLastMs: previous ? Math.round(atUnixMs - previous.atUnixMs) : 0,
    sinceCommitMs: sinceCommitMs(performance.now()),
    tickMs: 0,
    commits: applied.commits,
    costs: mainThreadCosts(),
    appliedAgeMs: applied.atUnixMs === 0 ? -1 : Math.round(atUnixMs - applied.atUnixMs),
    commitMs: Math.round(applied.latencyMs),
    carriedMs: Math.round(applied.carriedMs),
    appliedMs: Math.round(applied.appliedMs * 10) / 10,
    regions: alignment.regions,
    panes: alignment.panes,
    frames: alignment.frames,
    boundaries: alignment.boundaries,
    surfaces: alignment.surfaces,
    worstOff: alignment.worstOff,
    worstLag: alignment.worstLag,
    worstDrift: alignment.worstDrift,
    worstOver: alignment.worstOver,
  });
  if (trace.frames.length > TRACE_LIMIT_FRAMES) trace.frames.shift();

  trace.frames[trace.frames.length - 1].tickMs =
    Math.round((presentationNowUnixMs() - atUnixMs) * 100) / 100;
  trace.frame += 1;
  if (atUnixMs >= trace.stopAtUnixMs) {
    stopLayoutTrace();
    return;
  }
  if (drawn) scheduleFrame(); else scheduleTimer();
}
