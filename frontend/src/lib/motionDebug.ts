// Single owner of the motion observation settings — the command (ui.motion) and the dev UI use one state.
//
// Why it must be one: when a person stops motion in the UI to inspect the DOM right now, a
// difference between the value the command reads and the value the screen follows shows two
// different moments. These defects exist only while something is moving (a surface stranded at its
// old place leaving two sidebars, a flicker when a tab returns, a panel narrowing for an instant),
// so observation holds only when that stopped moment is exactly the same one.
//
// How it actually slows down: an already-declared duration cannot be multiplied through a CSS
// variable — a custom property alone stretches no transition (measured: the variable was set with
// no consumer, so hold worked and the multiplier did nothing). The axis that actually changes speed
// is the Web Animations playbackRate. It covers both CSS transitions and keyframe animations, and
// edits no declaration.
//
// Both what already runs and what starts next must be caught — transitionrun/animationstart are the
// only signal of a newly created animation. At the defaults (1x, no hold) the listeners touch nothing.
import { moduleState } from "./moduleState";
import { invoke } from "../framework";
import { presentationNowUnixUs } from "./presentationClock";

const listeners = moduleState("lib/motionDebug#listeners", () => new Set<() => void>());
export interface MotionDebugState {
  /** Duration multiplier — 1 = normal, 20 = twenty times slower. The screen shows it as speed (1/20). */
  scale: number;
  hold: boolean;
  /** Number of animations actually re-timed by the last apply (evidence of effect). */
  applied?: number;
}

// The three states are different things — in one bag it is a bag, not a state.
// Each stands with its own name and its own key (outside the hot-swap boundary — moduleState).

/** Debug knob — a person turns it. Its lifetime differs from the wiring and the meter. */
const knob = moduleState("lib/motionDebug#knob", () => ({
  scale: 1,
  hold: false,
}));

/** Wiring — whether it is attached. If only this disappears, the attaching side treats it as attached and does not attach again. */
const wiring = moduleState("lib/motionDebug#wiring", () => ({
  wired: false,
  swapObserver: null as MutationObserver | null,
  inputObserved: false,
}));

/** Meter — the values being measured. Turning the knob leaves this accumulation as it is. */
const meter = moduleState("lib/motionDebug#meter", () => ({
  births: 0,
  armedAt: null as number | null, // null = not measuring (0 is a valid timestamp)
  lagMs: 0,
}));
/** The schedules this module created. It does not rely on the browser list to include them and
 *  holds them directly — when that expectation breaks, hold does not apply to the schedule and
 *  the landing erases the frozen moment. */
// Outside the hot-swap boundary — if this table becomes new, the side that filled it treats it as filled and does not fill it again.
const scheduled = moduleState("lib/motionDebug#scheduled", () => new Set<Retimable>());
/** Diagnostic: how many times a newly created animation was caught. */
/** Identity of the recently created transitions — records as fact what "meter.births 43" actually
 *  was (observation surface). Records the rate at the moment of capture as well, so "caught it but
 *  the slowdown did not apply" can be distinguished. */
export interface BirthRecord {
  at: string; // element the transition started on (rough identification — tag.class)
  what: string; // transitionProperty | animationName
  declaredMs: number;
  rate: number; // playbackRate right after applyMotionTo — direct evidence the slowdown applied
  t: number; // performance.now() — separates which commit started it by time (#22 failure type 2)
  held: boolean; // knob.hold reading at start — direct evidence of a start while paused (freeze branch missed)
}
const RECENT_BIRTHS_CAP = 64;
const recentBirths: BirthRecord[] = [];
export function motionRecentBirths(): BirthRecord[] {
  return [...recentBirths];
}
/** Difference (ms) between the time the phase schedule started counting and the time the screen
 *  actually started moving. The glide is cut at the front by exactly this lag — the schedule is
 *  already counting while the screen has not moved yet. */

/**
 * The moment the screen actually starts moving — the real 0 of the phase clock.
 *
 * The schedule starts counting in a React effect, but the screen moves after the next style flush
 * and paint. When the phase runs ahead by that gap (measured 5~44ms normally, up to 13%), the
 * landing is declared with the tail of the glide cut off. Here the schedule is pushed back by that
 * lag so the two zeros match.
 */
