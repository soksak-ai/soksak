// Content view — the **single surface** through which the app calls web content.
//
// Only the contract, the slot declaration, and the registry are here. **Nothing that fills it.**
//
// The framework defines what content is: in one framework it is an OS child view outside the
// document, moved by writing coordinates; in another it is a tag inside the document and being a
// child of the slot is all it takes. The app does not choose between the two — one cannot supply a
// tag and the other cannot supply an OS child view addressed by label. So an implementation stays
// in its own adapter leaf, and this file uses the registered one **without checking who
// registered it**.
//
// The caller (plugins/api.ts) does not know which one it is. That is why this file exists.
import { moduleState } from "../lib/moduleState";
import {
  readCompositionParticipant,
  type CompositionParticipant,
} from "./compositionParticipants";

/** What can be done to one content view — same names and arguments as the app's webview_* surface. */
/** One pointer event put into a surface — it states **what happened** as well.
 *
 * With coordinates alone, down, up, move, double click, and right button all become the same value
 * and the receiver can imitate only one of them. That surface then becomes a place that "takes a
 * press but neither drags nor right-clicks".
 */
export interface SurfacePointerInput {
  /** CSS px relative to the surface's own top-left corner. */
  x: number;
  y: number;
  /** `drag` is movement with a button held down — sent as `move`, the page receives a mousemove
   *  whose `buttons` is 0, so code that looks for a drag does nothing.
   *  `enter`/`exit` are the facts of **entering and leaving** the surface — a different event from
   *  movement, and the engine starts and ends hover with this pair. */
  kind: "down" | "up" | "move" | "drag" | "enter" | "exit";
  button: "left" | "right";
  /** 1=single, 2=double — the engine builds a double click from this number. */
  clickCount: number;
}

