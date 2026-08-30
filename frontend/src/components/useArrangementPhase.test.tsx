// @vitest-environment jsdom
// Arrangement phase — a changed solution holds the previous one as the travel origin, and lands
// RAIL_TRAVEL_MS later. One phase tracker is the core of the contract: even when switching and
// travel overlap in one click, the origin is one.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { redeliverViewFocusIfLost } = vi.hoisted(() => ({
  redeliverViewFocusIfLost: vi.fn(),
}));
vi.mock("../plugins/viewFocus", () => ({ redeliverViewFocusIfLost }));

import type { SplitTree } from "../state/splitTree";
import { arrangementMoves, solveArrangement, type Arrangement } from "../lib/railArrangement";
import { RAIL_TRAVEL_MS } from "../lib/railMotion";
import { railGeometryScopeId } from "../lib/railMotion";
import { presentationNowUnixUs } from "../lib/presentationClock";
import { useArrangementPhase } from "./useArrangementPhase";
import type { PreparedLayoutTransition } from "../lib/layoutTransitionHost";
import {
  __resetLayoutTransitionHostForTest,
  prepareLayoutMove,
  registerLayoutTransitionHost,
} from "../lib/layoutTransitionHost";
import type { LayoutPresentationStart } from "../lib/layoutPresentationCoordinator";
import type { LayoutPresentationCandidateParticipant } from "../lib/layoutPresentationCandidateCoordinator";
import {
  __resetLayoutSettlementForTest,
  invalidateLayout,
  layoutSettlementFacts,
  settleLayout,
} from "../lib/layoutSettlement";
import {
  __resetLayoutTransitionJournalForTest,
  layoutTransitionJournal,
} from "../lib/layoutTransitionJournal";
import {
  __resetLayoutArrangementPhasesForTest,
  layoutArrangementPhaseFacts,
} from "../lib/layoutArrangementPhase";
import {
  __resetLayoutTransitionIntentForTest,
  layoutTransitionIntentFacts,
  publishLayoutTransitionIntent,
  registerLayoutTransitionIntentHost,
} from "../lib/layoutTransitionIntent";

type G = { id: string; content?: string };
const leaf = (id: string, content?: string): SplitTree<G> => ({ type: "leaf", value: { id, content } });
const twoColumns: SplitTree<G> = {
  type: "split",
  id: "r",
  dir: "row",
  sizes: [0.5, 0.5],
  children: [leaf("a"), leaf("b")],
};
const threeColumns: SplitTree<G> = {
  type: "split",
  id: "r",
  dir: "row",
  sizes: [1 / 3, 1 / 3, 1 / 3],
  children: [leaf("a"), leaf("b"), leaf("c")],
};

const solve = (layout: SplitTree<G>, focusId: string) =>
  solveArrangement<G>({
    layout,
    focusId,
    placement: { mode: "flow" },
    railOpen: true,
  });
const valuesOf = (tree: SplitTree<G>): G[] => tree.type === "leaf"
  ? [tree.value]
  : tree.children.flatMap(valuesOf);

function Probe({
  arrangement,
  scopeId,
  contentKey = "",
  onPhase,
  canGlide,
  prepareTravel,
  settlementKey,
  domCandidateParticipant,
}: {
  arrangement: Arrangement<G>;
  scopeId: string;
  contentKey?: string;
  onPhase?: (rebase: () => void) => void;
  canGlide?: () => boolean;
  prepareTravel?: (
    from: Arrangement<G>,
    to: Arrangement<G>,
  ) => Promise<PreparedLayoutTransition>;
  settlementKey?: string;
  domCandidateParticipant?: LayoutPresentationCandidateParticipant;
}) {
  const phase = useArrangementPhase(
    arrangement,
    scopeId,
    contentKey,
    canGlide,
    prepareTravel,
    settlementKey,
    domCandidateParticipant,
  );
  onPhase?.(phase.rebase);
  return (
    <div
      data-testid="p"
      data-traveling={phase.traveling ? "1" : "0"}
      data-moves={phase.moves.map((m) => m.id).join(",")}
      data-station={String(phase.displayed?.station ?? "")}
      data-rail-present={phase.displayed?.railPresent ? "1" : "0"}
      data-content={String(phase.displayed === arrangement ? "live" : "stale")}
      data-values={phase.displayed ? valuesOf(phase.displayed.displayLayout).map((value) => `${value.id}:${value.content ?? ""}`).join("|") : ""}
      data-glide={phase.glide ? "1" : "0"}
      data-preparing={phase.preparing ? "1" : "0"}
      data-starting={phase.starting ? "1" : "0"}
      data-replacing={phase.replacing ? "1" : "0"}
      data-start={phase.startAtUnixUs == null ? "" : String(phase.startAtUnixUs)}
    />
  );
}