function noteVisualStart(): void {
  if (meter.armedAt === null) return;
  meter.lagMs = Math.round(nowMs() - meter.armedAt);
  meter.armedAt = null; // counts only the first movement of this journey
  if (meter.lagMs > 0) deferBy(meter.lagMs);
}

/** Push a running phase schedule back by ms. This module owns the schedule, so the rewind sticks
 *  (a CSS animation owned by the style engine returns to its place after a rewind — measured). */
function deferBy(ms: number): void {
  for (const a of scheduled) {
    const t = a.currentTime;
    if (typeof t === "number") {
      try {
        a.currentTime = Math.max(0, t - ms);
      } catch {
        /* an implementation that refuses the rewind */
      }
    }
  }
  for (const w of [...waiting]) {
    clearTimeout(w.timer);
    const left = Math.max(0, w.wallMs - (nowMs() - w.startedAt)) + ms;
    w.startedAt = nowMs();
    w.wallMs = left;
    w.timer = setTimeout(() => {
      waiting.delete(w);
      w.cb();
    }, left) as unknown as number;
  }
}

function root(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.documentElement;
}

/** The minimal surface that actually holds playbackRate and hold — tests assert this rule directly. */
export interface Retimable {
  playbackRate: number;
  readonly playState: string;
  currentTime?: number | null;
  pause(): void;
  play(): void;
}

// ── Motion journey ledger (journeys) — the system records "from where to where, and did it finish"
// itself. User requirement (2026-07-27): once motion starts from an event, from→to and full
// completion must be traceable. External sampling (ui.trace) observes from outside the window; this
// ledger is the interpolation's own report — overlap (two journeys crossing paths) and afterimage
// (measurement after finish differs from to) are read as events.
export interface MotionJourney {
  at: string; // node (data-node)
  from: { x: number; y: number; w: number; h: number };
  to: { x: number; y: number; w: number; h: number };
  startedAt: number; // performance.now()
  endedAt: number | null; // null = still running
  end: "finish" | "cancel" | null;
  landed: { x: number; y: number; w: number; h: number } | null; // rect measured right after the end
}
const JOURNEYS_CAP = 64;
const journeys: MotionJourney[] = [];
const journeyAnimations = new WeakMap<MotionJourney, {
  animation: Pick<Animation, "playState" | "playbackRate">;
  declaredMs: number;
  landed: () => MotionJourney["landed"];
}>();

function sameJourneyRect(
  left: MotionJourney["landed"],
  right: MotionJourney["to"],
): boolean {
  return left !== null
    && Math.abs(left.x - right.x) < 0.5
    && Math.abs(left.y - right.y) < 0.5
    && Math.abs(left.w - right.w) < 0.5
    && Math.abs(left.h - right.h) < 0.5;
}
// The journey is published to the activity hub too — logs discriminate better than capture (pixels)
// (user decision 2026-07-27). `sok events --kinds motion.journey` streams start and end live.
// Failures are swallowed (observation cannot block the body — the same contract as boot.step).
function publishJourney(phase: "start" | "end", j: MotionJourney): void {
  void invoke("activity_publish", {
        kind: "motion.journey",
        source: "motion",
        payload: {
          phase,
          at: j.at,
          from: j.from,
          to: j.to,
          end: j.end,
          landed: j.landed,
          ms: j.endedAt !== null ? Math.round(j.endedAt - j.startedAt) : null,
          message: `· motion ${phase} ${j.at}`,
          origin: "internal",
        },
      }).catch(() => {});
}
export function motionJourneys(): MotionJourney[] {
  // WKWebView can expose the final Animation state to a finite background-window capture before
  // dispatching onfinish/oncancel. Reconcile that authoritative state once when the status is read;
  // this is not a timer or a retry, and keeps an already-finished journey from being reported as
  // incomplete solely because its callback is still queued.
  for (const journey of journeys) {
    if (journey.end !== null) continue;
    const probe = journeyAnimations.get(journey);
    if (!probe) continue;
    const landed = probe.landed();
    if (probe.animation.playState === "finished") {
      endJourney(journey, "finish", landed);
    } else if (probe.animation.playState === "idle") {
      const rate = Math.abs(probe.animation.playbackRate);
      const requiredMs = rate > 0 ? probe.declaredMs / rate : Number.POSITIVE_INFINITY;
      const elapsedMs = (typeof performance === "undefined" ? 0 : performance.now()) - journey.startedAt;
      endJourney(
        journey,
        elapsedMs >= requiredMs && sameJourneyRect(landed, journey.to) ? "finish" : "cancel",
        landed,
      );
    }
  }
  return [...journeys];
}

