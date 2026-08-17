import { moduleState } from "./moduleState";

// The rail contract, written down as it happens.
//
// Three claims decide whether the rail behaves: its visual surface is gone while a transition runs
// and back exactly once after landing; a PIN click moves neither the station nor a pane; and a FLOW
// click puts the station on the focused pane's left clean line.
//
// All three are about moments. A command asked afterwards sees the last one only, and recomputing a
// delta from two later reads compares two moments that are not the ones that happened. So each
// phase is recorded when it occurs and the judgement reads the record.

/** A cell as the arrangement solved it, in percent of the space. */
export interface RailJournalCell {
  id: string;
  rect: { left: number; top: number; width: number; height: number };
}

/** How far one pane moved between two records. */
export interface RailJournalMove {
  id: string;
  dLeft: number;
  dTop: number;
  dWidth: number;
  dHeight: number;
}

/** What a caller supplies for one phase. The deltas and the surface count are measured here. */
export interface RailPhaseInput {
  /** traveling while a transition runs, settled once it has landed. */
  phase: "settled" | "traveling";
  station: number;
  cleanLines: number[];
  cells: RailJournalCell[];
  /** The frame number of a running recording, which is the clock every journal shares. Null when
   *  nothing is recording, because a made-up number would not line up with any picture. */
  frame?: number | null;
}

export interface RailPhaseRecord extends Required<Omit<RailPhaseInput, "frame">> {
  sequence: number;
  frame: number | null;
  /** Rail surfaces in the document at this moment. The declaration is an intention; this is what a
   *  person sees, and the two agree only when the render did what it was told. */
  railSurfaces: number;
  dStation: number;
  /** Panes whose rectangle changed. A pane that did not move is absent, so "nothing moved" is read
   *  rather than computed — which is exactly what a PIN click is judged on. */
  moved: RailJournalMove[];
  /** Panes with no rectangle in the previous record, and panes that had one and no longer do.
   *  There is no delta for a rectangle that did not exist; reporting one against zero would say a
   *  pane moved the whole width of the window. */
  appeared: string[];
  gone: string[];
}

// A window left open for a day would otherwise hold every phase it ever ran.
const LIMIT = 128;

const state = moduleState("lib/railJournal", () => ({
  sequence: 0,
  records: [] as RailPhaseRecord[],
}));

function railSurfacesNow(): number {
  if (typeof document === "undefined") return 0;
  // The rail is on the screen for as long as it owns width, travelling included. Its surface used
  // to be removed for the phase, which left 165 points belonging to nobody while the panes travelled
  // into them — measured 2026-08-17. So a travelling record holds one, the same as a settled one,
  // and a record holding none while a region stands is the defect this counts.
  return document.querySelectorAll('[data-node="rail/left"]').length;
}

/** Writes one phase. */
export function recordRailPhase(input: RailPhaseInput): RailPhaseRecord {
  const held = state;
  const previous = held.records.at(-1);
  const before = new Map((previous?.cells ?? []).map((cell) => [cell.id, cell.rect]));
  const after = new Map(input.cells.map((cell) => [cell.id, cell.rect]));

  const moved: RailJournalMove[] = [];
  const appeared: string[] = [];
  for (const cell of input.cells) {
    const was = before.get(cell.id);
    if (!was) {
      if (previous) appeared.push(cell.id);
      continue;
    }
    const move: RailJournalMove = {
      id: cell.id,
      dLeft: cell.rect.left - was.left,
      dTop: cell.rect.top - was.top,
      dWidth: cell.rect.width - was.width,
      dHeight: cell.rect.height - was.height,
    };
    if (move.dLeft || move.dTop || move.dWidth || move.dHeight) moved.push(move);
  }
  const gone = [...before.keys()].filter((id) => !after.has(id));

  const record: RailPhaseRecord = {
    sequence: (held.sequence += 1),
    phase: input.phase,
    frame: input.frame ?? null,
    station: input.station,
    cleanLines: [...input.cleanLines],
    cells: input.cells.map((cell) => ({ id: cell.id, rect: { ...cell.rect } })),
    railSurfaces: railSurfacesNow(),
    dStation: previous ? input.station - previous.station : 0,
    moved,
    appeared,
    gone,
  };
  held.records.push(record);
  if (held.records.length > LIMIT) held.records.splice(0, held.records.length - LIMIT);
  return record;
}

/** Every phase still held, oldest first. */
export function railJournal(): RailPhaseRecord[] {
  return state.records.map((record) => ({ ...record }));
}

export function __resetRailJournalForTest(): void {
  const held = state;
  held.sequence = 0;
  held.records = [];
}