let host: HTMLElement;
let root: Root;
const scopeOf = (a: Arrangement<G>) => railGeometryScopeId("c1", a.cleanLines);
const el = () => host.querySelector<HTMLElement>("[data-testid=p]")!;
let transitionSequence = 1;
const presentationStartReceipt = (
  transactionId: string,
  startAtUnixUs: number,
  sourceGeneration = 1,
  frameSequence = 1,
): LayoutPresentationStart => {
  const candidate = {
    transactionId, producer: "display-callback" as const, clock: "unix-anchored-monotonic" as const,
    sourceGeneration, frameSequence,
    commandReceivedAtUnixUs: startAtUnixUs - 10_000,
    installedAtUnixUs: startAtUnixUs - 9_000,
    callbackReceivedAtUnixUs: 9_000_000_000_000_000,
    callbackObservedAtUnixMs: startAtUnixUs / 1_000 - 8,
    callbackObservedAtUnixUs: startAtUnixUs - 8_000,
    startAtUnixUs, durationMs: RAIL_TRAVEL_MS,
    documentTimelineBridge: {
      producer: "display-callback-wall-bridge" as const,
      clock: "unix-wall" as const,
      callbackObservedAtUnixUs: startAtUnixUs - 8_000,
      startAtUnixUs,
    },
  };
  return {
    ...candidate,
    candidateAttempts: [{
      attempt: 1, candidate,
      armAcknowledgedParticipantIds: ["dom-layout"], armFailures: [],
      armClock: "unix-anchored-monotonic", armStartedAtUnixUs: startAtUnixUs - 6_000,
      armCompletedAtUnixUs: startAtUnixUs - 2_000, armDurationUs: 4_000,
      acceptance: "accepted", acceptedAtUnixUs: startAtUnixUs - 1_000, remainingLeadMs: 1,
      disarmedParticipantIds: [], disarmFailures: [], releasedParticipantIds: ["dom-layout"],
      releaseFailures: [], rolledBackParticipantIds: [], rollbackFailures: [],
    }],
  };
};
const transition = (
  mode: "glide" | "snap",
  commit: () => Promise<void> = async () => {},
  cancel: () => void = () => {},
): PreparedLayoutTransition => ({
  transactionId: `layout-test-${transitionSequence++}`,
  mode,
      requiresSharedStart: false,
      stagedTargets: [],
  start: async () => null,
  commit,
  cancel,
});