/** Connects the journey ledger to the public Web Animations state used to draw it. */
export function attachJourneyAnimation(
  journey: MotionJourney,
  animation: Pick<Animation, "playState" | "playbackRate">,
  declaredMs: number,
  landed: () => MotionJourney["landed"],
): void {
  journeyAnimations.set(journey, { animation, declaredMs, landed });
}
export function beginJourney(
  at: string,
  from: MotionJourney["from"],
  to: MotionJourney["to"],
): MotionJourney {
  const j: MotionJourney = {
    at,
    from,
    to,
    startedAt: typeof performance === "undefined" ? 0 : performance.now(),
    endedAt: null,
    end: null,
    landed: null,
  };
  journeys.push(j);
  if (journeys.length > JOURNEYS_CAP) journeys.shift();
  publishJourney("start", j);
  return j;
}
export function endJourney(
  j: MotionJourney,
  end: "finish" | "cancel",
  landed: MotionJourney["landed"],
): void {
  if (j.end !== null) return;
  j.endedAt = typeof performance === "undefined" ? 0 : performance.now();
  j.end = end;
  j.landed = landed;
  journeyAnimations.delete(j);
  publishJourney("end", j);
}

// ── Swap ledger (swaps) — records the execution fact of a swap (parking↔appearance) directly from
// DOM mutations. The journey ledger is the FLIP interpolation's own report — a parking transition
// is not interpolated (coordinate contract), so that axis has no observer. To catch the user
// measurement "a↔b swaps twice" (2026-07-27), the screen fact is what counts, whatever code path
// wrote the style — MutationObserver sees every inline style transition on the three layers where
// parking applies (workspace plane, space plane, tab slot), independent of the writer.
// A normal swap is exactly 2 tab-layer transitions (outgoing tab visible→parked, incoming tab parked→visible).
export interface SwapRecord {
  at: string; // layout/tab/<id> · workspace/<id> · space-plane
  kind: "park" | "restyle"; // park = parking axis switch, restyle = parking unchanged but another declaration changed
  from: string; // park: visible|parked, restyle: names of the changed declarations (summary)
  to: string;
  t: number; // performance.now()
}
const SWAPS_CAP = 128;
const swaps: SwapRecord[] = [];
export function motionSwaps(): SwapRecord[] {
  return [...swaps];
}
function publishSwap(s: SwapRecord): void {
  void invoke("activity_publish", {
    kind: "motion.swap",
    source: "motion",
    payload: {
      at: s.at,
      kind: s.kind,
      from: s.from,
      to: s.to,
      t: Math.round(s.t * 10) / 10,
      message: `· swap ${s.at} [${s.kind}] ${s.from}→${s.to}`,
      origin: "internal",
    },
  }).catch(() => {});
}
// The parking judgement reads the inline style directly (parkedStyle writes it inline) — computed
// returns false results from the flush lag (measured: still visible at the moment the parked
// coordinates are read — the visibility proxy misjudgement of #15).
const parkedInText = (style: string | null): boolean =>
  !!style && (/visibility:\s*hidden/.test(style) || /display:\s*none/.test(style));
