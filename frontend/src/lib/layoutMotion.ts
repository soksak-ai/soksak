// Layout motion signal (single truth) — publishes the fact "a native child surface is moving"
// as an edge to three consumer layers: (1) plugin events (layout.resize-gesture) (2) the selected
// framework's native placement transition
// (3) core local listeners (onLayoutMotion — DOM-side followers such as rail-hole clipping).
// Divider drag, rail travel, and FLIP can overlap, so a refcount pairs each start with its end.
// Basis (measured): during a travel animation the DOM slides but the child jumps at the end (video).
//
// kind axis — the payload holds the phase kind so consumers branch on it:
//   move   = surface size stays, only position glides (rail travel, FLIP swap, station drag).
//            Tauri passes the same final frame, duration, and curve to AppKit once.
//   resize = surface size changes every frame (divider, width drag). The core publishes this fact only.
//            DOM children resize with the parent; compositing policy for out-of-document surfaces
//            is the adapter's (Tauri settles bounds on events, Electron does nothing extra).
// Payload { active, kinds }: kinds = the kinds active at that moment. When the kind set changes
// while active, active:true is emitted again — consumers re-evaluate (e.g. a divider joins mid-travel).
import { moduleState } from "../lib/moduleState";
import { emitPluginEvent } from "../plugins/hooks";

export type LayoutMotionKind = "move" | "resize";

const counts: Record<LayoutMotionKind, number> = { move: 0, resize: 0 };
// Scope of the in-flight phases (viewId set) — a null element = global (all slots move: rail
// travel etc). Consumers transition only the surfaces in the union. Unrelated surfaces get no
// native frame command from someone else's swap and stay put for the whole phase.
const scopes: (Set<string> | null)[] = [];

// Combined scope — global if any element is global (null). Otherwise the viewId union.
function activeScope(): Set<string> | null {
  if (scopes.some((s) => s === null)) return null;
  const u = new Set<string>();
  for (const s of scopes) for (const v of s ?? []) u.add(v);
  return u;
}
// Outside the hot-swap boundary — when these values are replaced, the "already done" record and
// the lazy-init and unsubscribe slots go with them, and the filling side does not fill again.
/** Duplicate-emit suppression — the last emitted state (active+kinds). */
const emitted = moduleState("lib/layoutMotion#emitted", () => ({
  lastEmittedKey: null as string | null,
}));
type MotionListener = (
  active: boolean,
  kinds: LayoutMotionKind[],
  scope: Set<string> | null,
) => void;
// Outside the hot-swap boundary — when this table is replaced, the filling side treats it as
// already filled and does not fill again.
const listeners = moduleState("lib/layoutMotion#listeners", () => new Set<MotionListener>());
/** Subscribe to motion edges (start/end). Call the returned function to unsubscribe. */
export function onLayoutMotion(listener: MotionListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function depth(): number {
  return counts.move + counts.resize;
}

function activeKinds(): LayoutMotionKind[] {
  const kinds: LayoutMotionKind[] = [];
  if (counts.move > 0) kinds.push("move");
  if (counts.resize > 0) kinds.push("resize");
  return kinds;
}

// Emit on edges and on kind changes — local listeners fire on active edges (existing contract),
// and the plugin channel also receives kind-set changes (active:true re-emit — the basis for
// adapter re-evaluation).
/** Interpolation length for command-driven layout changes (split, maximize, close, ratio) — the
 *  single source for JS-owned interpolation (layoutRectMotion). During a phase (drag, glide) the
 *  existing system owns the movement, so nothing is interpolated (this same module resolves via
 *  isLayoutMotionActive). */
export const LAYOUT_MOTION_MS = 160;

function syncEmit(): void {
  const active = depth() > 0;
  const kinds = activeKinds();
  const scopeViews = activeScope();
  // Selection is a property of the shared resize phase, not of whichever handle happened to open
  // it. Publishing it on the root makes the status observable and keeps overlapping resize owners
  // locked until the final matching end.
  if (typeof document !== "undefined") {
    if (counts.resize > 0) document.documentElement.dataset.layoutResizing = "true";
    else delete document.documentElement.dataset.layoutResizing;
  }
  // The suppression key includes the scope — a different scope is a different fact. Without the
  // scope in the key, when scoped phases start back to back the second notification is swallowed
  // and the surface that actually moves is never notified of its phase (observed incident).
  const key = `${active}:${kinds.join(",")}:${scopeViews ? [...scopeViews].sort().join("+") : "*"}`;
  if (key === emitted.lastEmittedKey) return;
  emitted.lastEmittedKey = key;

  // The plugin channel emits only the common facts (active, kinds). For surface scope, the
  // framework-internal subscriber matches the public DOM address against scope.
  emitPluginEvent("layout.resize-gesture", { active, kinds });
  // No native relay here — only a framework with out-of-document surfaces needs one, and that
  // framework hooks itself in through the local listener below (that adapter's install).
  // Local listeners: called on edges (existing contract) and on kind changes while active — the
  // core consumer (native placement) must re-evaluate kinds and scope, so it is called under the
  // same condition as the plugin channel.
  for (const l of listeners) l(active, kinds, scopeViews);
}

/** Whether a motion phase is active (refcount > 0). */
export function isLayoutMotionActive(): boolean {
  return depth() > 0;
}

/** Facts about the current phase — used to decide whether JS interpolation (layoutRectMotion)
 *  is skipped. kinds = the active kinds, scope = the viewId set this phase moves (null = global). */
export function layoutMotionFacts(): { active: boolean; kinds: LayoutMotionKind[]; scope: Set<string> | null } {
  return { active: depth() > 0, kinds: activeKinds(), scope: activeScope() };
}

/** scope: viewId of the views this phase moves. Omitted (undefined) = global (all slots move).
 *  sender: sender id (diagnostics) — names which begin opened a global phase by mistake. */
export function beginLayoutMotion(
  kind: LayoutMotionKind,
  scope?: Iterable<string>,
  sender?: string,
): void {
  counts[kind] += 1;
  scopes.push(scope ? new Set(scope) : null);
  if (import.meta.env?.DEV && !scope && sender) lastSender.lastGlobalSender = sender;
  syncEmit();
}

// Sender of the last global begin (diagnostic observation surface) — exposed as
// window.__lastGlobalMotionSender.
// Outside the hot-swap boundary — when these values are replaced, the "already done" record and
// the lazy init go with them, and the filling side does not fill again.
/** Observation surface — the last sender (read by the debug window). Different lifetime and
 *  different meaning from emit suppression. */
const lastSender = moduleState("lib/layoutMotion#sender", () => ({
  lastGlobalSender: "",
}));
if (typeof window !== "undefined") {
  Object.defineProperty(window, "__lastGlobalMotionSender", {
    get: () => lastSender.lastGlobalSender,
    configurable: true,
  });
}

export function endLayoutMotion(kind: LayoutMotionKind): void {
  if (counts[kind] === 0) return; // Ignore a surplus end — the count never goes negative
  counts[kind] -= 1;
  scopes.pop();
  syncEmit();
}

export function __resetLayoutMotionForTest(): void {
  counts.move = 0;
  counts.resize = 0;
  scopes.length = 0;
  emitted.lastEmittedKey = null;
  listeners.clear();
  if (typeof document !== "undefined") delete document.documentElement.dataset.layoutResizing;
}
