// The public surface of arrangement. The solution is a pure function of (grid, focus), so the
// command's answer must equal the solver result exactly — a divergence means either the screen or
// the contract is wrong.
import { beforeEach, describe, expect, it, vi } from "vitest";
// The description is a key, resolved where the catalogue is read.
import { text, withReaderLanguage } from "../i18n";

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => mem.get(key) ?? null,
  setItem: (key: string, value: string) => void mem.set(key, value),
  removeItem: (key: string) => void mem.delete(key),
  clear: () => mem.clear(),
});
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()), invoke: vi.fn(async () => undefined) }));

import { registerCatalog } from "./catalog";
import { execute, getSpec } from "./registry";
import { projectArrangement, useSessions, type Workspace, type Pane } from "../state/sessions";
import { initialSidebarLayout } from "../state/sidebarLayout";
import { useSectionSets } from "../state/sectionSets";
import { splitLeaf } from "../state/splitTree";
import {
  prepareLayoutChange,
  prepareLayoutMove,
  viewLayoutChange,
  __resetLayoutTransitionHostForTest,
} from "../lib/layoutTransitionHost";
import { __resetLayoutTransitionJournalForTest } from "../lib/layoutTransitionJournal";
import {
  __resetLayoutSettlementForTest,
  layoutSettlementFacts,
  requestedLayoutRevision,
  settleLayout,
} from "../lib/layoutSettlement";
import {
  __resetLayoutTransitionIntentForTest,
  claimLayoutTransitionIntent,
  registerLayoutTransitionIntentHost,
} from "../lib/layoutTransitionIntent";

/** The tab id for that pane. Only the prefix changes from pan- to tab-. */
const tabOf = (paneId: string) => paneId.replace("pan-", "tab-");

const group = (id: string): Pane => ({
  id,
  activeTabId: tabOf(id),
  tabs: [
    { id: tabOf(id), kind: "plugin", title: id, pluginId: "fixture", view: "content" },
  ],
});

function workspace(activePaneId: string): Workspace {
  return {
    id: "wsp-aaaaaa",
    title: "P",
    root: "/tmp/arrangement",
    regionOpen: { left: false, rail: true, right: false },
    railPlacement: { mode: "flow" },
    sidebarLayouts: { left: initialSidebarLayout([]), rail: initialSidebarLayout([]), right: initialSidebarLayout([]) },
    spaces: [
      {
        id: "spc-aaaaaa",
        title: "1",
        activePaneId,
        layout: {
          type: "split",
          id: "spl-aaaaaa",
          dir: "row",
          sizes: [0.5, 0.5],
          children: [splitLeaf(group("pan-aaaaaa")), splitLeaf(group("pan-bbbbbb"))],
        },
      },
    ],
    activeSpaceId: "spc-aaaaaa",
  };
}

registerCatalog();

beforeEach(() => {
  __resetLayoutTransitionHostForTest();
  __resetLayoutTransitionJournalForTest();
  __resetLayoutSettlementForTest();
  __resetLayoutTransitionIntentForTest();
  useSectionSets.setState({ sets: [], byPlugin: {}, left: null });
  const set = useSectionSets.getState().create("fixture rail");
  useSectionSets.getState().arrange(set.id, ["fixture.section"]);
  useSectionSets.getState().link("fixture", "rail", set.id);
  useSessions.setState({ workspaces: [workspace("pan-bbbbbb")], activeId: "wsp-aaaaaa" });
});