export interface ContentViewHost {
  open(label: string, opts: Record<string, unknown>): Promise<void>;
  close(label: string): Promise<void>;
  list(): Promise<string[]>;
  alive(label: string): Promise<boolean>;
  navigate(label: string, url: string): Promise<void>;
  /**
   * Fit this view to this rectangle.
   *
   * For an implementation that pushes coordinates this is a **command**; for one whose view is a
   * child of the slot it is a **comparison** — the latter is already fitted, so there is nothing to
   * write, and it answers with the fact when it is off.
   * Either way `false` means "did not fit". There is no silent success.
   */
  bounds(label: string, x: number, y: number, w: number, h: number): Promise<boolean>;
  visible(label: string, visible: boolean, focus?: boolean): Promise<void>;
  /** Completes when the coordinate and visibility change of the given views is applied to the actual displayed frame. */
  presentationSettled(labels: readonly string[]): Promise<void>;
  /** Completes when the previous commit of the main DOM chrome is applied to the actual displayed frame. */
  chromePresentationSettled(): Promise<void>;
  history(label: string, delta: number): Promise<void>;
  stop(label: string): Promise<void>;
  /** What the surface is showing, read from the surface rather than from what was asked of it.
   *
   * The address a caller navigated to is a request. A redirect, a load that failed and a load still
   * running are all invisible in it, and on a screen that has not painted yet the three look the
   * same. The shape is the surface kind's; core reads no field of it. */
  pageState(label: string): Promise<Record<string, unknown>>;
  /** Reload — not a re-navigation.
   *
   * Imitating it by navigating to the current URL again adds one more history entry, and a reload
   * from a position reached by going back returns to the forward entry (measured 2026-08-08).
   * `ignoreCache` discards the cache and fetches from the origin. */
  reload(label: string, ignoreCache?: boolean): Promise<void>;
  zoom(label: string, factor: number): Promise<number>;
  devtools(label: string): Promise<boolean>;
  evalJs(label: string, js: string): Promise<string>;
  /** Script injection. The return value is the revoke — an implementation that cannot undo an injection declares its revoke to be a no-op. */
  injectScript(label: string, code: string, phase: "document-start" | "document-end"): () => void;
  /** Opens in a window outside the app (a new window of this app, not an external browser). */
  openWindow(url: string): Promise<void>;
  /**
   * Puts real input **inside** the content view — view coordinates (CSS px).
   *
   * A script-made click has no user activation, so the engine blocks things like window-open
   * (measured 2026-08-02: pressing a `_blank` link by script produced 0 window-open requests). That
   * stopped verification at "there is no way to measure it" — building what is missing is part of
   * this place's job (A27).
   *
   * An implementation that cannot do it refuses with its name. Silent success makes the caller
   * believe the press happened.
   */
  sendInput(label: string, input: SurfacePointerInput): Promise<void>;
  /**
   * Whether this surface **can receive a pointer right now** — the framework's fact as it is.
   *
   * Knowing only that input did not land makes the caller suspect its own coordinates. What settles
   * delivery is the state of the surface and of its window, and with no place to query that, the
   * cause stays a guess forever (measured 2026-08-08: presses arrived and moves were 0, and there
   * was nowhere to query what cut them).
   *
   * `at` queries the fact **at that position** (surface coordinates, CSS px) — some delivery
   * conditions differ per position (which window is topmost at that point). Omitted, the current
   * cursor position is measured.
   *
   * The answer may hold different keys per framework — what counts as that surface's fact is for
   * that framework to define.
   */
  inputState(label: string, at?: { x: number; y: number }): Promise<Record<string, unknown>>;
  /** Puts real wheel input into the content view — view coordinates and DOM WheelEvent signs (+down/+right). */
  wheel(label: string, x: number, y: number, dx: number, dy: number): Promise<void>;
  captureFull(label: string, path: string, width: number, height: number): Promise<{ path: string; bytes: number }>;
  /** Puts a committed string into the currently focused editing element through the engine's text input path. */
  typeText(label: string, text: string): Promise<void>;
  /**
   * Puts **in-composition** text in — a different fact from a commit.
   *
   * Korean, Japanese, and Chinese pass through a composition state before commit, during which the
   * page receives `compositionstart`/`compositionupdate` and shows characters that are not the value
   * yet. With commit-only input, that stretch is never exercised and the claim becomes "Hangul goes
   * in".
   *
   * An empty string **resolves** the composition (commit) — the point where a person ends it with
   * space or enter. Without a place to resolve it, the composition stays open and the next input
   * stacks on top of it.
   */
  markText(label: string, text: string): Promise<void>;
  /**
   * Puts one key into the surface — a **key**, not a character.
   *
   * A committed string (`typeText`) goes through the editing path and cannot produce Enter, Escape,
   * or arrows. Features that respond only to those (address bar commit, palette movement, shortcuts)
   * were therefore unverifiable.
   */
  sendKey(label: string, key: string, modifiers?: {
    ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean;
  }): Promise<void>;
  /**
   * What the surface is showing, as a picture the document can draw.
   *
   * A native surface is composited above the document, so nothing drawn in the document can be put
   * over it: a modal opens and the page covers the card, a rail travels and the page covers the
   * rail. The only way to put something over it is to take it off the screen — and a pane that goes
   * blank is what a person reads as a view that failed.
   *
   * So a surface that is parked leaves its picture behind. The document draws that picture where the
   * surface was, and the screen keeps showing the page while something is drawn over it. An
   * implementation whose surfaces are inside the document has nothing to leave and answers null.
   */
  picture(label: string): Promise<string | null>;

  /**
   * Where the native layer holds each surface **right now**, read from what it applied.
   *
   * The document is one clock and the native layer is another. A reading taken from the
   * document alone gives where the pane is; a reading taken from the compositor alone gives where
   * the page is; and a page drawn 160 points off its pane satisfies both separately — measured 2026-08-17,
   * a browser page over the sidebar with every composition reading reporting zero drift.
   *
   * An implementation with no native layer answers an empty list, and that is the fact rather than
   * a refusal: nothing is applied outside the document.
   */
  appliedSurfaces(): Promise<AppliedSurface[]>;
}