const swapName = (el: HTMLElement): string | null => {
  const node = el.dataset.node;
  if (node && node.startsWith("layout/tab/")) return node;
  if (el.dataset.workspacePlane) return `workspace/${el.dataset.workspacePlane}`;
  if (el.classList.contains("space-plane")) return "space-plane";
  return null;
};
/** Install the swap watch — once at App mount (idempotent). Observation cannot block the body (publish failures are swallowed). */
export function installSwapObserver(): void {
  if (wiring.swapObserver || typeof MutationObserver === "undefined" || typeof document === "undefined")
    return;
  // Declaration text into name→value — summarizes "what changed" in a restyle event by name.
  const declsOf = (text: string): Map<string, string> => {
    const m = new Map<string, string>();
    for (const part of text.split(";")) {
      const i = part.indexOf(":");
      if (i > 0) m.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
    return m;
  };
  const record = (rec: SwapRecord) => {
    swaps.push(rec);
    if (swaps.length > SWAPS_CAP) swaps.shift();
    publishSwap(rec);
  };
  wiring.swapObserver = new MutationObserver((muts) => {
    // Batch reconstruction — the result of mutation i is the oldValue of mutation i+1. The current
    // el.style is the batch's final value, so reading it as the result of every mutation flattens the
    // intermediate round trips into the final state (the first version's misreading: all 4 mutations
    // of one batch looked like parked→visible).
    const byEl = new Map<HTMLElement, MutationRecord[]>();
    const t0 = typeof performance === "undefined" ? 0 : performance.now();
    for (const m of muts) {
      const el = m.target;
      if (!(el instanceof HTMLElement)) continue;
      const name = swapName(el);
      if (!name) continue;
      // class axis — attaching a class such as .flip-move fires a CSS keyframe (rail-flip-x). With the
      // style axis alone there is no observation of the cause of "slides twice" (class re-attach =
      // animation re-fire).
      if (m.attributeName === "class") {
        const oldCls = new Set((m.oldValue ?? "").split(/\s+/).filter(Boolean));
        const newCls = new Set(el.className.split(/\s+/).filter(Boolean));
        const delta: string[] = [];
        for (const c of newCls) if (!oldCls.has(c)) delta.push(`+${c}`);
        for (const c of oldCls) if (!newCls.has(c)) delta.push(`-${c}`);
        if (delta.length > 0)
          record({ at: name, kind: "restyle", from: "class", to: delta.join(" "), t: t0 });
        continue;
      }
      const list = byEl.get(el);
      if (list) list.push(m);
      else byEl.set(el, [m]);
    }
    const t = typeof performance === "undefined" ? 0 : performance.now();
    for (const [el, list] of byEl) {
      const at = swapName(el);
      if (!at) continue;
      const finalText = el.getAttribute("style") ?? "";
      for (let i = 0; i < list.length; i++) {
        const oldText = list[i].oldValue ?? "";
        const newText = i + 1 < list.length ? (list[i + 1].oldValue ?? "") : finalText;
        if (oldText === newText) continue;
        const was = parkedInText(oldText);
        const now = parkedInText(newText);
        if (was !== now) {
          record({ at, kind: "park", from: was ? "parked" : "visible", to: now ? "parked" : "visible", t });
          continue;
        }
        // Parking axis unchanged — which declaration changed (the substance of movement is transform and size rewrites).
        const a = declsOf(oldText);
        const b = declsOf(newText);
        // Trimming the prefix with a removal marker damages CSS variable names (--x) — use the key set honestly.
        const keys = new Set<string>([...a.keys(), ...b.keys()]);
        const changed = [...keys].filter((k) => a.get(k) !== b.get(k));
        if (changed.length === 0) continue;
        record({
          at,
          kind: "restyle",
          from: changed.map((k) => `${k}:${a.get(k) ?? "∅"}`).join(" "),
          to: changed.map((k) => `${k}:${b.get(k) ?? "∅"}`).join(" "),
          t,
        });
      }
    }
  });
  wiring.swapObserver.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "class"],
    attributeOldValue: true,
  });
}