beforeEach(() => {
  vi.useFakeTimers();
  __resetLayoutSettlementForTest();
  __resetLayoutTransitionHostForTest();
  __resetLayoutTransitionJournalForTest();
  __resetLayoutArrangementPhasesForTest();
  __resetLayoutTransitionIntentForTest();
  redeliverViewFocusIfLost.mockClear();
  transitionSequence = 1;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("useArrangementPhase", () => {
  it("a React render claims the intent transaction already started at the same revision and does not call fallback prepare again", async () => {
    const at = solve(twoColumns, "a");
    const to = solve(twoColumns, "b");
    const intentPrepared = transition("glide");
    const fallback = vi.fn(async () => transition("glide"));
    registerLayoutTransitionIntentHost("workspace-intent", {
      prepare: async () => intentPrepared,
    });
    act(() => root.render(
      <Probe arrangement={at} scopeId={scopeOf(at)} prepareTravel={fallback} settlementKey="workspace-intent" />,
    ));
    const revision = invalidateLayout("workspace-intent");
    expect(publishLayoutTransitionIntent({
      ownerKey: "workspace-intent",
      revision,
      from: at,
      to,
    })).toBe(true);

    act(() => root.render(
      <Probe arrangement={to} scopeId={scopeOf(to)} prepareTravel={fallback} settlementKey="workspace-intent" />,
    ));
    await act(async () => {});

    expect(fallback).not.toHaveBeenCalled();
  });

  it("no next-revision prepare starts before the running glide lands visually; after the landing ACK only the newest target starts", async () => {
    const at = solve(twoColumns, "a");
    const to = solve(twoColumns, "b");
    const first = transition("glide");
    const second = transition("glide");
    const prepare = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    registerLayoutTransitionIntentHost("workspace-serialized", { prepare });
    act(() => root.render(
      <Probe arrangement={at} scopeId={scopeOf(at)} settlementKey="workspace-serialized" />,
    ));

    const firstRevision = invalidateLayout("workspace-serialized");
    publishLayoutTransitionIntent({
      ownerKey: "workspace-serialized",
      revision: firstRevision,
      from: at,
      to,
    });
    act(() => root.render(
      <Probe arrangement={to} scopeId={scopeOf(to)} settlementKey="workspace-serialized" />,
    ));
    await act(async () => {});
    expect(el().dataset.traveling).toBe("1");
    expect(prepare).toHaveBeenCalledTimes(1);

    const secondRevision = invalidateLayout("workspace-serialized");
    publishLayoutTransitionIntent({
      ownerKey: "workspace-serialized",
      revision: secondRevision,
      from: to,
      to: at,
    });
    act(() => root.render(
      <Probe arrangement={at} scopeId={scopeOf(at)} settlementKey="workspace-serialized" />,
    ));
    await act(async () => {});
    expect(prepare).toHaveBeenCalledTimes(1);

    await act(async () => { vi.advanceTimersByTime(RAIL_TRAVEL_MS); });
    expect(prepare).toHaveBeenCalledTimes(2);
    await act(async () => {});
    expect(el().dataset.traveling).toBe("1");
  });
  it("the geometry publish opens the cause transaction in the same layout commit and records preparation ownership before paint", () => {
    const at = solve(twoColumns, "a");
    const to = solve(twoColumns, "b");
    registerLayoutTransitionHost({
      prepareChange: vi.fn(() => new Promise<PreparedLayoutTransition>(() => {})),
    });
    const prepareTravel = () => prepareLayoutMove([{ viewId: "a", dx: -160 }]);
    act(() => root.render(
      <Probe arrangement={at} scopeId={scopeOf(at)} prepareTravel={prepareTravel} />,
    ));

    act(() => flushSync(() => root.render(
      <Probe arrangement={to} scopeId={scopeOf(to)} prepareTravel={prepareTravel} />,
    )));

    expect(layoutTransitionJournal()).toMatchObject([{
      transactionId: "layout-1",
      phase: "preparing",
      mode: null,
      moves: [{ viewId: "a", dx: -160 }],
    }]);
    expect(el().dataset.preparing).toBe("1");
  });

  it("returning to a failed target after leaving it opens a new prepare at a new revision", async () => {
    const right = solve(twoColumns, "b");
    const left = solve(twoColumns, "a");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const prepareTravel = vi.fn()
      .mockRejectedValueOnce(new Error("first left prepare failed"))
      .mockResolvedValueOnce(transition("snap"));

    act(() => root.render(
      <Probe
        arrangement={right}
        scopeId={scopeOf(right)}
        prepareTravel={prepareTravel}
        settlementKey="workspace-retry"
      />,
    ));

    invalidateLayout("workspace-retry");
    act(() => root.render(
      <Probe
        arrangement={left}
        scopeId={scopeOf(left)}
        prepareTravel={prepareTravel}
        settlementKey="workspace-retry"
      />,
    ));
    await act(async () => {});
    expect(prepareTravel).toHaveBeenCalledTimes(1);
    expect(layoutSettlementFacts("workspace-retry").active).toBe(true);
    expect(layoutArrangementPhaseFacts()).toEqual([{
      ownerKey: "workspace-retry",
      current: { focusId: "a", station: left.station, key: expect.any(String) },
      displayed: { focusId: "b", station: right.station, key: expect.any(String) },
      phase: "blocked",
      preparationTargetKey: expect.any(String),
      lastFailure: {
        message: "first left prepare failed",
        targetKey: expect.any(String),
      },
    }]);

    act(() => root.render(
      <Probe
        arrangement={right}
        scopeId={scopeOf(right)}
        prepareTravel={prepareTravel}
        settlementKey="workspace-retry"
      />,
    ));
    await act(async () => {});
    expect(layoutSettlementFacts("workspace-retry")).toEqual({ active: false, pending: [] });
    expect(layoutArrangementPhaseFacts()[0]).toMatchObject({
      current: { focusId: "b" },
      displayed: { focusId: "b" },
      phase: "idle",
      preparationTargetKey: null,
    });

    invalidateLayout("workspace-retry");
    act(() => root.render(
      <Probe
        arrangement={left}
        scopeId={scopeOf(left)}
        prepareTravel={prepareTravel}
        settlementKey="workspace-retry"
      />,
    ));
    await act(async () => {});

    expect(prepareTravel).toHaveBeenCalledTimes(2);
    expect(layoutSettlementFacts("workspace-retry")).toEqual({ active: false, pending: [] });
    error.mockRestore();
  });

  it("a state commit with unchanged geometry still ACKs the newest layout revision", () => {
    const at = solve(twoColumns, "a");
    act(() => root.render(
      <Probe arrangement={at} scopeId={scopeOf(at)} settlementKey="workspace-1" />,
    ));

    invalidateLayout("workspace-1");
    expect(layoutSettlementFacts().active).toBe(true);

    // As in PIN mode the geometry signature of the solution is identical, but an external state
    // commit re-renders App.
    act(() => root.render(
      <Probe arrangement={at} scopeId={scopeOf(at)} settlementKey="workspace-1" />,
    ));
    expect(layoutSettlementFacts()).toEqual({ active: false, pending: [] });
  });

  it("a solution that changed only focus is accepted immediately — unchanged geometry still gives a new solution", () => {
    // The phase animates geometry only but holds **the whole solution.** Consumers read the facts
    // the focus determines from that solution (binding, wedged pane, swap adjacency). If the
    // signature covers geometry only, a focus-only change reads as "the same" and never arrives,
    // and those facts stay at the old values forever.
    //
    // Measured 2026-08-02: ① moving focus in travel mode (nothing moves, by definition) leaves the
    // wedged pane idle; ② activating a pane already beside the rail keeps the binding on the old
    // pane, so the border width never returns. When the bottom row is full width the only clean
    // vertical lines are 0 and 100 — the rail has nowhere to go. Without a pull
    // (pullFocused:false) the pane does not move either. Hence two solutions differing in focus only.
    const stack: SplitTree<G> = {
      type: "split",
      id: "c",
      dir: "col",
      sizes: [0.5, 0.5],
      children: [threeColumns, leaf("d")],
    };
    const still = (focusId: string) =>
      solveArrangement<G>({
        layout: stack,
        focusId,
        placement: { mode: "flow" },
        railOpen: true,
        pullFocused: false,
      });
    const at = still("a");
    const to = still("c");
    expect(to.cells.map((c) => `${c.id}@${c.rect.left}`)).toEqual(
      at.cells.map((c) => `${c.id}@${c.rect.left}`),
    );
    expect(to.station).toBe(at.station);
    expect(to.focusId).not.toBe(at.focusId);

    act(() => root.render(<Probe arrangement={at} scopeId={scopeOf(at)} />));
    act(() => root.render(<Probe arrangement={to} scopeId={scopeOf(to)} />));
    // Not a travel (nothing to move) — so it must be current with no wait.
    expect(el().dataset.traveling).toBe("0");
    expect(el().dataset.content).toBe("live");
  });

  it("a rail-presence-only solution replaces the displayed transaction", () => {
    // At the leading clean line both solves have station 0 and identical cells. Presence still
    // changes visible geometry by a full rail width. Leaving it out of the phase identity kept a
    // linked set on screen after unlinking until some unrelated geometry changed.
    const standing = solve(twoColumns, "a");
    const absent = solveArrangement<G>({
      layout: twoColumns,
      focusId: "a",
      placement: { mode: "flow" },
      railOpen: false,
    });
    expect(standing.station).toBe(absent.station);
    expect(standing.cells).toEqual(absent.cells);

    act(() => root.render(<Probe arrangement={standing} scopeId={scopeOf(standing)} />));
    expect(el().dataset.railPresent).toBe("1");
    act(() => root.render(<Probe arrangement={absent} scopeId={scopeOf(absent)} />));

    expect(el().dataset.railPresent).toBe("0");
    expect(el().dataset.content).toBe("live");
  });

  it("a maximize projection delta with zero translation still prepares the target before adopting it", async () => {
    const at = solve(twoColumns, "a");
    const maximized = solveArrangement<G>({
      layout: twoColumns,
      focusId: "a",
      maximizedId: "a",
      placement: { mode: "flow" },
      railOpen: true,
    });
    const commit = vi.fn(async () => {});
    const start = vi.fn(async () => null);
    const prepareTravel = vi.fn(async (): Promise<PreparedLayoutTransition> => ({
      ...transition("snap", commit, vi.fn()),
      requiresSharedStart: false,
      start,
    }));
    expect(arrangementMoves(at, maximized)).toEqual([]);
    act(() => root.render(
      <Probe arrangement={at} scopeId={scopeOf(at)} prepareTravel={prepareTravel} />,
    ));
    act(() => root.render(
      <Probe arrangement={maximized} scopeId={scopeOf(maximized)} prepareTravel={prepareTravel} />,
    ));
    await act(async () => {});
    expect(prepareTravel).toHaveBeenCalledWith(at, maximized);
    expect(start).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledOnce();
    expect(el().dataset.station).toBe(String(maximized.station));
  });

  it("a changed solution travels with only the moving panes and lands RAIL_TRAVEL_MS later", () => {
    const at = solve(twoColumns, "a");
    const to = solve(twoColumns, "b");
    act(() => root.render(<Probe arrangement={at} scopeId={scopeOf(at)} />));
    expect(el().dataset.traveling).toBe("0");

    act(() => root.render(<Probe arrangement={to} scopeId={scopeOf(to)} />));
    expect(el().dataset.traveling).toBe("1");
    expect(el().dataset.moves).toBe("a"); // only the panes the rail crossed
    expect(redeliverViewFocusIfLost).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(RAIL_TRAVEL_MS + 10));
    expect(el().dataset.traveling).toBe("0");
    // Input focus dropped by the rearrangement is redelivered once at landing.
    expect(redeliverViewFocusIfLost).toHaveBeenCalledTimes(1);
  });

  it("the DOM solution does not change before adapter preparation ends, and a snap settles in one step after preparation", async () => {
    const at = solve(twoColumns, "a");
    const to = solve(twoColumns, "b");
    let finish!: (prepared: PreparedLayoutTransition) => void;
    const prepareTravel = vi.fn(
      () => new Promise<PreparedLayoutTransition>((resolve) => { finish = resolve; }),
    );
    const commit = vi.fn(async () => {});
    const cancel = vi.fn();
    act(() => root.render(
      <Probe arrangement={at} scopeId={scopeOf(at)} prepareTravel={prepareTravel} />,
    ));
    act(() => root.render(
      <Probe arrangement={to} scopeId={scopeOf(to)} prepareTravel={prepareTravel} />,
    ));

    expect(prepareTravel).toHaveBeenCalledWith(at, to);
    expect(el().dataset.preparing).toBe("1");
    expect(el().dataset.traveling).toBe("0");
    expect(el().dataset.content).toBe("stale");

    await act(async () => finish(transition("snap", commit, cancel)));
    expect(el().dataset.preparing).toBe("0");
    expect(el().dataset.traveling).toBe("0");
    expect(el().dataset.content).toBe("live");
    expect(commit).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("the snap target DOM commit is declared a structural swap until the external projection commit closes", async () => {
    const at = solve(twoColumns, "a");
    const to = solve(threeColumns, "c");
    let finishPrepare!: (prepared: PreparedLayoutTransition) => void;
    let finishCommit!: () => void;
    const commit = vi.fn(() => new Promise<void>((resolve) => {
      finishCommit = resolve;
    }));
    const prepareTravel = vi.fn(() => new Promise<PreparedLayoutTransition>((resolve) => {
      finishPrepare = resolve;
    }));

    act(() => root.render(
      <Probe arrangement={at} scopeId="structural-snap" prepareTravel={prepareTravel} />,
    ));
    act(() => root.render(
      <Probe arrangement={to} scopeId="structural-snap" prepareTravel={prepareTravel} />,
    ));
    expect(el().dataset.replacing).toBe("0");

    await act(async () => finishPrepare(transition("snap", commit)));
    expect(el().dataset.replacing).toBe("1");
    expect(commit).toHaveBeenCalledTimes(1);

    await act(async () => finishCommit());
    expect(el().dataset.replacing).toBe("0");
  });

  it("a layout revision settles only after the target DOM and then the surface commit ACK have both finished", async () => {
    const at = solve(twoColumns, "a");
    const to = solve(twoColumns, "b");
    let releaseCommit!: () => void;
    const commit = vi.fn(() => new Promise<void>((resolve) => { releaseCommit = resolve; }));
    const prepareTravel = vi.fn(async (): Promise<PreparedLayoutTransition> =>
      transition("snap", commit, vi.fn()));
    act(() => root.render(
      <Probe
        arrangement={at}
        scopeId={scopeOf(at)}
        prepareTravel={prepareTravel}
        settlementKey="workspace-commit"
      />,
    ));

    invalidateLayout("workspace-commit");
    act(() => root.render(
      <Probe
        arrangement={to}
        scopeId={scopeOf(to)}
        prepareTravel={prepareTravel}
        settlementKey="workspace-commit"
      />,
    ));
    await act(async () => {});

    expect(commit).toHaveBeenCalledTimes(1);
    expect(layoutSettlementFacts("workspace-commit").active).toBe(true);
    await act(async () => releaseCommit());
    expect(layoutSettlementFacts("workspace-commit")).toEqual({ active: false, pending: [] });
  });

  it("a committed snap restore settles once, at the exact revision where current/displayed and the presentation commit are closed", async () => {
    const restored = solve(twoColumns, "a");
    const maximized = solveArrangement<G>({
      layout: twoColumns,
      focusId: "a",
      maximizedId: "a",
      placement: { mode: "flow" },
      railOpen: true,
    });
    const commits: string[] = [];
    const prepareTravel = vi.fn(async (
      _from: Arrangement<G>,
      to: Arrangement<G>,
    ): Promise<PreparedLayoutTransition> => transition("snap", async () => {
      commits.push(to.maximizedId ? "maximize" : "restore");
    }));
    act(() => root.render(
      <Probe
        arrangement={restored}
        scopeId={scopeOf(restored)}
        prepareTravel={prepareTravel}
        settlementKey="workspace-restore"
      />,
    ));

    invalidateLayout("workspace-restore");
    act(() => root.render(
      <Probe
        arrangement={maximized}
        scopeId={scopeOf(maximized)}
        prepareTravel={prepareTravel}
        settlementKey="workspace-restore"
      />,
    ));
    await act(async () => {});
    expect(layoutSettlementFacts("workspace-restore")).toEqual({ active: false, pending: [] });

    invalidateLayout("workspace-restore");
    act(() => root.render(
      <Probe
        arrangement={restored}
        scopeId={scopeOf(restored)}
        prepareTravel={prepareTravel}
        settlementKey="workspace-restore"
      />,
    ));
    await act(async () => {});

    expect(commits).toEqual(["maximize", "restore"]);
    expect(layoutArrangementPhaseFacts()).toEqual([expect.objectContaining({
      ownerKey: "workspace-restore",
      current: expect.objectContaining({ key: expect.any(String) }),
      displayed: expect.objectContaining({ key: expect.any(String) }),
      phase: "idle",
    })]);
    expect(layoutArrangementPhaseFacts()[0].current.key)
      .toBe(layoutArrangementPhaseFacts()[0].displayed.key);
    expect(layoutSettlementFacts("workspace-restore")).toEqual({ active: false, pending: [] });
  });

  it("an actual-shaped maximize7→restore8 snap preserves the consumed revision on each terminal row", async () => {
    const restored = solve(twoColumns, "a");
    const maximized = solveArrangement<G>({
      layout: twoColumns,
      focusId: "a",
      maximizedId: "a",
      placement: { mode: "flow" },
      railOpen: true,
    });
    registerLayoutTransitionHost({
      prepareChange: async (_change, identity) => ({
        transactionId: identity.transactionId,
        mode: "snap",
        requiresSharedStart: false,
        stagedTargets: [],
        start: async () => null,
        commit: async () => ({
          transactionId: identity.transactionId,
          producer: "layout-adapter",
          targets: [],
        }),
        cancel: () => {},
      }),
    });
    const prepareTravel = async () => prepareLayoutMove([]);
    for (let revision = 1; revision <= 6; revision += 1) {
      invalidateLayout("wsp-4h7kq2");
      settleLayout("wsp-4h7kq2", revision);
    }
    act(() => root.render(<Probe
      arrangement={restored}
      scopeId={scopeOf(restored)}
      prepareTravel={prepareTravel}
      settlementKey="wsp-4h7kq2"
    />));

    invalidateLayout("wsp-4h7kq2");
    act(() => root.render(<Probe
      arrangement={maximized}
      scopeId={scopeOf(maximized)}
      prepareTravel={prepareTravel}
      settlementKey="wsp-4h7kq2"
    />));
    await act(async () => {});
    invalidateLayout("wsp-4h7kq2");
    act(() => root.render(<Probe
      arrangement={restored}
      scopeId={scopeOf(restored)}
      prepareTravel={prepareTravel}
      settlementKey="wsp-4h7kq2"
    />));
    await act(async () => {});

    expect(layoutTransitionJournal().map((entry) => ({
      phase: entry.phase,
      mode: entry.mode,
      settlement: entry.settlement,
    }))).toEqual([
      { phase: "committed", mode: "snap", settlement: { ownerKey: "wsp-4h7kq2", revision: 7, status: "settled" } },
      { phase: "committed", mode: "snap", settlement: { ownerKey: "wsp-4h7kq2", revision: 8, status: "settled" } },
    ]);
    expect(layoutSettlementFacts("wsp-4h7kq2")).toEqual({ active: false, pending: [] });
  });

  it("the earlier transaction's snap commit does not ACK the next revision opened during a slow prepare", async () => {
    const restored = solve(twoColumns, "a");
    const maximized = solveArrangement<G>({
      layout: twoColumns,
      focusId: "a",
      maximizedId: "a",
      placement: { mode: "flow" },
      railOpen: true,
    });
    let finishPrepare!: (prepared: PreparedLayoutTransition) => void;
    const prepareTravel = vi.fn(() => new Promise<PreparedLayoutTransition>((resolve) => {
      finishPrepare = resolve;
    }));
    act(() => root.render(
      <Probe
        arrangement={restored}
        scopeId={scopeOf(restored)}
        prepareTravel={prepareTravel}
        settlementKey="workspace-slow"
      />,
    ));

    const firstRevision = invalidateLayout("workspace-slow");
    act(() => root.render(
      <Probe
        arrangement={maximized}
        scopeId={scopeOf(maximized)}
        prepareTravel={prepareTravel}
        settlementKey="workspace-slow"
      />,
    ));
    const secondRevision = invalidateLayout("workspace-slow");
    await act(async () => finishPrepare(transition("snap")));

    expect(layoutSettlementFacts("workspace-slow")).toEqual({
      active: true,
      pending: [{
        key: "workspace-slow",
        requested: secondRevision,
        settled: firstRevision,
      }],
    });
  });

  it("a glide landing settles only the exact revision it consumed, even when a later revision is open", async () => {
    const left = solve(twoColumns, "a");
    const right = solve(twoColumns, "b");
    const prepareTravel = vi.fn(async () => transition("glide"));
    act(() => root.render(<Probe
      arrangement={left}
      scopeId={scopeOf(left)}
      prepareTravel={prepareTravel}
      settlementKey="workspace-glide-revisions"
    />));

    invalidateLayout("workspace-glide-revisions");
    act(() => root.render(<Probe
      arrangement={right}
      scopeId={scopeOf(right)}
      prepareTravel={prepareTravel}
      settlementKey="workspace-glide-revisions"
    />));
    await act(async () => {});

    invalidateLayout("workspace-glide-revisions");
    act(() => root.render(<Probe
      arrangement={left}
      scopeId={scopeOf(left)}
      prepareTravel={prepareTravel}
      settlementKey="workspace-glide-revisions"
    />));
    await act(async () => vi.advanceTimersByTimeAsync(RAIL_TRAVEL_MS));

    expect(layoutSettlementFacts("workspace-glide-revisions")).toEqual({
      active: true,
      pending: [{ key: "workspace-glide-revisions", requested: 2, settled: 1 }],
    });
    await act(async () => {});
    await act(async () => vi.advanceTimersByTimeAsync(RAIL_TRAVEL_MS));
    expect(layoutSettlementFacts("workspace-glide-revisions")).toEqual({ active: false, pending: [] });
  });

  it("a glide reveals the DOM after prepare completes and runs commit in that DOM's layout effect", async () => {
    const at = solve(twoColumns, "a");
    const to = solve(twoColumns, "b");
    const committedContent: string[] = [];
    const commit = vi.fn(async () => { committedContent.push(el().dataset.content ?? ""); });
    const prepareTravel = vi.fn(async (): Promise<PreparedLayoutTransition> =>
      transition("glide", commit, vi.fn()));
    act(() => root.render(
      <Probe arrangement={at} scopeId={scopeOf(at)} prepareTravel={prepareTravel} />,
    ));
    act(() => root.render(
      <Probe arrangement={to} scopeId={scopeOf(to)} prepareTravel={prepareTravel} />,
    ));

    await act(async () => {});
    expect(el().dataset.preparing).toBe("0");
    expect(el().dataset.traveling).toBe("1");
    expect(el().dataset.content).toBe("live");
    expect(commit).toHaveBeenCalledTimes(1);
    expect(committedContent).toEqual(["live"]);
  });

  it("a glide pins the target DOM at the origin, then takes the producer start in the layout effect and reveals it", async () => {
    const at = solve(twoColumns, "a");
    const to = solve(twoColumns, "b");
    let releaseStart!: () => void;
    const start = vi.fn(() => new Promise<LayoutPresentationStart>((resolve) => {
      releaseStart = () => resolve(presentationStartReceipt("layout-shared", 4_321_250, 9, 17));
    }));
    const commit = vi.fn(async () => {});
    const domCandidateParticipant = {
      id: "dom-layout",
      prepare: vi.fn(),
    } as unknown as LayoutPresentationCandidateParticipant;
    const prepareTravel = vi.fn(async (): Promise<PreparedLayoutTransition> => ({
      mode: "glide",
      transactionId: "layout-shared",
      requiresSharedStart: true,
      stagedTargets: ["pane:p1"],
      start,
      commit,
      cancel: vi.fn(),
    }));
    act(() => root.render(
      <Probe
        arrangement={at}
        scopeId={scopeOf(at)}
        prepareTravel={prepareTravel}
        domCandidateParticipant={domCandidateParticipant}
      />,
    ));
    act(() => root.render(
      <Probe
        arrangement={to}
        scopeId={scopeOf(to)}
        prepareTravel={prepareTravel}
        domCandidateParticipant={domCandidateParticipant}
      />,
    ));
    await act(async () => {});

    expect(el().dataset.content).toBe("live");
    expect(el().dataset.traveling).toBe("1");
    expect(el().dataset.starting).toBe("1");
    expect(el().dataset.start).toBe("");
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(domCandidateParticipant);
    expect(commit).not.toHaveBeenCalled();

    await act(async () => releaseStart());
    expect(commit).toHaveBeenCalledOnce();
    expect(el().dataset.starting).toBe("0");
    expect(el().dataset.start).toBe("4321250");
  });

  it("a shared start or commit failure cancels every participant and reverts to the old DOM arrangement", async () => {
    const at = solve(twoColumns, "a");
    const to = solve(twoColumns, "b");
    const cancel = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const prepareTravel = vi.fn(async (): Promise<PreparedLayoutTransition> => ({
      ...transition("glide"),
      transactionId: "layout-failed",
      requiresSharedStart: true,
      start: async () => { throw new Error("participant start failed"); },
      cancel,
    }));
    act(() => root.render(
      <Probe
        arrangement={at}
        scopeId={scopeOf(at)}
        prepareTravel={prepareTravel}
        settlementKey="workspace-start-failed"
      />,
    ));
    invalidateLayout("workspace-start-failed");
    act(() => root.render(
      <Probe
        arrangement={to}
        scopeId={scopeOf(to)}
        prepareTravel={prepareTravel}
        settlementKey="workspace-start-failed"
      />,
    ));
    await act(async () => {});

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(el().dataset.starting).toBe("0");
    expect(el().dataset.station).toBe(String(at.station));
    expect(layoutArrangementPhaseFacts()).toEqual([expect.objectContaining({
      current: expect.objectContaining({ focusId: "b" }),
      displayed: expect.objectContaining({ focusId: "a" }),
      phase: "blocked",
      lastFailure: {
        targetKey: expect.any(String),
        message: "participant start failed",
      },
    })]);
    error.mockRestore();
  });

  it("an intent commit failure terminal preserves the exact transaction and the original error in the public ledger", async () => {
    const at = solve(twoColumns, "a");
    const to = solve(twoColumns, "b");
    const failure = new Error("native commit rejected: layout-commit-failed");
    const failed = {
      ...transition("glide"),
      transactionId: "layout-commit-failed",
      requiresSharedStart: false,
      commit: async () => { throw failure; },
    } satisfies PreparedLayoutTransition;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    registerLayoutTransitionIntentHost("workspace-commit-failed", {
      prepare: async () => failed,
    });
    act(() => root.render(
      <Probe arrangement={at} scopeId={scopeOf(at)} settlementKey="workspace-commit-failed" />,
    ));
    const revision = invalidateLayout("workspace-commit-failed");
    expect(publishLayoutTransitionIntent({
      ownerKey: "workspace-commit-failed",
      revision,
      from: at,
      to,
    })).toBe(true);
    act(() => root.render(
      <Probe arrangement={to} scopeId={scopeOf(to)} settlementKey="workspace-commit-failed" />,
    ));
    await act(async () => {});

    expect(layoutTransitionIntentFacts().events.find((event) => (
      event.ownerKey === "workspace-commit-failed"
      && event.revision === revision
      && event.phase === "finished"
    ))).toEqual(expect.objectContaining({
      reason: "commit-failed",
      transactionId: "layout-commit-failed",
      failure: "native commit rejected: layout-commit-failed",
    }));
    consoleError.mockRestore();
  });

  it("glide phase closes at the shared absolute epoch plus the declared duration", async () => {
    const at = solve(twoColumns, "a");
    const to = solve(twoColumns, "b");
    const startAtUnixUs = presentationNowUnixUs() + 100_000;
    const prepareTravel = vi.fn(async (): Promise<PreparedLayoutTransition> => ({
      ...transition("glide"),
      transactionId: "layout-epoch",
      requiresSharedStart: true,
      start: async () => presentationStartReceipt("layout-epoch", startAtUnixUs),
    }));
    act(() => root.render(
      <Probe arrangement={at} scopeId={scopeOf(at)} prepareTravel={prepareTravel} />,
    ));
    act(() => root.render(
      <Probe arrangement={to} scopeId={scopeOf(to)} prepareTravel={prepareTravel} />,
    ));
    await act(async () => {});
    expect(el().dataset.traveling).toBe("1");

    await act(async () => vi.advanceTimersByTimeAsync(RAIL_TRAVEL_MS));
    expect(el().dataset.traveling).toBe("1");
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(el().dataset.traveling).toBe("0");
  });

  it("the journey mode (glide possible) is fixed once at the start and does not change mid-phase", () => {
    // A mode change mid-phase reshapes the rail representation from 1 piece (the arrival line) to
    // 2 pieces (the leaving slot and the appearing slot). The sidebar standing in the 1-piece
    // render commits a new projection, the next frame pushes it into the leaving slot, and it
    // closes **holding the new projection** (measured defect).
    const at = solve(twoColumns, "a");
    const to = solve(twoColumns, "b");
    let glide = true;
    const canGlide = () => glide;
    act(() =>
      root.render(<Probe arrangement={at} scopeId={scopeOf(at)} canGlide={canGlide} />),
    );
    act(() =>
      root.render(<Probe arrangement={to} scopeId={scopeOf(to)} canGlide={canGlide} />),
    );
    expect(el().dataset.traveling).toBe("1");
    expect(el().dataset.glide).toBe("1");

    glide = false; // mid-phase the snapshot goes stale or the view changes, breaking the glide premise
    act(() =>
      root.render(<Probe arrangement={to} scopeId={scopeOf(to)} canGlide={canGlide} />),
    );
    expect(el().dataset.glide).toBe("1"); // this journey's mode is already fixed

    act(() => vi.advanceTimersByTime(RAIL_TRAVEL_MS + 10));
    const back = solve(twoColumns, "a"); // the next journey on the same plane
    act(() =>
      root.render(<Probe arrangement={back} scopeId={scopeOf(back)} canGlide={canGlide} />),
    );
    expect(el().dataset.traveling).toBe("1");
    expect(el().dataset.glide).toBe("0"); // the next journey is fixed by the premise at that time
  });

  it("a re-render of the same solution does not travel (no ghost phase)", () => {
    const at = solve(twoColumns, "a");
    act(() => root.render(<Probe arrangement={at} scopeId={scopeOf(at)} />));
    act(() =>
      root.render(<Probe arrangement={solve(twoColumns, "a")} scopeId={scopeOf(at)} />),
    );
    expect(el().dataset.traveling).toBe("0");
    act(() => vi.advanceTimersByTime(RAIL_TRAVEL_MS + 10));
    expect(redeliverViewFocusIfLost).not.toHaveBeenCalled();
  });

  it("a plane change (split or merge) re-anchors immediately without consuming the origin geometry", () => {
    const at = solve(twoColumns, "b");
    act(() => root.render(<Probe arrangement={at} scopeId={scopeOf(at)} />));
    // A new plane with a different line set — applying the old station drives the rail through a pane.
    const split = solve(threeColumns, "b");
    act(() => root.render(<Probe arrangement={split} scopeId={scopeOf(split)} />));
    expect(el().dataset.traveling).toBe("0");
  });

  it("a solution arriving mid-travel waits instead of replacing the display — a running journey does not jump", () => {
    // Swapping the display immediately re-interprets the running animation's start offset through
    // the CSS variable update, so the element jumps by the remaining progress (at most the sum of
    // two move distances). The queue removes that defect structurally.
    const at = solve(threeColumns, "a"); // station 0
    act(() => root.render(<Probe arrangement={at} scopeId={scopeOf(at)} />));
    const toB = solve(threeColumns, "b"); // station 33.33
    act(() => root.render(<Probe arrangement={toB} scopeId={scopeOf(toB)} />));
    expect(el().dataset.traveling).toBe("1");
    expect(el().dataset.station).toBe(String(toB.station));

    // A third solution arrives mid-travel — the display is still the first target.
    const toC = solve(threeColumns, "c"); // station 66.67
    act(() => root.render(<Probe arrangement={toC} scopeId={scopeOf(toC)} />));
    expect(el().dataset.station).toBe(String(toB.station));

    // When the first travel ends, the next travel starts from there toward the latest target.
    act(() => vi.advanceTimersByTime(RAIL_TRAVEL_MS + 10));
    expect(el().dataset.station).toBe(String(toC.station));
    expect(el().dataset.traveling).toBe("1");
    act(() => vi.advanceTimersByTime(RAIL_TRAVEL_MS + 10));
    expect(el().dataset.traveling).toBe("0");
  });

  it("however many clicks arrive, at most two phases exist — intermediate targets are folded", () => {
    const at = solve(threeColumns, "a");
    act(() => root.render(<Probe arrangement={at} scopeId={scopeOf(at)} />));
    const toB = solve(threeColumns, "b");
    act(() => root.render(<Probe arrangement={toB} scopeId={scopeOf(toB)} />));
    // b→c→a in a row during the travel — only the last one survives.
    for (const id of ["c", "a"]) {
      const next = solve(threeColumns, id);
      act(() => root.render(<Probe arrangement={next} scopeId={scopeOf(next)} />));
    }
    act(() => vi.advanceTimersByTime(RAIL_TRAVEL_MS + 10));
    expect(el().dataset.station).toBe(String(solve(threeColumns, "a").station));
    act(() => vi.advanceTimersByTime(RAIL_TRAVEL_MS + 10));
    expect(el().dataset.traveling).toBe("0");
  });

  it("a change that leaves geometry unchanged (view added, tab switched) is displayed immediately", () => {
    // If the phase owns the display, the phase must hold 'geometry' only. Judging a content change
    // (a view opened in a pane) by geometry signature alone keeps the display on the old tree and
    // the new view never appears (live evidence: view.open created v2, the pane had no tab at all).
    const at = solve(twoColumns, "a");
    act(() =>
      root.render(<Probe arrangement={at} scopeId={scopeOf(at)} contentKey="g1:v1|g2:v2" />),
    );
    expect(el().dataset.content).toBe("live");

    // Same geometry, different content — one view opened.
    const same = solve(twoColumns, "a");
    act(() =>
      root.render(
        <Probe arrangement={same} scopeId={scopeOf(same)} contentKey="g1:v1+v3|g2:v2" />,
      ),
    );
    expect(el().dataset.content).toBe("live"); // the newest solution is displayed immediately
    expect(el().dataset.traveling).toBe("0"); // geometry did not move, so there is no journey
  });

  it("updates tab content during rail travel without abandoning the open geometry journey", () => {
    const initialLayout: SplitTree<G> = {
      type: "split", id: "r", dir: "row", sizes: [0.5, 0.5],
      children: [leaf("a", "tab-a1"), leaf("b", "tab-b1")],
    };
    const changedLayout: SplitTree<G> = {
      type: "split", id: "r", dir: "row", sizes: [0.5, 0.5],
      children: [leaf("a", "tab-a2"), leaf("b", "tab-b1")],
    };
    const at = solve(initialLayout, "b");
    const moving = solve(initialLayout, "a");
    act(() => root.render(<Probe arrangement={at} scopeId={scopeOf(at)} contentKey="a:tab-a1|b:tab-b1" />));
    act(() => root.render(<Probe arrangement={moving} scopeId={scopeOf(moving)} contentKey="a:tab-a1|b:tab-b1" />));
    expect(el().dataset.traveling).toBe("1");

    const changed = solve(changedLayout, "a");
    act(() => root.render(<Probe arrangement={changed} scopeId={scopeOf(changed)} contentKey="a:tab-a2|b:tab-b1" />));
    expect(el().dataset.values).toContain("a:tab-a2");
    expect(el().dataset.traveling).toBe("1");

    act(() => vi.advanceTimersByTime(RAIL_TRAVEL_MS + 10));
    expect(el().dataset.traveling).toBe("0");
    expect(el().dataset.content).toBe("live");
  });

  it("rebase takes the next solution without a journey — a hand drag landing is not a journey", () => {
    const at = solve(twoColumns, "a");
    let rebase = () => {};
    const capture = (fn: () => void) => {
      rebase = fn;
    };
    act(() =>
      root.render(
        <Probe arrangement={at} scopeId={scopeOf(at)} onPhase={capture} />,
      ),
    );
    const to = solve(twoColumns, "b");
    act(() =>
      root.render(
        <Probe arrangement={to} scopeId={scopeOf(to)} onPhase={capture} />,
      ),
    );
    expect(el().dataset.traveling).toBe("1");
    act(() => rebase());
    expect(el().dataset.traveling).toBe("0");

    // A solution committing the position the hand dropped arrives next and still opens no travel
    // (old defect: the commit right after landing restarted a 0→actual-position ghost travel).
    const committed = solve(twoColumns, "b");
    act(() =>
      root.render(
        <Probe arrangement={committed} scopeId={scopeOf(committed)} onPhase={capture} />,
      ),
    );
    expect(el().dataset.traveling).toBe("0");
  });
});