/**
 * What the native layer last reported back, and when.
 *
 * Every commit is answered with the applied rectangles, so the freshest reading a window can have
 * costs nothing: it is the answer to the request it already made. Asking the compositor again on top
 * of that adds a round trip, and a reading a round trip old compared against an element now is two
 * instants — during a motion the difference between them is the motion itself, which is how 72
 * points of nothing became a defect report on 2026-08-17.
 */
let lastApplied: {
  surfaces: readonly AppliedSurface[];
  atUnixMs: number;
  /** How long the commit that carried these took, from the rectangles being measured to the native
   *  layer answering. This is the distance a page can be behind its pane: the pane moves in the
   *  frame the document paints, and the page moves when this is over. */
  latencyMs: number;
  /** How many commits have been answered. A window that commits once per frame while a layout moves
   *  is paying a round trip per frame, and the count is the record of it. */
  /** What the native layer itself held the commit for. The difference between this and `latencyMs`
   *  is the bridge and the wait for a thread that was busy with something else. */
  appliedMs: number;
  /** How long the commit took to reach the backend from this document — the bridge and
   *  whatever was ahead of it. -1 before the first receipt with a stamp on it. */
  carriedMs: number;
  commits: number;
  /** Every round trip added up, and the worst one, since this window started.
   *
   *  A last value cannot be read across a stretch: a move whose commits were all quick reported the
   *  same 45ms as the move before it, because that was the last one answered. Totals subtract, so a
   *  stretch reports how many commits it paid for and what they cost. */
  latencyTotalMs: number;
  latencyWorstMs: number;
} = {
  surfaces: [],
  atUnixMs: 0,
  latencyMs: 0,
  appliedMs: -1,
  carriedMs: -1,
  commits: 0,
  latencyTotalMs: 0,
  latencyWorstMs: 0,
};

/** The framework writes down what came back with its commit, and what the round trip cost. */
export function noteAppliedSurfaces(
  surfaces: readonly AppliedSurface[],
  atUnixMs: number,
  latencyMs: number,
  appliedMs: number,
  carriedMs: number,
): void {
  lastApplied = {
    surfaces,
    atUnixMs,
    latencyMs,
    appliedMs,
    carriedMs,
    commits: lastApplied.commits + 1,
    latencyTotalMs: Math.round((lastApplied.latencyTotalMs + latencyMs) * 100) / 100,
    latencyWorstMs: Math.max(lastApplied.latencyWorstMs, latencyMs),
  };
}

/** What came back last, with the instant it did and what it cost. Empty until the first commit is
 *  answered. */
export function lastAppliedSurfaces(): {
  surfaces: readonly AppliedSurface[];
  atUnixMs: number;
  latencyMs: number;
  appliedMs: number;
  carriedMs: number;
  commits: number;
  latencyTotalMs: number;
  latencyWorstMs: number;
} {
  return lastApplied;
}

/** One surface as the native layer holds it. Coordinates are CSS pixels from the window's top left,
 *  the frame the declaration is written in. */
export interface AppliedSurface {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
}

/**
 * Attribute declaring **where a content view is placed** — the value is the label.
 *
 *   <div className="<the plugin's own class>" data-content-view-body={label} />
 *
 * One declaration, two readers: for an implementation that pushes coordinates this slot is a
 * **follow anchor**; for one placed inside the document it is the **parent**. The declaring side
 * (the plugin) does not need that difference.
 */
export const CONTENT_VIEW_BODY = "data-content-view-body";

/**
 * Every element declaring a native surface, in document order.
 *
 * The attribute is the plugin's declaration (`data-native-surface`, `data-native-surface-id`), the
 * same one the compositor reads to build its inventory. Read here so a question about where a
 * surface is can be answered against the element that asked for it, rather than against a record of
 * what was asked some commits ago.
 */
export function nativeSurfaceDeclarations(doc: Document = document): HTMLElement[] {
  return Array.from(doc.querySelectorAll<HTMLElement>("[data-native-surface][data-native-surface-id]"));
}

