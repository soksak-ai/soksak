import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetLayoutTransitionHostForTest,
  prepareLayoutMove,
  registerLayoutTransitionHost,
  type LayoutChange,
  viewLayoutChange,
  viewLayoutMoves,
} from "./layoutTransitionHost";
import { __resetLayoutTransitionJournalForTest } from "./layoutTransitionJournal";
import { tmsg } from "../i18n";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("layoutTransitionHost", () => {
  beforeEach(() => {
    __resetLayoutTransitionHostForTest();
    __resetLayoutTransitionJournalForTest();
  });

  it("App builds pane targets from manifest ownership, not from runtime view registration", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../App.tsx"), "utf8");
    expect(source).toContain("ownsNativeSurfaceFromManifests(view.pluginId, view.view)");
    expect(source).not.toContain("getRegisteredView(");
  });

  it("with no adapter installed the move is a DOM glide, and an installed adapter's readiness is awaited unchanged", async () => {
    const dom = await prepareLayoutMove([{ viewId: "tab-aaaaaa", dx: 120 }]);
    expect(dom.mode).toBe("glide");
    const commit = vi.fn(async () => {});
    const cancel = vi.fn();
    const prepareChange = vi.fn(async (
      _change: LayoutChange,
      identity: { transactionId: string },
    ) => ({
      transactionId: identity.transactionId,
      mode: "snap" as const,
      requiresSharedStart: false,
      stagedTargets: [],
      start: async () => null,
      commit: async () => {
        await commit();
        return { transactionId: identity.transactionId, producer: "layout-adapter" as const, targets: [] };
      },
      cancel,
    }));
    registerLayoutTransitionHost({ prepareChange });
    const native = await prepareLayoutMove([{ viewId: "tab-aaaaaa", dx: 120 }]);
    expect(native.mode).toBe("snap");
    await native.commit();
    expect(commit).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    expect(prepareChange).toHaveBeenCalledWith(
      {
        moves: [{ viewId: "tab-aaaaaa", dx: 120 }],
        projectionParticipants: [],
        panePresentationTargets: [],
        paneSettlementParticipants: [],
      },
      { transactionId: "layout-2" },
    );
  });

  it("every view in a moving group is published with the same physical displacement", () => {
    expect(viewLayoutMoves(
      [{ id: "pan-aaaaaa", dLeft: 140 }],
      [
        { id: "pan-aaaaaa", viewIds: ["terminal-1", "browser-1"], panePresentationViewIds: [] },
        { id: "pan-bbbbbb", viewIds: ["browser-2"], panePresentationViewIds: [] },
      ],
    )).toEqual([
      { viewId: "terminal-1", dx: 140 },
      { viewId: "browser-1", dx: 140 },
    ]);
  });

  it("projection-only delta keeps translation empty and declares the retained target owner", () => {
    const before = {
      railPresent: true, station: 50, focusId: "pan-aaaaaa",
      cells: [
        { id: "pan-aaaaaa", rect: { left: 0, top: 0, width: 50, height: 100 } },
        { id: "pan-bbbbbb", rect: { left: 50, top: 0, width: 50, height: 100 } },
      ],
    };
    const after = {
      railPresent: true, station: 100, focusId: "pan-aaaaaa",
      cells: [{ id: "pan-aaaaaa", rect: { left: 0, top: 0, width: 100, height: 100 } }],
    };
    expect(viewLayoutChange(before, after, [
      { id: "pan-aaaaaa", viewIds: ["browser-left"], panePresentationViewIds: ["browser-left"] },
      { id: "pan-bbbbbb", viewIds: ["browser-right"], panePresentationViewIds: ["browser-right"] },
    ])) .toEqual({
      moves: [],
      projectionParticipants: [{ viewId: "browser-left", kind: "projection-snap" }],
      panePresentationTargets: [{ viewId: "browser-left" }],
      paneSettlementParticipants: [{ viewId: "browser-right" }],
    });
  });

  it("right maximize is a projection snap, and a box that changes shape does not travel", () => {
    // A 2000px plane with a 160px rail: a | rail | b, then the rail at the front of b alone. b's
    // left edge moves 920 and its right edge stays; a translate would move both.
    const before = {
      railPresent: true, station: 920, focusId: "pan-aaaaaa",
      cells: [
        { id: "pan-aaaaaa", rect: { left: 0, top: 0, width: 920, height: 1000 } },
        { id: "pan-bbbbbb", rect: { left: 1080, top: 0, width: 920, height: 1000 } },
      ],
    };
    const after = {
      railPresent: true, station: 0, focusId: "pan-bbbbbb",
      cells: [{ id: "pan-bbbbbb", rect: { left: 160, top: 0, width: 1840, height: 1000 } }],
    };
    expect(viewLayoutChange(before, after, [
      { id: "pan-aaaaaa", viewIds: ["browser-left"], panePresentationViewIds: ["browser-left"] },
      { id: "pan-bbbbbb", viewIds: ["browser-right"], panePresentationViewIds: ["browser-right"] },
    ])).toEqual({
      moves: [],
      projectionParticipants: [{ viewId: "browser-right", kind: "projection-snap" }],
      panePresentationTargets: [{ viewId: "browser-right" }],
      paneSettlementParticipants: [{ viewId: "browser-left" }],
    });
  });

  it("equal-size FLOW translation remains a glide without projection participants", () => {
    const before = {
      railPresent: true, station: 920, focusId: "pan-aaaaaa",
      cells: [
        { id: "pan-aaaaaa", rect: { left: 0, top: 0, width: 920, height: 1000 } },
        { id: "pan-bbbbbb", rect: { left: 1080, top: 0, width: 920, height: 1000 } },
      ],
    };
    const after = {
      railPresent: true, station: 920, focusId: "pan-bbbbbb",
      cells: [
        { id: "pan-bbbbbb", rect: { left: 0, top: 0, width: 920, height: 1000 } },
        { id: "pan-aaaaaa", rect: { left: 1080, top: 0, width: 920, height: 1000 } },
      ],
    };
    const change = viewLayoutChange(before, after, [
      { id: "pan-aaaaaa", viewIds: ["browser-left"], panePresentationViewIds: ["browser-left"] },
      { id: "pan-bbbbbb", viewIds: ["browser-right"], panePresentationViewIds: ["browser-right"] },
    ]);
    expect(change.moves).toHaveLength(2);
    expect(change.projectionParticipants).toEqual([]);
  });

  it("a pane rearrangement snaps the native pane owners whose geometry changed, not the focused terminal", () => {
    const before = {
      railPresent: true, station: 920, focusId: "terminal-bottom-right",
      cells: [
        { id: "browser-left", rect: { left: 0, top: 0, width: 920, height: 1000 } },
        { id: "browser-top-right", rect: { left: 1080, top: 0, width: 920, height: 500 } },
        { id: "terminal-bottom-right", rect: { left: 1080, top: 500, width: 920, height: 500 } },
      ],
    };
    const after = {
      railPresent: true, station: 0, focusId: "terminal-bottom-right",
      cells: [
        { id: "browser-left", rect: { left: 160, top: 0, width: 920, height: 500 } },
        { id: "terminal-bottom-right", rect: { left: 160, top: 500, width: 920, height: 500 } },
        { id: "browser-top-right", rect: { left: 1080, top: 0, width: 920, height: 1000 } },
      ],
    };

    expect(viewLayoutChange(before, after, [
      {
        id: "browser-left",
        viewIds: ["browser-left-tab"],
        panePresentationViewIds: ["browser-left-tab"],
      },
      {
        id: "browser-top-right",
        viewIds: ["browser-right-tab"],
        panePresentationViewIds: ["browser-right-tab"],
      },
      {
        id: "terminal-bottom-right",
        viewIds: ["terminal-tab"],
        panePresentationViewIds: [],
      },
    ])).toMatchObject({
      projectionParticipants: [
        { viewId: "browser-left-tab", kind: "projection-snap" },
        { viewId: "browser-right-tab", kind: "projection-snap" },
      ],
      panePresentationTargets: [
        { viewId: "browser-left-tab" },
        { viewId: "browser-right-tab" },
      ],
      paneSettlementParticipants: [],
    });
  });

  it("a translation publishes the moving target and the non-target settlement sibling identity separately", () => {
    const before = {
      railPresent: true, station: 920, focusId: "pan-bbbbbb",
      cells: [
        { id: "pan-aaaaaa", rect: { left: 0, top: 0, width: 920, height: 1000 } },
        { id: "pan-bbbbbb", rect: { left: 1080, top: 0, width: 920, height: 1000 } },
      ],
    };
    // The rail travels to the front: a moves right by the rail's width, b stays.
    const after = {
      ...before, station: 0, focusId: "pan-aaaaaa",
      cells: [
        { id: "pan-aaaaaa", rect: { left: 160, top: 0, width: 920, height: 1000 } },
        { id: "pan-bbbbbb", rect: { left: 1080, top: 0, width: 920, height: 1000 } },
      ],
    };
    expect(viewLayoutChange(before, after, [
      { id: "pan-aaaaaa", viewIds: ["browser-left"], panePresentationViewIds: ["browser-left"] },
      { id: "pan-bbbbbb", viewIds: ["browser-right"], panePresentationViewIds: ["browser-right"] },
    ])).toMatchObject({
      panePresentationTargets: [{ viewId: "browser-left" }],
      paneSettlementParticipants: [{ viewId: "browser-right" }],
    });
  });

  it("rail presence alone snaps every native pane presentation before the width changes", () => {
    const cells = [
      { id: "pan-aaaaaa", rect: { left: 160, top: 0, width: 920, height: 1000 } },
      { id: "pan-bbbbbb", rect: { left: 1080, top: 0, width: 920, height: 1000 } },
    ];
    const before = { railPresent: true, station: 0, focusId: "pan-aaaaaa", cells };
    // The rail withdraws: the room goes to the pane beside it, which grows without moving.
    const after = {
      ...before, railPresent: false,
      cells: [
        { id: "pan-aaaaaa", rect: { left: 0, top: 0, width: 1080, height: 1000 } },
        { id: "pan-bbbbbb", rect: { left: 1080, top: 0, width: 920, height: 1000 } },
      ],
    };

    expect(viewLayoutChange(before, after, [
      { id: "pan-aaaaaa", viewIds: ["browser-left"], panePresentationViewIds: ["browser-left"] },
      { id: "pan-bbbbbb", viewIds: ["terminal-right"], panePresentationViewIds: ["terminal-right"] },
    ])).toMatchObject({
      moves: [],
      projectionParticipants: [
        { viewId: "browser-left", kind: "projection-snap" },
        { viewId: "terminal-right", kind: "projection-snap" },
      ],
      panePresentationTargets: [
        { viewId: "browser-left" },
        { viewId: "terminal-right" },
      ],
    });
  });

  it("adapter bootstrap snap is a public participant kind separate from projection snap", () => {
    const source = readFileSync(resolve(import.meta.dirname, "./layoutTransitionHost.ts"), "utf8");
    expect(source).toContain('kind: "projection-snap" | "bootstrap-snap"');
  });

  it.each([
    ["duplicate", ["pane:p1", "pane:p1"]],
    ["unknown owner", ["member:b1"]],
    ["empty identity", ["direct:"]],
  ])("a %s declaration in native stagedTargets is rejected before the transaction", async (_name, stagedTargets) => {
    const cancel = vi.fn();
    registerLayoutTransitionHost({
      prepareChange: async (_change, identity) => ({
        transactionId: identity.transactionId,
        mode: "glide",
        requiresSharedStart: true,
        stagedTargets,
        start: async () => null,
        commit: async () => {},
        cancel,
      }),
    });

    await expect(prepareLayoutMove([{ viewId: "tab-aaaaaa", dx: 120 }]))
      // Matched on the sentence the key resolves to, not on one language's
      // wording: tmsg answers in the current language, and a hardcoded English
      // expectation fails under the default (ko). The id is left out so the
      // transaction counter does not have to be known here.
      .rejects.toThrow(tmsg("layout.transition.stagedTargetInvalid", { transactionId: "" }));
    expect(cancel).toHaveBeenCalledOnce();
  });
});