// ── Trigger ledger (triggers) — records "how many times the event actually fired" on the cause axis.
// User hypothesis (2026-07-27): the swap may look doubled because activation fires twice (down/up
// double fire). The judgement point is the single owner of the state mutation
// (sessions.setActiveView/setActiveGroup) — every UI path funnels here, so a call-stack signature
// recorded per call shows how many times and through which path one gesture fired activation. The
// input layer (pointerdown/up/click) is recorded through document capture as well, putting
// gesture→fire→swap on one timeline.
export interface TriggerRecord {
  what: string; // setActiveView | setActiveGroup | pointerdown | pointerup | click
  target: string; // view/slot id, or the data-node of the input target
  via: string; // call-stack signature (state fire) or input coordinates
  t: number; // performance.now()
}
const TRIGGERS_CAP = 128;
const triggers: TriggerRecord[] = [];
export function motionTriggers(): TriggerRecord[] {
  return [...triggers];
}
function recordTrigger(rec: TriggerRecord): void {
  triggers.push(rec);
  if (triggers.length > TRIGGERS_CAP) triggers.shift();
  void invoke("activity_publish", {
    kind: "motion.trigger",
    source: "motion",
    payload: {
      what: rec.what,
      target: rec.target,
      via: rec.via,
      t: Math.round(rec.t * 10) / 10,
      message: `· trigger ${rec.what} ${rec.target}`,
      origin: "internal",
    },
  }).catch(() => {});
}
/** Record a state fire — called by the state action (the single owner point). The stack signature records the path. */
export function noteActivation(what: string, target: string): void {
  const stack = (new Error().stack ?? "")
    .split("\n")
    .slice(2, 7)
    .map((l) => l.trim().replace(/^at /, "").split(/[ @]/)[0])
    .filter((f) => f && !f.startsWith("http"))
    .join("<");
  recordTrigger({
    what,
    target,
    via: stack,
    t: typeof performance === "undefined" ? 0 : performance.now(),
  });
}
/** Input layer record — only pointerdown/up/click that touched a tab/pane surface (capture phase, no interference with the body). */
export function installInputObserver(): void {
  if (wiring.inputObserved || typeof document === "undefined") return;
  wiring.inputObserved = true;
  for (const type of ["pointerdown", "pointerup", "click"] as const) {
    document.addEventListener(
      type,
      (e) => {
        const el = e.target instanceof Element ? e.target.closest("[data-node],[data-tab-id],[data-pane]") : null;
        if (!(el instanceof HTMLElement)) return;
        const target =
          el.dataset.node ?? (el.dataset.tabId ? `tab:${el.dataset.tabId}` : `pane:${el.dataset.pane}`);
        recordTrigger({
          what: type,
          target,
          via: `${Math.round((e as MouseEvent).clientX)},${Math.round((e as MouseEvent).clientY)}`,
          t: typeof performance === "undefined" ? 0 : performance.now(),
        });
      },
      { capture: true, passive: true },
    );
  }
}

/** Phase skip fact — left in the ledger so the cause of "the slowdown did not apply" is measurable (#15 investigation). */
export function noteRectMotionSkip(at: string, why: string): void {
  recentBirths.push({
    at,
    what: `layout-rect-skipped(${why})`,
    declaredMs: 0,
    rate: 1,
    t: typeof performance === "undefined" ? 0 : performance.now(),
    held: knob.hold,
  });
  if (recentBirths.length > RECENT_BIRTHS_CAP) recentBirths.shift();
}

/** Registration point for JS-owned layout interpolation (what the core created with element.animate)
 *  — a WAAPI animation does not fire animationstart, so the onStart wiring does not catch it
 *  (measured: meter.births 0). The creator must adopt it so it follows the same controller
 *  (multiplier, hold, ledger) without exception. */
export function adoptLayoutAnimation(a: Animation, at: string, declaredMs: number): void {
  meter.births++;
  recentBirths.push({
    at,
    what: "layout-rect",
    declaredMs,
    rate: motionPlaybackRate(),
    t: typeof performance === "undefined" ? 0 : performance.now(),
    held: knob.hold,
  });
  if (recentBirths.length > RECENT_BIRTHS_CAP) recentBirths.shift();
  applyMotionTo(a as unknown as Retimable);
  // A creation during hold is frozen at 0 — pause() is a pending commit, so if the browser commits
  // play first on the first frame, one frame leaks (measured: during hold the rect advanced exactly
  // 1 frame then froze, 1 run in 3). A creation is by definition before progress, so pinning
  // currentTime=0 is correct — the frozen position of an already-running animation (applyMotionTo)
  // is not touched.
  if (motionDebugState().hold) {
    try {
      a.currentTime = 0;
    } catch {
      /* already finished or detached — harmless */
    }
    // Setting currentTime during a pending pause can be ignored by WebKit (measured: frozen at 1
    // frame (≈17ms, ease 20%) despite the pin above). Re-pin 0 at ready (commit complete) —
    // regardless of commit order, 0 wins in the end. If knob.hold was released in between, nothing
    // is touched.
    void (a as { ready?: Promise<unknown> }).ready
      ?.then(() => {
        if (motionDebugState().hold) {
          try {
            a.currentTime = 0;
          } catch {
            /* harmless */
          }
        }
      })
      .catch(() => {});
  }
}

/** Apply the current settings to this one animation. Idempotent — the browser ignores an identical value. */
export function applyMotionTo(a: Retimable): void {
  try {
    a.playbackRate = motionPlaybackRate();
    if (knob.hold) a.pause();
    else if (a.playState === "paused") a.play();
  } catch {
    /* an already finished or detached animation — harmless */
  }
}