/** The slot declared for this label. Without one, this view has **no slot** and is not placed on screen. */
export function findContentViewSlot(label: string, doc: Document): HTMLElement | null {
  for (const el of doc.querySelectorAll<HTMLElement>(`[${CONTENT_VIEW_BODY}]`)) {
    if (el.getAttribute(CONTENT_VIEW_BODY) === label) return el;
  }
  return null;
}

/** The slot's actual DOM composition visibility. Coordinates and framework surface state are never used as proxies. */
export function contentViewSlotVisible(slot: HTMLElement): boolean {
  for (let current: HTMLElement | null = slot; current; current = current.parentElement) {
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (style?.visibility === "hidden" || style?.display === "none") return false;
    if (
      current.hasAttribute("data-workspace-plane") &&
      current.dataset.workspaceActive !== "1"
    ) return false;
  }
  return true;
}

export interface ContentViewDomFact {
  label: string;
  slotLabel: string | null;
  directVisibility: string;
  computedVisibility: string;
  display: string;
  projectId: string | null;
  workspaceActive: boolean;
  /**
   * Composition participation this surface declared itself. Without it, the reader infers the view
   * from label syntax, and that inference silently points at someone else's view the day the syntax
   * changes. null when nothing was stamped.
   */
  composition: CompositionParticipant | null;
  /**
   * The light this surface passes through — dimming that an adapter applied to its own surface shows
   * up here.
   *
   * One work-surface plane owns the lighting. When an adapter darkens its own surface once more, the
   * same screen is dimmed twice, and with no place to query it the judge can only write down
   * "probably not applied" — from that moment the axis passes forever, whatever is applied.
   */
  opacity: string;
  filter: string;
  rect: { x: number; y: number; w: number; h: number };
}

/** Public state of in-document content surfaces. For a native implementation an empty list is the fact. */
export function contentViewDomFacts(doc: Document = document): ContentViewDomFact[] {
  const out: ContentViewDomFact[] = [];
  for (const el of doc.querySelectorAll<HTMLElement>("[data-content-view]")) {
    const slot = el.closest<HTMLElement>(`[${CONTENT_VIEW_BODY}]`);
    const workspace = el.closest<HTMLElement>("[data-workspace-plane]");
    const style = doc.defaultView?.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    out.push({
      label: el.getAttribute("data-content-view") ?? "",
      slotLabel: slot?.getAttribute(CONTENT_VIEW_BODY) ?? null,
      directVisibility: el.style.visibility,
      computedVisibility: style?.visibility ?? "",
      display: style?.display ?? "",
      projectId: workspace?.dataset.workspacePlane ?? null,
      workspaceActive: workspace?.dataset.workspaceActive === "1",
      composition: readCompositionParticipant(el),
      opacity: style?.opacity ?? "",
      filter: style?.filter ?? "",
      rect: {
        x: +rect.x.toFixed(2),
        y: +rect.y.toFixed(2),
        w: +rect.width.toFixed(2),
        h: +rect.height.toFixed(2),
      },
    });
  }
  return out;
}

// Outside the hot-swap boundary — a fresh registry here is never re-registered, because the
// registering side already recorded that it registered.
const registered = moduleState("lib/contentViews#host", () => ({
  host: null as ContentViewHost | null,
}));

/** The framework registers its own implementation. Once at load time — the core never calls it. */
export function registerContentViewHost(host: ContentViewHost): void {
  registered.host = host;
}

/**
 * The active implementation — **neither the framework name nor its capabilities are queried.**
 *
 * With nothing registered, this refuses with its name. Returning an empty implementation leaves the
 * caller believing it opened while the screen shows nothing, and that silence never surfaces as an
 * error.
 */
export function contentViewHost(): ContentViewHost {
  if (!registered.host) {
    throw new Error(
      "No content view implementation is registered. The framework adapter install must call registerContentViewHost.",
    );
  }
  return registered.host;
}

/** Is one registered — where audit and diagnosis separate "absent" from "empty". */
export function hasContentViewHost(): boolean {
  return registered.host !== null;
}

/** Test-only reset — the registry is outside the hot-swap boundary, so module re-evaluation does not clear it. */
export function __resetContentViewHostForTest(): void {
  registered.host = null;
}