describe("layout.arrangement", () => {
  it("answers which pane the rail is grouped with, and which rule chose it", async () => {
    // The rail draws one outline around itself and one pane. Which pane that is came from three
    // rules in order — an explicit binding, the focused pane, then whichever pane is visible — and
    // none of the three was readable from outside. On 2026-08-19 a running window drew the outline
    // around a pane that was not the focused one and there was no way to ask why: the arrangement
    // command answered the station and the cells and said nothing about the grouping.
    //
    // `source` is the difference between a grouping a person chose and one that was left over.
    const answer = (await execute("layout.arrangement", {}, {})) as unknown as {
      ok: boolean;
      data: {
        focusId: string | null;
        relation: {
          boundPaneId: string | null;
          boundTabId: string | null;
          source: string;
          side: string;
          connected: boolean;
          borderMode: string;
          pathCount: number;
        };
      };
    };
    expect(answer.ok).toBe(true);
    expect(answer.data.focusId).toBe("pan-bbbbbb");
    expect(answer.data.relation.boundPaneId).toBe("pan-bbbbbb");
    expect(answer.data.relation.boundTabId).toBe("tab-bbbbbb");
    expect(answer.data.relation.source).toBe("focus");
    expect(answer.data.relation.connected).toBe(true);
  });

  it("groups the rail with the focused pane, and a stored binding does not outrank it", async () => {
    // Measured 2026-08-19 on a running window under PIN: the active pane was pan-ehc264 and the
    // outline was drawn around pan-3557x4, the pane on the other side of the rail. `state.tree`
    // named the reason — a `railBindingTabId` restored from disk, pointing into that pane.
    //
    // Nothing in this build ever writes that field. The preceding implementation kept it equal to
    // the active view through a subscription, and only the reader was carried over — so the rail
    // was grouped with a pane chosen once and never again. The field is deleted rather than given a
    // writer (L11c): no feature here binds a specific view, and one that needs to will bring its
    // own writer.
    useSessions.setState((state) => ({
      workspaces: state.workspaces.map((w) => ({
        ...w,
        spaces: w.spaces.map((c) => ({ ...c, railBindingTabId: "tab-aaaaaa" } as typeof c)),
      })),
    }));
    const answer = (await execute("layout.arrangement", {}, {})) as unknown as {
      data: { focusId: string | null; relation: { boundPaneId: string | null; source: string } };
    };
    expect(answer.data.focusId).toBe("pan-bbbbbb");
    expect(answer.data.relation.boundPaneId).toBe("pan-bbbbbb");
    expect(answer.data.relation.source).toBe("focus");
  });

  it("tab.maximize opens the exact geometry revision before publishing and its transaction consumes the cause", async () => {
    const pinned = {
      ...workspace("pan-bbbbbb"),
      railPlacement: { mode: "pin" as const, station: 50 },
    };
    useSessions.setState({ workspaces: [pinned], activeId: pinned.id });
    const before = projectArrangement(pinned)!;
    const published: Array<{ active: boolean; requested: number; station: number; cells: number }> = [];
    const unsubscribe = useSessions.subscribe((state, previous) => {
      if (state.workspaces[0] === previous.workspaces[0]) return;
      const facts = layoutSettlementFacts("wsp-aaaaaa");
      const arrangement = projectArrangement(state.workspaces[0])!;
      published.push({
        active: facts.active,
        requested: facts.pending[0]?.requested ?? 0,
        station: arrangement.station,
        cells: arrangement.cells.length,
      });
    });

    const result = await execute("tab.maximize", {
      tab: "tab-aaaaaa",
      causeTraceId: "b08/maximize/left",
    }, {});
    unsubscribe();
    expect(result).toMatchObject({ ok: true, data: { tabId: "tab-aaaaaa" } });
    expect(published).toEqual([{ active: true, requested: 1, station: 100, cells: 1 }]);

    const after = projectArrangement(useSessions.getState().workspaces[0])!;
    // **Projection snap is for native surfaces.** Listing every view of a reshaped cell as a
    // participant requests that the framework re-place panes that CSS already follows — those panes are
    // already in position, and the request leaves only a one-frame mismatch. So only the native
    // surfaces the cell actually presents (`panePresentationViewIds`) participate. Here g1 has one.
    const change = viewLayoutChange(before, after, [
      { id: "pan-aaaaaa", viewIds: ["tab-aaaaaa"], panePresentationViewIds: ["tab-aaaaaa"] },
      { id: "pan-bbbbbb", viewIds: ["tab-bbbbbb"], panePresentationViewIds: [] },
    ], 800, 60);
    expect(change).toEqual({
      moves: [],
      projectionParticipants: [{ viewId: "tab-aaaaaa", kind: "projection-snap" }],
      panePresentationTargets: [{ viewId: "tab-aaaaaa" }],
      paneSettlementParticipants: [],
    });
    await (await prepareLayoutChange(change)).commit();
    expect((await execute("layout.transactions", {}, {})).data).toMatchObject({
      entries: [{ causeTraceId: "b08/maximize/left", moves: [] }],
    });
  });

  it("tab.restore opens one geometry revision from station 100 back to the two-pane station 50 layout", async () => {
    const pinned = workspace("pan-aaaaaa");
    pinned.railPlacement = { mode: "pin", station: 50 };
    pinned.spaces[0] = { ...pinned.spaces[0], maximizedTabId: "tab-aaaaaa" };
    useSessions.setState({ workspaces: [pinned], activeId: pinned.id });
    expect(projectArrangement(pinned)).toMatchObject({ station: 100, cells: [{ id: "pan-aaaaaa" }] });

    const published: Array<{ active: boolean; requested: number; station: number; cells: number }> = [];
    const unsubscribe = useSessions.subscribe((state, previous) => {
      if (state.workspaces[0] === previous.workspaces[0]) return;
      const facts = layoutSettlementFacts("wsp-aaaaaa");
      const arrangement = projectArrangement(state.workspaces[0])!;
      published.push({
        active: facts.active,
        requested: facts.pending[0]?.requested ?? 0,
        station: arrangement.station,
        cells: arrangement.cells.length,
      });
    });
    expect(await execute("tab.restore", { workspace: "wsp-aaaaaa" }, {}))
      .toMatchObject({ ok: true, data: { tabId: "tab-aaaaaa" } });
    unsubscribe();
    expect(published).toEqual([{ active: true, requested: 1, station: 50, cells: 2 }]);
  });

  it("tab maximize no-op and missing targets do not open layout revisions", async () => {
    const pinned = workspace("pan-aaaaaa");
    pinned.railPlacement = { mode: "pin", station: 50 };
    pinned.spaces[0] = { ...pinned.spaces[0], maximizedTabId: "tab-aaaaaa" };
    useSessions.setState({ workspaces: [pinned], activeId: pinned.id });

    expect(await execute("tab.maximize", { tab: "tab-aaaaaa", causeTraceId: "b08/no-op" }, {}))
      .toMatchObject({ ok: true });
    expect(await execute("tab.maximize", { tab: "missing", causeTraceId: "b08/missing" }, {}))
      .toMatchObject({ ok: false, code: "TARGET_NOT_FOUND" });
    expect(layoutSettlementFacts("wsp-aaaaaa")).toEqual({ active: false, pending: [] });
    await (await prepareLayoutMove([{ viewId: "tab-aaaaaa", dx: 1 }])).commit();
    expect((await execute("layout.transactions", {}, {})).data).toMatchObject({
      entries: [expect.not.objectContaining({ causeTraceId: expect.any(String) })],
    });
  });

  it("tab.maximize binds the caller cause to the response and to the next layout transaction", async () => {
    const maximized = await execute("tab.maximize", {
      tab: "tab-aaaaaa",
      causeTraceId: "b08/maximize/left",
    }, {});
    expect(maximized).toMatchObject({
      ok: true,
      data: { tabId: "tab-aaaaaa", causeTraceId: "b08/maximize/left" },
    });
    expect(getSpec("tab.maximize")?.params.causeTraceId).toBeDefined();
    expect(getSpec("tab.maximize")?.returns).toContain("causeTraceId?");

    await (await prepareLayoutMove([{ viewId: "tab-aaaaaa", dx: 120 }])).commit();
    expect((await execute("layout.transactions", {}, {})).data).toMatchObject({
      entries: [{ causeTraceId: "b08/maximize/left" }],
    });
  });

  it("tab.maximize invents no cause when it is omitted and rejects an empty cause", async () => {
    const omitted = await execute("tab.maximize", { tab: "tab-aaaaaa" }, {});
    expect(omitted.data).not.toHaveProperty("causeTraceId");
    expect(await execute("tab.maximize", { tab: "tab-aaaaaa", causeTraceId: "" }, {}))
      .toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  });

  it("tab.restore binds the caller cause of the geometry revision to the exact transaction", async () => {
    const maximized = workspace("pan-aaaaaa");
    maximized.spaces[0] = { ...maximized.spaces[0], maximizedTabId: "tab-aaaaaa" };
    useSessions.setState({ workspaces: [maximized], activeId: maximized.id });

    expect(await execute("tab.restore", {
      workspace: "wsp-aaaaaa",
      causeTraceId: "b08/restore/revision8",
    }, {})).toMatchObject({
      ok: true,
      data: { tabId: "tab-aaaaaa", causeTraceId: "b08/restore/revision8" },
    });
    expect(getSpec("tab.restore")?.params.causeTraceId).toBeDefined();
    expect(getSpec("tab.restore")?.returns).toContain("causeTraceId?");

    await (await prepareLayoutMove([])).commit();
    expect((await execute("layout.transactions", {}, {})).data).toMatchObject({
      entries: [{ causeTraceId: "b08/restore/revision8" }],
    });
  });

  it("the returns contract does not promise movesFrom, which the response does not hold", () => {
    expect(getSpec("layout.arrangement")?.returns).not.toContain("movesFrom");
    // The description is a key now — read the sentence, and read both editions, because a promise
    // made in one language and not the other is what a key exists to prevent.
    for (const language of ["en", "ko"] as const) {
      const sentence = withReaderLanguage(language, () => text(getSpec("layout.arrangement")!.description));
      expect(sentence, language).not.toMatch(/move list/i);
    }
  });

  it("exposes a finite layout transaction journal as a command, independent of recording", async () => {
    const prepared = await prepareLayoutMove([{ viewId: "tab-aaaaaa", dx: 120 }]);
    await prepared.commit();
    const result = await execute("layout.transactions", {}, {});
    expect(result).toMatchObject({
      ok: true,
      data: {
        entries: [{
          transactionId: "layout-1",
          phase: "committed",
          domCommittedAtUnixMs: expect.any(Number),
          moves: [{ viewId: "tab-aaaaaa", dx: 120 }],
        }],
      },
    });
    expect(getSpec("layout.transactions")?.returns).toContain("domCommittedAtUnixMs");
    expect(getSpec("layout.transactions")?.returns).toContain("candidateAttempts");
    expect(getSpec("layout.transactions")?.returns).toContain("callbackObservedAtUnixUs");
    expect(getSpec("layout.transactions")?.returns).toContain("documentTimelineBridge");
    expect(getSpec("layout.transactions")?.returns).toContain("display-callback-wall-bridge");
    expect(getSpec("layout.transactions")?.returns).toContain("armCompletedAtUnixUs");
    expect(getSpec("layout.transactions")?.returns).toContain("armStartedAtUnixUs");
    expect(getSpec("layout.transactions")?.returns).toContain("armDurationUs");
    expect(getSpec("layout.transactions")?.returns).toContain("expectedDocumentStartTime");
    expect(getSpec("layout.transactions")?.returns).toContain("stagedTargets");
    expect(getSpec("layout.transactions")?.returns).toContain("panePresentationTargets");
    expect(getSpec("layout.transactions")?.returns).toContain("paneSettlementParticipants");
    expect(getSpec("layout.transactions")?.returns).toContain("settlement:{ownerKey,revision,status:'pending'|'settled'|'failed'|'cancelled'}");
    expect(getSpec("layout.transactions")?.returns).toContain("phase:'preparing'");
    expect(getSpec("layout.transactions")?.returns).toContain("openedAtUnixMs");
    expect(getSpec("layout.transactions")?.returns).toContain("stagedTargetsStatus:'pending'|'declared'");
    expect(getSpec("layout.transactions")?.returns).toContain("presentationStart");
    expect(getSpec("layout.transactions")?.returns).toContain("sourceGeneration");
    expect(getSpec("layout.transactions")?.returns).toContain("frameSequence");
  });

  it("layout.transaction.wait ACKs the terminal transaction of the exact cause without polling", async () => {
    expect(getSpec("layout.transaction.wait")).toMatchObject({
      params: expect.objectContaining({
        causeTraceId: expect.anything(),
        afterSequence: expect.anything(),
        timeoutMs: expect.anything(),
      }),
    });
    const waiting = execute("layout.transaction.wait", {
      causeTraceId: "cause-command",
      afterSequence: 0,
      timeoutMs: 1_000,
    }, {});
    const journal = await import("../lib/layoutTransitionJournal");
    journal.declareLayoutCause("cause-command");
    const prepared = await prepareLayoutMove([{ viewId: "tab-aaaaaa", dx: 120 }]);
    await prepared.commit();

    await expect(waiting).resolves.toMatchObject({
      ok: true,
      data: {
        causeStatus: "exact",
        entry: {
          causeTraceId: "cause-command",
          transactionId: expect.any(String),
          phase: "committed",
        },
      },
    });
  });

  it("exposes the solver answer unchanged — command and screen use the same computation", async () => {
    const result = await execute("layout.arrangement", {}, {});
    expect(result.ok).toBe(true);
    const solved = projectArrangement(useSessions.getState().workspaces[0])!;
    const data = result.data as {
      station: number;
      switched: boolean;
      cleanLines: number[];
      cells: Array<{ id: string; railSide: string }>;
    };
    expect(data.station).toBe(solved.station);
    expect(data.cleanLines).toEqual(solved.cleanLines);
    expect(data.switched).toBe(solved.swapped);
    expect(data.cells.map((cell) => cell.id)).toEqual(solved.cells.map((cell) => cell.id));
  });

  it("focus is the station input — activating another pane moves the answer", async () => {
    const at = (await execute("layout.arrangement", {}, {})) as { data?: { station: number } };
    expect(at.data?.station).toBe(50); // g2 focus

    useSessions.getState().setActiveGroup("wsp-aaaaaa", "pan-aaaaaa");
    const moved = (await execute("layout.arrangement", {}, {})) as { data?: { station: number } };
    expect(moved.data?.station).toBe(0);
  });

  it("tab.activate on another pane publishes synchronously the layout revision WorkspacePlane ACKs", async () => {
    expect(layoutSettlementFacts("wsp-aaaaaa")).toEqual({ active: false, pending: [] });

    await expect(execute("tab.activate", { tab: "tab-aaaaaa" }, {})).resolves.toMatchObject({
      ok: true,
      data: { tabId: "tab-aaaaaa" },
    });

    expect(layoutSettlementFacts("wsp-aaaaaa")).toEqual({
      active: true,
      pending: [{ key: "wsp-aaaaaa", requested: 1, settled: 0 }],
    });
  });

  // Presentation identity and layout geometry are separate facts. A caller waits for a layout
  // transaction only when layoutMoved is true and otherwise waits for the target DOM commit.
  it("tab.activate separates active-chain change from layout movement", async () => {
    const moving = (await execute(
      "tab.activate",
      { tab: "tab-aaaaaa", causeTraceId: "b08/activate/moved" },
      {},
    )) as { data?: { changed?: boolean; layoutMoved?: boolean; causeTraceId?: string } };
    expect(moving.data?.changed, "activating another pane changes the active chain").toBe(true);
    expect(moving.data?.layoutMoved, "FLOW moves the rail geometry to the other pane").toBe(true);
    expect(moving.data?.causeTraceId).toBe("b08/activate/moved");

    // The same tab again changes neither presentation nor geometry, so no cause is answered.
    const still = (await execute(
      "tab.activate",
      { tab: "tab-aaaaaa", causeTraceId: "b08/activate/still" },
      {},
    )) as { data?: { changed?: boolean; layoutMoved?: boolean; causeTraceId?: string } };
    expect(still.data?.changed, "activating the active tab changes nothing").toBe(false);
    expect(still.data?.layoutMoved, "an idempotent activation moves no geometry").toBe(false);
    expect(still.data?.causeTraceId, "no transaction exists to find this cause on").toBeUndefined();
  });

  it("tab.activate refuses an empty cause rather than stamping one nothing can be found by", async () => {
    await expect(execute("tab.activate", { tab: "tab-aaaaaa", causeTraceId: "" }, {}))
      .resolves.toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  });

  it("a tab switch inside the same pane and a failed activation open no geometry revision", async () => {
    const fixture = workspace("pan-bbbbbb");
    const g2 = fixture.spaces[0].layout.type === "split"
      ? fixture.spaces[0].layout.children[1]
      : null;
    if (!g2 || g2.type !== "leaf") throw new Error("g2 fixture missing");
    g2.value.tabs.push({
      id: "v-g2-second",
      kind: "plugin",
      title: "g2 second",
      pluginId: "fixture",
      view: "content",
    });
    useSessions.setState({ workspaces: [fixture], activeId: "wsp-aaaaaa" });

    await expect(execute(
      "tab.activate",
      { tab: "v-g2-second", causeTraceId: "same-pane/no-layout" },
      {},
    )).resolves.toMatchObject({
      ok: true,
      data: {
        changed: true,
        layoutMoved: false,
        tabId: "v-g2-second",
      },
    });
    await expect(execute("tab.activate", { tab: "missing" }, {})).resolves.toMatchObject({
      ok: false,
      code: "TARGET_NOT_FOUND",
    });
    expect(layoutSettlementFacts("wsp-aaaaaa")).toEqual({ active: false, pending: [] });
  });

  it("tab.activate completes the active space, pane, and tab chain", async () => {
    const fixture = workspace("pan-aaaaaa");
    const hidden = structuredClone(fixture.spaces[0]);
    hidden.id = "spc-hidden";
    hidden.activePaneId = "pan-hidden";
    hidden.layout = splitLeaf(group("pan-hidden"));
    fixture.spaces.push(hidden);
    useSessions.setState({ workspaces: [fixture], activeId: fixture.id });

    await expect(execute("tab.activate", { tab: "tab-hidden" }, {})).resolves.toMatchObject({
      ok: true,
      data: { changed: true, tabId: "tab-hidden" },
    });
    const landed = useSessions.getState();
    expect(landed.activeId).toBe(fixture.id);
    expect(landed.workspaces[0].activeSpaceId).toBe("spc-hidden");
    expect(landed.workspaces[0].spaces[1].activePaneId).toBe("pan-hidden");
    expect(
      landed.workspaces[0].spaces[1].layout.type === "leaf"
        ? landed.workspaces[0].spaces[1].layout.value.activeTabId
        : null,
    ).toBe("tab-hidden");
  });

  it("a same-pane activation cause cannot leak into a later layout transaction", async () => {
    const fixture = workspace("pan-bbbbbb");
    const g2 = fixture.spaces[0].layout.type === "split"
      ? fixture.spaces[0].layout.children[1]
      : null;
    if (!g2 || g2.type !== "leaf") throw new Error("g2 fixture missing");
    g2.value.tabs.push({
      id: "v-g2-second",
      kind: "plugin",
      title: "g2 second",
      pluginId: "fixture",
      view: "content",
    });
    useSessions.setState({ workspaces: [fixture], activeId: fixture.id });

    await execute("tab.activate", {
      tab: "v-g2-second",
      causeTraceId: "same-pane/must-not-leak",
    }, {});
    await execute("pane.activate", { pane: "pan-aaaaaa" }, {});

    const journal = await import("../lib/layoutTransitionJournal");
    expect(journal.layoutTransitionJournal().at(-1)?.causeTraceId).toBeUndefined();
  });

  it("cross-pane activation under PIN changes focus only and opens no geometry revision", async () => {
    const fixture = workspace("pan-bbbbbb");
    fixture.railPlacement = { mode: "pin", station: 50 };
    useSessions.setState({ workspaces: [fixture], activeId: "wsp-aaaaaa" });

    await expect(execute("tab.activate", { tab: "tab-aaaaaa" }, {})).resolves.toMatchObject({ ok: true });
    expect(layoutSettlementFacts("wsp-aaaaaa")).toEqual({ active: false, pending: [] });
  });

  it("pane.activate under FLOW also opens exactly one geometry revision", async () => {
    await expect(execute("pane.activate", { pane: "pan-aaaaaa" }, {})).resolves.toMatchObject({ ok: true });
    expect(layoutSettlementFacts("wsp-aaaaaa")).toEqual({
      active: true,
      pending: [{ key: "wsp-aaaaaa", requested: 1, settled: 0 }],
    });
  });

  it("the geometry revision is open before the store subscriber renders the new WorkspacePlane", async () => {
    const observed: ReturnType<typeof layoutSettlementFacts>[] = [];
    const unsubscribe = useSessions.subscribe(() => {
      observed.push(layoutSettlementFacts("wsp-aaaaaa"));
      // The same ACK boundary as WorkspacePlane's layout effect. If the revision opens after the
      // store publish, this ACK closes an empty ledger and the real revision stays pending forever.
      settleLayout("wsp-aaaaaa", requestedLayoutRevision("wsp-aaaaaa"));
    });
    try {
      await expect(execute("tab.activate", { tab: "tab-aaaaaa" }, {})).resolves.toMatchObject({ ok: true });
    } finally {
      unsubscribe();
    }

    expect(observed[0]).toEqual({
      active: true,
      pending: [{ key: "wsp-aaaaaa", requested: 1, settled: 0 }],
    });
    expect(layoutSettlementFacts("wsp-aaaaaa")).toEqual({ active: false, pending: [] });
  });

  it("a FLOW geometry intent starts the adapter prepare before the new workspace subscriber", async () => {
    const order: string[] = [];
    registerLayoutTransitionIntentHost("wsp-aaaaaa", {
      prepare: async () => {
        order.push("prepare");
        return {
          transactionId: "layout-intent",
          mode: "glide",
          requiresSharedStart: true,
          stagedTargets: [],
          start: async () => null,
          commit: async () => {},
          cancel: vi.fn(),
        };
      },
    });
    const unsubscribe = useSessions.subscribe(() => order.push("state-publish"));
    try {
      await expect(execute("tab.activate", { tab: "tab-aaaaaa" }, {})).resolves.toMatchObject({ ok: true });
    } finally {
      unsubscribe();
    }

    expect(order.slice(0, 2)).toEqual(["prepare", "state-publish"]);
    await expect(claimLayoutTransitionIntent("wsp-aaaaaa", 1)).resolves.toMatchObject({
      transactionId: "layout-intent",
    });
  });

  it("only the panes the rail crosses change railSide — width never changes", async () => {
    const before = (await execute("layout.arrangement", {}, {})) as {
      data?: { cells: Array<{ id: string; railSide: string; rect: { width: number } }> };
    };
    useSessions.getState().setActiveGroup("wsp-aaaaaa", "pan-aaaaaa");
    const after = (await execute("layout.arrangement", {}, {})) as {
      data?: { cells: Array<{ id: string; railSide: string; rect: { width: number } }> };
    };
    const side = (
      d: { cells: Array<{ id: string; railSide: string }> } | undefined,
      id: string,
    ) => d?.cells.find((cell) => cell.id === id)?.railSide;
    expect(side(before.data, "pan-aaaaaa")).toBe("before");
    expect(side(after.data, "pan-aaaaaa")).toBe("after"); // the rail crossed g1
    expect(side(before.data, "pan-bbbbbb")).toBe("after");
    expect(side(after.data, "pan-bbbbbb")).toBe("after"); // unrelated — no move
    for (const id of ["pan-aaaaaa", "pan-bbbbbb"]) {
      expect(after.data?.cells.find((c) => c.id === id)?.rect.width).toBe(
        before.data?.cells.find((c) => c.id === id)?.rect.width,
      );
    }
  });
});

// The live gate verifies that structural-change responses enclose the arrangement
// (scripts/e2e/slot-freeze.mjs): split and merge require the real view registry, so in the jsdom
// fixture the command drops to INTERNAL — rather than weakening the contract, it is judged in the
// real app.
