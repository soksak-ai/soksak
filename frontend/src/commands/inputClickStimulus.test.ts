// @vitest-environment jsdom
// A stimulus has a time and a cause.
//
// B05 (continuous-visible-presentation) judges "click → layout transaction → presentation frame" as one
// causal chain. That requires two facts on the public surface.
//
//  1) Stimulus time — the absolute epoch at which the click actually went out. Estimating it backwards from
//     the frame list makes the number an interpretation, not an observation. The command must answer with
//     the presentation clock directly (same epoch as the layout journal and the native display ledger).
//  2) Cause — which layout transaction this stimulus opened. Cutting the journal by a sequence window assumes
//     no other transaction happened in between, and an assumption is not a receipt.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetLayoutTransitionHostForTest,
  prepareLayoutMove,
} from "../lib/layoutTransitionHost";
import {
  __resetLayoutTransitionJournalForTest,
  layoutTransitionJournal,
} from "../lib/layoutTransitionJournal";
import { presentationNowUnixMs } from "../lib/presentationClock";
import { recordWindowFrames } from "./windowRecorder";

vi.mock("../lib/contentViews", () => ({
  CONTENT_VIEW_BODY: "data-content-view-body",
  contentViewSlotVisible: () => true,
  hasContentViewHost: () => false,
  contentViewHost: () => ({ sendInput: async () => {} }),
}));
vi.mock("../lib/webviewLabels", () => ({
  currentWindowLabel: () => "main",
  browserLabel: (viewId: string) => `browser.main.${viewId}`,
}));
const shellWin = vi.hoisted(() => ({
  innerPosition: async () => ({ x: 0, y: 0 }),
  scaleFactor: async () => 1,
}));
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: vi.fn(async () => ({})),
  currentWindow: () => shellWin,
}));
vi.mock("./windowRecorder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./windowRecorder")>()),
  recordWindowFrames: vi.fn(),
}));

import { __resetMultiDomTraceForTest, registerDomCatalog } from "./catalogDom";
import { catalogJson, execute, getSpec, unregister } from "./registry";

const ADDR = "win/main/center/view/test.v/node/btn";

function mountNode(html: string): void {
  document.body.innerHTML =
    `<div class="tab-viewer" data-view-addr="center/view/test.v">${html}</div>`;
}

beforeEach(() => {
  __resetLayoutTransitionHostForTest();
  __resetLayoutTransitionJournalForTest();
  __resetMultiDomTraceForTest();
  vi.mocked(recordWindowFrames).mockReset();
  registerDomCatalog();
});
afterEach(() => {
  for (const { name } of catalogJson()) {
    if (name.startsWith("ui.")) unregister(name);
  }
  document.body.innerHTML = "";
  __resetLayoutTransitionHostForTest();
  __resetLayoutTransitionJournalForTest();
});

