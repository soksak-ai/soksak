// How wide each place a sidebar stands in is.
//
// A person drags a boundary and the width follows the pointer. Nothing outside could read that
// width or set it, so a drag was the one layout change with no numeric handle: reported as
// stuttering and as the document and the native layer coming apart, and neither could be measured
// (L10 — if verifying needs a command, making it is part of the work).
//
// One place for the three, because the bounds are what a drag is clamped to and what the command
// refuses by. Written in two spellings, a width a pointer cannot produce is a width a command can.
import { writePreference } from "../lib/preferenceStore";
import { moduleState } from "../lib/moduleState";
import type { SectionPlace } from "./sectionSets";

export interface WidthBounds {
  min: number;
  max: number;
  def: number;
}

/**
 * The bounds each place is held to.
 *
 * `rail` is narrower than the edges: it stands between the panes and takes its room from them, so a
 * width that reads as comfortable at a window's edge leaves the work with nothing.
 */
export const PLACE_WIDTH_BOUNDS: Record<SectionPlace, WidthBounds> = {
  left: { min: 200, max: 640, def: 300 },
  rail: { min: 160, max: 640, def: 320 },
  right: { min: 200, max: 640, def: 300 },
};

/** Where a place's width is written in the store the boot cache reads. */
export function placeWidthKey(place: SectionPlace): string {
  return `soksak.width.${place}`;
}

const box = moduleState("state/placeWidth#widths", () => ({
  widths: null as Record<SectionPlace, number> | null,
  listeners: new Set<() => void>(),
}));

/** Reads one from the store. Out of bounds is the default and not a clamp: the stored value is a
 *  cache a build with other bounds may have written, and a width nobody chose reads as a choice. */
function stored(place: SectionPlace): number {
  const bounds = PLACE_WIDTH_BOUNDS[place];
  const raw = Number(globalThis.localStorage?.getItem(placeWidthKey(place)));
  return Number.isFinite(raw) && raw >= bounds.min && raw <= bounds.max ? raw : bounds.def;
}

function widths(): Record<SectionPlace, number> {
  box.widths ??= { left: stored("left"), rail: stored("rail"), right: stored("right") };
  return box.widths;
}

export function placeWidth(place: SectionPlace): number {
  return widths()[place];
}

/** Whether a width is one a pointer could produce. The command and the drag ask the same question. */
export function widthWithinBounds(place: SectionPlace, width: number): boolean {
  const bounds = PLACE_WIDTH_BOUNDS[place];
  return Number.isFinite(width) && width >= bounds.min && width <= bounds.max;
}

/**
 * Sets one, and writes it down.
 *
 * The write goes through `writePreference`, which never throws: this runs on every frame of a drag,
 * and a full store used to take the window down from here (measured 2026-08-19).
 */
export function setPlaceWidth(place: SectionPlace, width: number): void {
  widths()[place] = width;
  writePreference(placeWidthKey(place), String(width), Date.now());
  for (const listener of box.listeners) listener();
}

/** Subscribers redrawn when a width changes. A drag writes here and the plane reads here, so the
 *  two cannot hold different widths for one place. */
export function onPlaceWidthChange(listener: () => void): () => void {
  box.listeners.add(listener);
  return () => void box.listeners.delete(listener);
}

/** Test seam — widths that outlive one case are a case that passes because of another. */
export function __resetPlaceWidthsForTest(): void {
  box.widths = null;
}