/** Apply to every animation alive right now, and answer how many it applied to.
 *  The count is the evidence of effect — "the setting is in place" does not substitute for "it slowed down". */
function applyAll(): number {
  const d = typeof document === "undefined" ? null : document;
  const live = new Set<Retimable>(scheduled);
  if (d?.getAnimations) for (const a of d.getAnimations()) live.add(a as unknown as Retimable);
  for (const a of live) applyMotionTo(a);
  return live.size;
}

/** Make a newly starting transition/animation be created with the same settings. Wired once. */
function ensureWired(): void {
  if (wiring.wired || typeof document === "undefined") return;
  wiring.wired = true;
  const onStart = (e: Event) => {
    noteVisualStart(); // the only thing measured even at rest — the lag between the phase clock and the screen
    if (knob.scale === 1 && !knob.hold) return; // default values — nothing else is touched
    const t = e.target;
    if (!(t instanceof Element) || !t.getAnimations) return;
    for (const a of t.getAnimations()) {
      meter.births++;
      applyMotionTo(a as unknown as Retimable);
      const el = t as HTMLElement;
      const eff = (a as Animation).effect as KeyframeEffect | null;
      const timing = eff?.getTiming?.();
      recentBirths.push({
        at: `${el.tagName?.toLowerCase() ?? "?"}${el.className ? "." + String(el.className).split(" ").slice(0, 2).join(".") : ""}`,
        what:
          (a as unknown as { transitionProperty?: string }).transitionProperty ??
          (a as unknown as { animationName?: string }).animationName ??
          (a as Animation).id ??
          "?",
        declaredMs: typeof timing?.duration === "number" ? timing.duration : -1,
        rate: (a as Animation).playbackRate ?? 1,
        t: typeof performance === "undefined" ? 0 : performance.now(),
        held: knob.hold,
      });
      if (recentBirths.length > RECENT_BIRTHS_CAP) recentBirths.shift();
    }
  };
  document.addEventListener("transitionrun", onStart, true);
  document.addEventListener("animationstart", onStart, true);
}

/** The number of animations alive right now and their actual playback rate — direct evidence of effect.
 *  The setting (knob.scale) is the intent, this is the result. Both together confirm "it slowed down". */
export function motionLiveRates(): {
  running: number;
  births: number;
  lagMs: number;
  rates: number[];
  wallMs: number[];
} {
  const d = typeof document === "undefined" ? null : document;
  if (!d?.getAnimations) return { running: 0, births: meter.births, lagMs: meter.lagMs, rates: [], wallMs: [] };
  const rates = new Set<number>();
  const wall = new Set<number>();
  let running = 0;
  for (const a of d.getAnimations()) {
    running++;
    const rate = a.playbackRate ?? 1;
    rates.add(Number(rate.toFixed(4)));
    wall.add(effectiveWallMs(a as unknown as Timed, rate));
  }
  return {
    running,
    births: meter.births,
    lagMs: meter.lagMs,
    rates: [...rates].sort((x, y) => x - y),
    wallMs: [...wall].filter((n) => n > 0).sort((x, y) => x - y),
  };
}

/** One running animation — name, place, length, progress. The count alone does not show what went wrong. */
export interface LiveAnimation {
  /** Nearest exposed node address + own class. The answer to "what part is moving". */
  at: string;
  /** Keyframe name or transition property. The answer to "what is moving". */
  what: string;
  /** Declared length. Do not multiply the multiplier into it — playbackRate is the only stretching axis. */
  declaredMs: number;
  /** The time the screen actually uses (declared / playback rate). The phase timer and this number must match or it jumps. */
  wallMs: number;
  /** 0..1 — where in the journey the stopped moment is. */
  progress: number;
  state: string;
}

