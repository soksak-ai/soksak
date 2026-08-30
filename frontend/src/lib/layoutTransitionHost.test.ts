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
      [{ id: "pan-aaaaaa", dLeftPct: 25, dRailUnits: -1 }],
      [
        { id: "pan-aaaaaa", viewIds: ["terminal-1", "browser-1"], panePresentationViewIds: [] },
        { id: "pan-bbbbbb", viewIds: ["browser-2"], panePresentationViewIds: [] },
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
    ], 800, 60)).toEqual({
      moves: [],
      projectionParticipants: [{ viewId: "browser-left", kind: "projection-snap" }],
      panePresentationTargets: [{ viewId: "browser-left" }],
      paneSettlementParticipants: [{ viewId: "browser-right" }],
    });
  });

  it("right maximize is projection snap even when the retained target also has a translation", () => {
    const before = {
      railPresent: true, station: 50, focusId: "pan-aaaaaa",
      cells: [
        { id: "pan-aaaaaa", rect: { left: 0, top: 0, width: 50, height: 100 } },
        { id: "pan-bbbbbb", rect: { left: 50, top: 0, width: 50, height: 100 } },
      ],
    };
    const after = {
      railPresent: true, station: 0, focusId: "pan-bbbbbb",
      cells: [{ id: "pan-bbbbbb", rect: { left: 0, top: 0, width: 100, height: 100 } }],
    };
    expect(viewLayoutChange(before, after, [
      { id: "pan-aaaaaa", viewIds: ["browser-left"], panePresentationViewIds: ["browser-left"] },
      { id: "pan-bbbbbb", viewIds: ["browser-right"], panePresentationViewIds: ["browser-right"] },
    ], 2000, 160)).toEqual({
      moves: [{ viewId: "browser-right", dx: 920 }],
      projectionParticipants: [{ viewId: "browser-right", kind: "projection-snap" }],
      panePresentationTargets: [{ viewId: "browser-right" }],
      paneSettlementParticipants: [{ viewId: "browser-left" }],
    });
  });

  it("equal-size FLOW translation remains a glide without projection participants", () => {
    const before = {
      railPresent: true, station: 50, focusId: "pan-aaaaaa",
      cells: [
        { id: "pan-aaaaaa", rect: { left: 0, top: 0, width: 50, height: 100 } },
        { id: "pan-bbbbbb", rect: { left: 50, top: 0, width: 50, height: 100 } },
      ],
    };
    const after = {
      railPresent: true, station: 50, focusId: "pan-bbbbbb",
      cells: [
        { id: "pan-bbbbbb", rect: { left: 0, top: 0, width: 50, height: 100 } },
        { id: "pan-aaaaaa", rect: { left: 50, top: 0, width: 50, height: 100 } },
      ],
    };
    const change = viewLayoutChange(before, after, [
      { id: "pan-aaaaaa", viewIds: ["browser-left"], panePresentationViewIds: ["browser-left"] },
      { id: "pan-bbbbbb", viewIds: ["browser-right"], panePresentationViewIds: ["browser-right"] },
    ], 2000, 160);
    expect(change.moves).toHaveLength(2);
    expect(change.projectionParticipants).toEqual([]);
  });

  it("a pane rearrangement snaps the native pane owners whose geometry changed, not the focused terminal", () => {
    const before = {
      railPresent: true, station: 50, focusId: "terminal-bottom-right",
      cells: [
        { id: "browser-left", rect: { left: 0, top: 0, width: 50, height: 100 } },
        { id: "browser-top-right", rect: { left: 50, top: 0, width: 50, height: 50 } },
        { id: "terminal-bottom-right", rect: { left: 50, top: 50, width: 50, height: 50 } },
      ],
    };
    const after = {
      railPresent: true, station: 0, focusId: "terminal-bottom-right",
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
      railPresent: true, station: 50, focusId: "pan-bbbbbb",
      cells: [
        { id: "pan-aaaaaa", rect: { left: 0, top: 0, width: 50, height: 100 } },
        { id: "pan-bbbbbb", rect: { left: 50, top: 0, width: 50, height: 100 } },
      ],
    };
    const after = { ...before, station: 0, focusId: "pan-aaaaaa" };
    expect(viewLayoutChange(before, after, [
      { id: "pan-aaaaaa", viewIds: ["browser-left"], panePresentationViewIds: ["browser-left"] },
      { id: "pan-bbbbbb", viewIds: ["browser-right"], panePresentationViewIds: ["browser-right"] },
    ], 2000, 160)).toMatchObject({
      panePresentationTargets: [{ viewId: "browser-left" }],
      paneSettlementParticipants: [{ viewId: "browser-right" }],
    });
  });

  it("rail presence alone snaps every native pane presentation before the width changes", () => {
    const cells = [
      { id: "pan-aaaaaa", rect: { left: 0, top: 0, width: 50, height: 100 } },
      { id: "pan-bbbbbb", rect: { left: 50, top: 0, width: 50, height: 100 } },
    ];
    const before = { railPresent: true, station: 0, focusId: "pan-aaaaaa", cells };
    const after = { ...before, railPresent: false };

    expect(viewLayoutChange(before, after, [
      { id: "pan-aaaaaa", viewIds: ["browser-left"], panePresentationViewIds: ["browser-left"] },
      { id: "pan-bbbbbb", viewIds: ["terminal-right"], panePresentationViewIds: ["terminal-right"] },
    ], 2000, 160)).toMatchObject({
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