describe("ui.input.click — stimulus time", () => {
  it("answers with the absolute epoch at which the click went out", async () => {
    mountNode(`<button data-node="btn">tab</button>`);
    const before = presentationNowUnixMs();
    const result = await execute("ui.input.click", { address: ADDR }, {});
    const after = presentationNowUnixMs();

    const atUnixMs = (result.data as { atUnixMs?: number }).atUnixMs;
    expect(Number.isFinite(atUnixMs)).toBe(true);
    expect(atUnixMs).toBeGreaterThanOrEqual(before);
    expect(atUnixMs).toBeLessThanOrEqual(after);
    expect(getSpec("ui.input.click")?.returns).toContain("atUnixMs");
  });

  it("answers with a stimulus time for every phase of a split gesture", async () => {
    mountNode(`<button data-node="btn">tab</button>`);
    const down = await execute("ui.input.click", { address: ADDR, phase: "down" }, {});
    const up = await execute("ui.input.click", { address: ADDR, phase: "up" }, {});

    const downAt = (down.data as { atUnixMs?: number }).atUnixMs!;
    const upAt = (up.data as { atUnixMs?: number }).atUnixMs!;
    expect(Number.isFinite(downAt)).toBe(true);
    expect(Number.isFinite(upAt)).toBe(true);
    expect(upAt).toBeGreaterThanOrEqual(downAt);
  });

  it("uses the same epoch as the layout journal — never two clocks", async () => {
    mountNode(`<button data-node="btn">tab</button>`);
    const clicked = await execute("ui.input.click", { address: ADDR }, {});
    const prepared = await prepareLayoutMove([{ viewId: "test.v", dx: -160 }]);
    await prepared.commit();

    const entry = layoutTransitionJournal()[0]!;
    const atUnixMs = (clicked.data as { atUnixMs?: number }).atUnixMs!;
    expect(entry.preparedAtUnixMs).toEqual(expect.any(Number));
    expect(entry.preparedAtUnixMs).toBeGreaterThanOrEqual(atUnixMs);
    expect(entry.closedAtUnixMs).toBeGreaterThanOrEqual(entry.preparedAtUnixMs!);
  });
});

describe("ui.input.click — layout transaction cause", () => {
  it.each([undefined, "down", "up"] as const)(
    "a DOM %s phase success receipt returns the declared causeTraceId unchanged",
    async (phase) => {
      mountNode(`<button data-node="btn">tab</button>`);
      const result = await execute("ui.input.click", {
        address: ADDR,
        causeTraceId: "trace-echo",
        ...(phase === undefined ? {} : { phase }),
      }, {});

      expect(result.data).toMatchObject({ causeTraceId: "trace-echo" });
      expect(getSpec("ui.input.click")?.returns).toContain("causeTraceId?");
    },
  );

  it("omits the field from a success receipt when causeTraceId was omitted", async () => {
    mountNode(`<button data-node="btn">tab</button>`);
    const result = await execute("ui.input.click", { address: ADDR }, {});
    expect(result.data).not.toHaveProperty("causeTraceId");
  });

  it("records the declared causeTraceId on the layout transaction that stimulus opened", async () => {
    mountNode(`<button data-node="btn">tab</button>`);
    await execute("ui.input.click", { address: ADDR, causeTraceId: "trace-to-left" }, {});
    const prepared = await prepareLayoutMove([{ viewId: "test.v", dx: -160 }]);
    await prepared.commit();

    expect(layoutTransitionJournal()[0]?.causeTraceId).toBe("trace-to-left");
    expect(getSpec("ui.input.click")?.params.causeTraceId).toBeDefined();
  });

  it("applies the cause to one transaction only — the next transaction has none", async () => {
    mountNode(`<button data-node="btn">tab</button>`);
    await execute("ui.input.click", { address: ADDR, causeTraceId: "trace-to-left" }, {});
    await (await prepareLayoutMove([{ viewId: "test.v", dx: -160 }])).commit();
    await (await prepareLayoutMove([{ viewId: "test.v", dx: 160 }])).commit();

    const entries = layoutTransitionJournal();
    expect(entries[0]?.causeTraceId).toBe("trace-to-left");
    expect(entries[1]?.causeTraceId).toBeUndefined();
  });

  it("a click with no declared cause leaves the transaction without one", async () => {
    mountNode(`<button data-node="btn">tab</button>`);
    await execute("ui.input.click", { address: ADDR }, {});
    await (await prepareLayoutMove([{ viewId: "test.v", dx: -160 }])).commit();

    expect(layoutTransitionJournal()[0]?.causeTraceId).toBeUndefined();
  });

  it("rejects an empty causeTraceId — never a silently causeless transaction", async () => {
    mountNode(`<button data-node="btn">tab</button>`);
    const result = await execute("ui.input.click", { address: ADDR, causeTraceId: "" }, {});
    expect(result.ok).toBe(false);
    expect(result.code).toBe("INVALID_PARAMS");
  });
});