/** List of what is running. Reading it while held leaves that instant as coordinates. */
export function motionLiveList(limit = 24): LiveAnimation[] {
  const d = typeof document === "undefined" ? null : document;
  if (!d?.getAnimations) return [];
  const out: LiveAnimation[] = [];
  for (const a of d.getAnimations()) {
    if (out.length >= limit) break;
    const rate = a.playbackRate ?? 1;
    const eff = a.effect as (KeyframeEffect & { target?: Element | null }) | null;
    const timing = eff?.getComputedTiming?.();
    const dur = typeof timing?.duration === "number" ? timing.duration : 0;
    const anim = a as unknown as { animationName?: string; transitionProperty?: string };
    out.push({
      at: describeTarget(eff?.target ?? null),
      what: a.id || anim.animationName || anim.transitionProperty || "?",
      declaredMs: Math.round(dur),
      wallMs: effectiveWallMs(a as unknown as Timed, rate),
      progress: Number((timing?.progress ?? 0).toFixed(3)),
      state: a.playState,
    });
  }
  return out;
}

/** The place an animation is attached to, as a readable address — nearest exposed node + own class. */
function describeTarget(el: Element | null): string {
  if (!el) return "?";
  const own = el.classList.length ? `.${[...el.classList].join(".")}` : el.tagName.toLowerCase();
  const host = el.closest("[data-node]");
  const addr = host?.getAttribute("data-node");
  return addr ? `${addr} ${own}` : own;
}

interface Timed {
  effect?: { getComputedTiming?: () => { duration?: number | string } } | null;
}

/** The declared length divided by playback rate = the actual duration — the phase timer and this
 *  number must match or it jumps. Multiplying the declaration by the multiplier and dividing by
 *  playbackRate again makes this number diverge quadratically (a real incident). */
function effectiveWallMs(a: Timed, rate: number): number {
  const dur = a.effect?.getComputedTiming?.().duration;
  if (typeof dur !== "number" || !Number.isFinite(dur) || rate <= 0) return 0;
  return Math.round(dur / rate);
}

/** Current duration multiplier — a consumer running its own clock (the phase timer) multiplies by it. */
export function motionScale(): number {
  return knob.scale;
}

/** The playback rate applied to the declared length. This is the only stretching axis — CSS
 *  declarations stay at their bare length. Multiplying the declaration as well makes only the screen
 *  late by the square of the multiplier while a timer on its own clock multiplies once, so the phase
 *  closes mid-movement and it jumps. railMotion's test checks the pair through this function. */
export function motionPlaybackRate(): number {
  return 1 / knob.scale;
}

export function motionDebugState(): MotionDebugState {
  return { scale: knob.scale, hold: knob.hold };
}

/** Apply the multiplier and hold. Both optional — only what is given changes. An out-of-range multiplier is filtered by the caller. */
export function setMotionDebug(next: { scale?: number; hold?: boolean }): MotionDebugState {
  ensureWired();
  if (typeof next.scale === "number" && next.scale > 0 && next.scale <= 200) knob.scale = next.scale;
  if (typeof next.hold === "boolean") knob.hold = next.hold;
  const r = root();
  if (r) {
    // State surface — ui.snapshot.dom and screenshots read "what the setting is now" off the screen.
    r.style.setProperty("--motion-knob.scale", String(knob.scale));
    r.toggleAttribute("data-motion-knob.hold", knob.hold);
  }
  adoptWaiting();
  const applied = applyAll();
  for (const cb of listeners) cb();
  return { ...motionDebugState(), applied };
}

/**
 * The clock that closes the phase is created here too — setTimeout does not follow this controller.
 *
 * RED evidence (user measurement, 2026-07-26): pressing hold did not stop it. playbackRate and pause
 * catch only animations on the document timeline, while the phase landing was counted by setTimeout.
 * The screen was frozen while the timer kept counting, then declared the landing and erased that
 * frozen moment. The multiplier had the same illness — only one side stretched, so the phase closed
 * mid-movement.
 *
 * So there is one clock: this schedule is an animation on the document timeline too. Then the
 * multiplier and hold both apply without exception, and the caller does not multiply the multiplier
 * (multiplying would double it).
 */
export function scheduleMotion(ms: number, cb: () => void): () => void {
  // The first movement of the screen is needed to set the clock's 0 — wired regardless of the observation settings.
  ensureWired();
  const slot: Slot = { stop: () => {} };
  arm(slot, ms, cb);
  return () => slot.stop();
}

/**
 * Close a motion phase from the same absolute epoch used by DOM and native adapters.
 * The lead-in is wall-clock scheduling, not part of the animation duration: playback-rate
 * debugging may stretch the motion itself, but must never multiply the agreed future epoch.
 */
