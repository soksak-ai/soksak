// @vitest-environment jsdom
// The rail contract, as numbers rather than as a look.
//
// Three claims decide whether the rail behaves: its visual surface is gone while a transition runs
// and back exactly once after it lands; a PIN click moves neither the station nor a pane; and a
// FLOW click puts the station on the focused pane's left clean line.
//
// All three are about moments, and a command asked afterwards sees only the last one. So each
// phase is written down as it happens, and the judgement reads the record.
import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetRailJournalForTest,
  railJournal,
  recordRailPhase,
} from "./railJournal";

const cells = (...ids: string[]) =>
  ids.map((id, index) => ({ id, rect: { left: index * 50, top: 0, width: 50, height: 100 } }));

beforeEach(() => {
  __resetRailJournalForTest();
  document.body.innerHTML = "";
});

/** Draws the rail surface, which exists in the DOM only while nothing is travelling. */
function railSurface(present: boolean): void {
  document.body.innerHTML = "";
  if (!present) return;
  const el = document.createElement("div");
  el.dataset.node = "rail/left";
  document.body.append(el);
}

describe("the rail journal", () => {
  it("writes one record per phase, in order", () => {
    railSurface(true);
    recordRailPhase({ phase: "settled", station: 0, cleanLines: [0, 100], cells: cells("pan-a") });
    railSurface(false);
    recordRailPhase({ phase: "traveling", station: 50, cleanLines: [0, 50, 100], cells: cells("pan-a", "pan-b") });
    railSurface(true);
    recordRailPhase({ phase: "settled", station: 50, cleanLines: [0, 50, 100], cells: cells("pan-a", "pan-b") });

    const journal = railJournal();
    expect(journal.map((r) => r.phase)).toEqual(["settled", "traveling", "settled"]);
    expect(journal.map((r) => r.sequence)).toEqual([1, 2, 3]);
  });

  it("counts the rail surface as it stands, not as it was declared", () => {
    // The declaration is an intention. The surface is what a person sees, and the two are the same
    // thing only when the render did what it was told.
    railSurface(false);
    recordRailPhase({ phase: "traveling", station: 50, cleanLines: [0, 50, 100], cells: cells("pan-a") });
    railSurface(true);
    recordRailPhase({ phase: "settled", station: 50, cleanLines: [0, 50, 100], cells: cells("pan-a") });

    expect(railJournal().map((r) => r.railSurfaces)).toEqual([0, 1]);
  });

  it("a move is the difference from the previous record, per pane", () => {
    // The delta is what a PIN click is judged on: zero means the panes did not move. Recomputing it
    // from two commands asked afterwards compares two moments that are not the ones that happened.
    recordRailPhase({ phase: "settled", station: 0, cleanLines: [0, 100], cells: cells("pan-a", "pan-b") });
    recordRailPhase({
      phase: "settled", station: 0, cleanLines: [0, 100],
      cells: [
        { id: "pan-a", rect: { left: 0, top: 0, width: 30, height: 100 } },
        { id: "pan-b", rect: { left: 30, top: 0, width: 70, height: 100 } },
      ],
    });

    const [, second] = railJournal();
    expect(second.moved).toEqual([
      { id: "pan-a", dLeft: 0, dTop: 0, dWidth: -20, dHeight: 0 },
      { id: "pan-b", dLeft: -20, dTop: 0, dWidth: 20, dHeight: 0 },
    ]);
  });

  it("a pane that did not move is not in the move list", () => {
    // A list holding every pane every time makes "nothing moved" a thing to compute rather than to
    // read, and a PIN click is judged on exactly that.
    recordRailPhase({ phase: "settled", station: 0, cleanLines: [0, 100], cells: cells("pan-a", "pan-b") });
    recordRailPhase({ phase: "settled", station: 0, cleanLines: [0, 100], cells: cells("pan-a", "pan-b") });
    expect(railJournal()[1].moved).toEqual([]);
  });

  it("a pane that appeared or went is named rather than measured", () => {
    // There is no delta for a rectangle that did not exist. Reporting one against zero would say a
    // pane moved the whole width of the window.
    recordRailPhase({ phase: "settled", station: 0, cleanLines: [0, 100], cells: cells("pan-a") });
    recordRailPhase({ phase: "settled", station: 0, cleanLines: [0, 100], cells: cells("pan-a", "pan-b") });
    const [, second] = railJournal();
    expect(second.moved).toEqual([]);
    expect(second.appeared).toEqual(["pan-b"]);
    expect(second.gone).toEqual([]);
  });

  it("the station delta is carried too", () => {
    recordRailPhase({ phase: "settled", station: 0, cleanLines: [0, 100], cells: cells("pan-a") });
    recordRailPhase({ phase: "settled", station: 50, cleanLines: [0, 50, 100], cells: cells("pan-a") });
    expect(railJournal()[1].dStation).toBe(50);
  });

  it("the journal is bounded, and keeps the most recent", () => {
    // A window left open for a day would otherwise hold every phase it ever ran.
    for (let i = 0; i < 300; i += 1) {
      recordRailPhase({ phase: "settled", station: i, cleanLines: [0, 100], cells: cells("pan-a") });
    }
    const journal = railJournal();
    expect(journal.length).toBeLessThanOrEqual(128);
    expect(journal.at(-1)?.station).toBe(299);
  });
});
