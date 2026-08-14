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
    const dom = await prepareLayoutMove([{ viewId: "v1", dx: 120 }]);
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
    const native = await prepareLayoutMove([{ viewId: "v1", dx: 120 }]);
    expect(native.mode).toBe("snap");
    await native.commit();
    expect(commit).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    expect(prepareChange).toHaveBeenCalledWith(
      {
        moves: [{ viewId: "v1", dx: 120 }],
        projectionParticipants: [],
        panePresentationTargets: [],
        paneSettlementParticipants: [],
      },
      { transactionId: "layout-2" },
    );
  });

  it("every view in a moving group is published with the same physical displacement", () => {
    expect(viewLayoutMoves(
      [{ id: "g1", dLeftPct: 25, dRailUnits: -1 }],
      [
        { id: "g1", viewIds: ["terminal-1", "browser-1"], panePresentationViewIds: [] },
        { id: "g2", viewIds: ["browser-2"], panePresentationViewIds: [] },
      ],
      800,
      60,
    )).toEqual([
      { viewId: "terminal-1", dx: 140 },
      { viewId: "browser-1", dx: 140 },
    ]);
  });

  it("projection-only delta keeps translation empty and declares the retained target owner", () => {
    const before = {
      station: 50, focusId: "g1",
      cells: [
        { id: "g1", rect: { left: 0, top: 0, width: 50, height: 100 } },
        { id: "g2", rect: { left: 50, top: 0, width: 50, height: 100 } },
      ],
    };
    const after = {
      station: 100, focusId: "g1",
      cells: [{ id: "g1", rect: { left: 0, top: 0, width: 100, height: 100 } }],
    };
    expect(viewLayoutChange(before, after, [
      { id: "g1", viewIds: ["browser-left"], panePresentationViewIds: ["browser-left"] },
      { id: "g2", viewIds: ["browser-right"], panePresentationViewIds: ["browser-right"] },
    ], 800, 60)).toEqual({
      moves: [],
      projectionParticipants: [{ viewId: "browser-left", kind: "projection-snap" }],
      panePresentationTargets: [{ viewId: "browser-left" }],
      paneSettlementParticipants: [{ viewId: "browser-right" }],
    });
  });

  it("right maximize is projection snap even when the retained target also has a translation", () => {
    const before = {
      station: 50, focusId: "g1",
      cells: [
        { id: "g1", rect: { left: 0, top: 0, width: 50, height: 100 } },
        { id: "g2", rect: { left: 50, top: 0, width: 50, height: 100 } },
      ],
    };
    const after = {
      station: 0, focusId: "g2",
      cells: [{ id: "g2", rect: { left: 0, top: 0, width: 100, height: 100 } }],
    };
    expect(viewLayoutChange(before, after, [
      { id: "g1", viewIds: ["browser-left"], panePresentationViewIds: ["browser-left"] },
      { id: "g2", viewIds: ["browser-right"], panePresentationViewIds: ["browser-right"] },
    ], 2000, 160)).toEqual({
      moves: [{ viewId: "browser-right", dx: 920 }],
      projectionParticipants: [{ viewId: "browser-right", kind: "projection-snap" }],
      panePresentationTargets: [{ viewId: "browser-right" }],
      paneSettlementParticipants: [{ viewId: "browser-left" }],
    });
  });

  it("equal-size FLOW translation remains a glide without projection participants", () => {
    const before = {
      station: 50, focusId: "g1",
      cells: [
        { id: "g1", rect: { left: 0, top: 0, width: 50, height: 100 } },
        { id: "g2", rect: { left: 50, top: 0, width: 50, height: 100 } },
      ],
    };
    const after = {
      station: 50, focusId: "g2",
      cells: [
        { id: "g2", rect: { left: 0, top: 0, width: 50, height: 100 } },
        { id: "g1", rect: { left: 50, top: 0, width: 50, height: 100 } },
      ],
    };
    const change = viewLayoutChange(before, after, [
      { id: "g1", viewIds: ["browser-left"], panePresentationViewIds: ["browser-left"] },
      { id: "g2", viewIds: ["browser-right"], panePresentationViewIds: ["browser-right"] },
    ], 2000, 160);
    expect(change.moves).toHaveLength(2);
    expect(change.projectionParticipants).toEqual([]);
  });

  it("a pane rearrangement snaps the native pane owners whose geometry changed, not the focused terminal", () => {
    const before = {
      station: 50, focusId: "terminal-bottom-right",
      cells: [
        { id: "browser-left", rect: { left: 0, top: 0, width: 50, height: 100 } },
        { id: "browser-top-right", rect: { left: 50, top: 0, width: 50, height: 50 } },
        { id: "terminal-bottom-right", rect: { left: 50, top: 50, width: 50, height: 50 } },
      ],
    };
    const after = {
      station: 0, focusId: "terminal-bottom-right",
      cells: [
        { id: "browser-left", rect: { left: 0, top: 0, width: 50, height: 50 } },
        { id: "terminal-bottom-right", rect: { left: 0, top: 50, width: 50, height: 50 } },
        { id: "browser-top-right", rect: { left: 50, top: 0, width: 50, height: 100 } },
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
    ], 2000, 160)).toMatchObject({
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
      station: 50, focusId: "g2",
      cells: [
        { id: "g1", rect: { left: 0, top: 0, width: 50, height: 100 } },
        { id: "g2", rect: { left: 50, top: 0, width: 50, height: 100 } },
      ],
    };
    const after = { ...before, station: 0, focusId: "g1" };
    expect(viewLayoutChange(before, after, [
      { id: "g1", viewIds: ["browser-left"], panePresentationViewIds: ["browser-left"] },
      { id: "g2", viewIds: ["browser-right"], panePresentationViewIds: ["browser-right"] },
    ], 2000, 160)).toMatchObject({
      panePresentationTargets: [{ viewId: "browser-left" }],
      paneSettlementParticipants: [{ viewId: "browser-right" }],
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

    await expect(prepareLayoutMove([{ viewId: "v1", dx: 120 }]))
      .rejects.toThrow("layout staged target identity is invalid");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