export function scheduleMotionAtUnixUs(
  startAtUnixUs: number,
  durationMs: number,
  cb: () => void,
): () => void {
  let cancelled = false;
  let cancelMotion: (() => void) | null = null;
  const begin = () => {
    if (cancelled) return;
    cancelMotion = scheduleMotion(durationMs, cb);
  };
  const leadMs = Math.max(0, (startAtUnixUs - presentationNowUnixUs()) / 1_000);
  if (leadMs === 0) {
    begin();
    return () => {
      cancelled = true;
      cancelMotion?.();
    };
  }
  const timer = setTimeout(begin, leadMs);
  return () => {
    cancelled = true;
    clearTimeout(timer);
    cancelMotion?.();
  };
}

/** Is observation on — at the defaults nothing is observed. */
function observing(): boolean {
  return knob.scale !== 1 || knob.hold;
}

interface Slot {
  stop: () => void;
}

/** Schedules not placed on the timeline. The moment observation turns on, the remainder moves onto the timeline. */
interface Waiting {
  slot: Slot;
  cb: () => void;
  total: number;
  wallMs: number;
  startedAt: number;
  timer: number;
}

// Outside the hot-swap boundary — if this table becomes new, the side that filled it treats it as filled and does not fill it again.
const waiting = moduleState("lib/motionDebug#waiting", () => new Set<Waiting>());
function nowMs(): number {
  return typeof performance === "undefined" ? 0 : performance.now();
}

function arm(slot: Slot, ms: number, cb: () => void): void {
  if (observing() && armOnTimeline(slot, ms, cb)) return;
  armOnTimer(slot, ms, ms * knob.scale, cb);
}

/** An empty animation on the document timeline — the multiplier and hold apply exactly as on the screen. */
function armOnTimeline(slot: Slot, ms: number, cb: () => void): boolean {
  const d = typeof document === "undefined" ? null : document;
  if (!d?.timeline || !d.documentElement) return false;
  if (typeof Animation !== "function" || typeof KeyframeEffect !== "function") return false;
  const a = new Animation(new KeyframeEffect(d.documentElement, [], { duration: ms }), d.timeline);
  a.id = "phase"; // this schedule appears under that name in the ui.motion list
  meter.armedAt = nowMs();
  const held = a as unknown as Retimable;
  a.onfinish = () => {
    scheduled.delete(held);
    cb();
  };
  a.play();
  scheduled.add(held);
  applyMotionTo(held);
  slot.stop = () => {
    a.onfinish = null;
    scheduled.delete(held);
    try {
      a.cancel();
    } catch {
      /* already finished */
    }
  };
  return true;
}

/** Normal path — the same timer as before.
 *
 *  Why the timeline is not used normally: when a window is occluded the browser suspends animations.
 *  Putting the landing there too leaves an occluded window's phase never closed, stranding the layout
 *  in journey state. An observation tool that changes production behavior is a defect, not a tool —
 *  at the defaults not one line differs. */
function armOnTimer(slot: Slot, total: number, wallMs: number, cb: () => void): void {
  meter.armedAt = nowMs();
  const w: Waiting = {
    slot,
    cb,
    total,
    wallMs,
    startedAt: nowMs(),
    timer: setTimeout(() => {
      waiting.delete(w);
      cb();
    }, wallMs) as unknown as number,
  };
  waiting.add(w);
  slot.stop = () => {
    waiting.delete(w);
    clearTimeout(w.timer);
  };
}

/** The moment observation turns on, an already-running timer schedule moves onto the timeline with
 *  its remaining time. Without this handover, a hold pressed mid-movement does not apply to that
 *  movement — a person always stops mid-movement, so that case is all of them. */
function adoptWaiting(): void {
  if (!observing() || waiting.size === 0) return;
  for (const w of [...waiting]) {
    clearTimeout(w.timer);
    waiting.delete(w);
    const left = w.wallMs > 0 ? Math.max(0, w.wallMs - (nowMs() - w.startedAt)) : 0;
    arm(w.slot, w.total * (w.wallMs > 0 ? left / w.wallMs : 0), w.cb);
  }
}

/** Subscribe to setting changes — the dev UI matches its own display. */
export function onMotionDebugChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

export function __resetMotionDebugForTest(): void {
  knob.scale = 1;
  knob.hold = false;
  scheduled.clear();
  for (const w of [...waiting]) clearTimeout(w.timer);
  waiting.clear();
}
