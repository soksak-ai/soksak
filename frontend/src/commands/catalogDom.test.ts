// @vitest-environment jsdom
// ui.* transparency completion contract — the core exposes a node's "effective visual/interaction state"
// (visible, clickable, what covers it). ui.tree (existence) and ui.measure (geometry) existed, but the half
// between them (effective state) was missing, so plugins reinvented private DOM (db-studio probe-clickpath).
//
// Two axes are verified:
//  1) deepElementFromPoint — a hit test that pierces shadow DOM (symmetric with ui.tree/nodeScan).
//     ui.hit was a shallow document.elementFromPoint call, an asymmetric defect that stopped at the shadow host.
//  2) ui.measure — style always includes the interaction/visibility axes (pointerEvents/opacity/visibility),
//     props[] requests arbitrary computed props (removing the hardcoded field limit), plus occlusion reachability.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// A command description is a key, resolved where the catalogue is read.
import { text, withReaderLanguage } from "../i18n";
import { startPointerOrderRepair } from "../lib/pointerOrderRepair";
import {
  __resetLayoutTransitionHostForTest,
  prepareLayoutMove,
} from "../lib/layoutTransitionHost";
import {
  __resetLayoutTransitionJournalForTest,
  declareLayoutCause,
  layoutTransitionJournal,
} from "../lib/layoutTransitionJournal";
import {
  __resetPresentationDisplayFramesForTest,
  publishPresentationDisplayFrame,
} from "../lib/presentationDisplayFrames";
import {
  __resetPresentationClockForTest,
  presentationNowUnixMs,
} from "../lib/presentationClock";
import { invoke as frameworkInvoke } from "../framework";
import { recordWindowFrames } from "./windowRecorder";

// Replacing a whole module makes exports added later silently become undefined — the mock must follow what that
// module actually provides (measured 2026-08-02: browserLabel was missing and the handler died).
// The event is recorded whole — recording a few hand-picked slots leaves the check GREEN on the day the contract
// gains an axis (button, held count), and nobody looks at the missing axis.
const sentInput: [string, Record<string, unknown>][] = [];
const settlementBarrier = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../lib/contentViews", () => ({
  CONTENT_VIEW_BODY: "data-content-view-body",
  contentViewSlotVisible: () => true,
  // Answers that it exists — because the host is provided below. Providing one while answering "none" makes that
  // world incoherent, and a GREEN on top of it proves nothing.
  hasContentViewHost: () => true,
  contentViewHost: () => ({
    presentationSettled: settlementBarrier,
    sendInput: async (label: string, input: Record<string, unknown>) => {
      sentInput.push([label, input]);
    },
  }),
}));
vi.mock("../lib/webviewLabels", () => ({ currentWindowLabel: () => "main" }));
// The framework is mocked at one boundary. Window geometry is kept in a holder so a test can swap it —
// static imports are bound at module load, so doMock (a late replacement) does not apply.
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

import {
  __resetMultiDomTraceForTest,
  registerDomCatalog,
  deepElementFromPoint,
  deepActiveElement,
  viewContainerOf,
} from "./catalogDom";
import { catalogJson, execute, getSpec, unregister } from "./registry";

beforeEach(() => {
  sentInput.length = 0;
  settlementBarrier.mockReset().mockResolvedValue(undefined);
  __resetLayoutTransitionHostForTest();
  __resetLayoutTransitionJournalForTest();
  __resetMultiDomTraceForTest();
  __resetPresentationDisplayFramesForTest();
  __resetPresentationClockForTest();
  vi.mocked(recordWindowFrames).mockReset();
  registerDomCatalog();
});
afterEach(() => {
  // Everything on the table, not everything whose name starts a certain way. A prefix is a
  // hand-written list wearing a pattern: this file registers `rail.settled` too, and the next
  // beforeEach failed 89 cases with "duplicate registration" the day it was added — the same way a
  // literal list failed 23 when ui.input.key arrived.
  //
  // Only this file registers into this suite's registry, so clearing it is clearing what it put
  // there.
  for (const { name } of catalogJson()) {
    unregister(name);
  }
  document.body.innerHTML = "";
});

describe("ui.layout.status — public layout barrier diagnosis", () => {
  it("exposes the PluginViewHost overlay reason as a public current/event receipt", async () => {
    const spec = getSpec("ui.plugin-view.overlay");
    expect(spec?.returns).toContain("containerGeneration");
    expect(spec?.returns).toContain("registryPresent");
    expect(spec?.returns).toContain("bootPhase");
    expect(spec?.returns).toContain("overlayReason");
    expect(spec?.returns).toContain("error");
    const result = await execute("ui.plugin-view.overlay", {}, {});
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ maxEvents: 64 });
    expect(Array.isArray((result.data as { current?: unknown }).current)).toBe(true);
    expect(Array.isArray((result.data as { events?: unknown }).events)).toBe(true);
  });

  it("publishes settled=true in the wait-settled success schema", () => {
    expect(getSpec("ui.layout.wait-settled")?.returns).toContain("settled:true");
    expect(getSpec("ui.layout.wait-settled")?.returns).toContain("owner:'content'");
    expect(getSpec("ui.layout.wait-settled")?.returns).toContain("owner:'view'");
    expect(getSpec("ui.layout.wait-settled")?.errors).toContain("PRESENTATION_PROVIDER_FAILED");
    expect(getSpec("ui.layout.status")?.returns).toContain("arrangementPhases");
    expect(getSpec("ui.layout.status")?.returns).toContain("presentationPending");
    expect(getSpec("ui.layout.status")?.returns).toContain("settlementEvents");
    expect(getSpec("ui.layout.status")?.returns).toContain("transitionIntents");
    // The presentation half is gone: nothing is taken off the screen for a motion, so what is
    // published is the lease itself.
    expect(getSpec("ui.layout.status")?.returns).toContain("decorationMotions");
    expect(getSpec("ui.layout.status")?.returns).toContain("decorationClearance");
    expect(getSpec("ui.layout.status")?.returns).toContain("transactionId?");
    expect(getSpec("ui.layout.status")?.returns).toContain("failure?");
  });

  it("exposes the same motion, revision, animation, and content label facts as the wait command", async () => {
    document.body.innerHTML = '<div data-content-view-body="browser.main.tab-current"></div>';
    const result = await execute("ui.layout.status", {}, {});
    expect(result.data).toMatchObject({
      settled: true,
      motion: { active: false },
      settlement: { active: false },
      settlementEvents: [],
      arrangementPhases: [],
      transitionIntents: { owners: [], events: [], maxEvents: 64 },
      decorationMotions: [],
      decorationClearance: { owners: [], events: [], maxEvents: 64 },
      animations: [],
      contentViewLabels: ["browser.main.tab-current"],
    });
  });

  it("returns a structured receipt instead of mislabeling a provider reject as TIMEOUT", async () => {
    document.body.innerHTML = '<div data-content-view-body="browser.main.tab-current"></div>';
    settlementBarrier.mockRejectedValueOnce({
      code: "NATIVE_PRESENTATION_REJECTED",
      message: "content surface rejected",
      data: { label: "browser.main.tab-current" },
    });
    const result = await execute("ui.layout.wait-settled", { timeoutMs: 4_000 }, {});
    expect(result).toMatchObject({
      ok: false,
      code: "PRESENTATION_PROVIDER_FAILED",
      data: {
        command: "ui.layout.wait-settled",
        barrier: "content",
        labels: ["browser.main.tab-current"],
        providerError: {
          code: "NATIVE_PRESENTATION_REJECTED",
          message: "content surface rejected",
        },
      },
    });
  });
});

describe("deepElementFromPoint — hit test through shadow", () => {
  it("returns the deepest element through nested shadow roots", () => {
    const host1 = document.createElement("div");
    const sr1 = host1.attachShadow({ mode: "open" });
    const host2 = document.createElement("div");
    const sr2 = host2.attachShadow({ mode: "open" });
    const leaf = document.createElement("button"); // no shadowRoot -> recursion stops
    Object.defineProperty(sr1, "elementFromPoint", { value: () => host2, configurable: true });
    Object.defineProperty(sr2, "elementFromPoint", { value: () => leaf, configurable: true });
    const doc = { elementFromPoint: () => host1 } as unknown as DocumentOrShadowRoot;
    expect(deepElementFromPoint(5, 5, doc)).toBe(leaf);
  });

  it("returns the topmost element unchanged when there is no shadow", () => {
    const el = document.createElement("span");
    const doc = { elementFromPoint: () => el } as unknown as DocumentOrShadowRoot;
    expect(deepElementFromPoint(1, 1, doc)).toBe(el);
  });

  it("stops when a shadow returns its own host (no infinite loop)", () => {
    const host = document.createElement("div");
    const sr = host.attachShadow({ mode: "open" });
    Object.defineProperty(sr, "elementFromPoint", { value: () => host, configurable: true });
    const doc = { elementFromPoint: () => host } as unknown as DocumentOrShadowRoot;
    expect(deepElementFromPoint(1, 1, doc)).toBe(host);
  });

  it("returns null when nothing is at the coordinates", () => {
    const doc = { elementFromPoint: () => null } as unknown as DocumentOrShadowRoot;
    expect(deepElementFromPoint(1, 1, doc)).toBeNull();
  });
});

// ui.measure goes through resolveElement(collectExposed) — it collects [data-node] inside
// .tab-viewer[data-view-addr] as absolute addresses. The test sets up that structure and calls by address.
function mountNode(html: string): void {
  document.body.innerHTML =
    `<div class="tab-viewer" data-view-addr="center/view/test.v">${html}</div>`;
}
const ADDR = "win/main/center/view/test.v/node/btn";

describe("ui.input.compose — exposed DOM IME stimulus", () => {
  it("opens, updates, and ends composition on the addressed input with public state", async () => {
    const jamo = "\u314e";
    const syllable = "\ud55c";
    mountNode('<textarea data-node="btn"></textarea>');
    const input = document.querySelector<HTMLTextAreaElement>("textarea")!;
    const events: string[] = [];
    for (const type of ["compositionstart", "compositionupdate", "compositionend"]) {
      input.addEventListener(type, (event) => events.push(`${type}:${(event as CompositionEvent).data}`));
    }

    expect((await execute("ui.input.compose", { address: ADDR, text: jamo }, {})).ok).toBe(true);
    expect((await execute("ui.input.compose", { address: ADDR, text: syllable }, {})).ok).toBe(true);
    expect(input.dataset.uiComposing).toBe(syllable);
    expect((await execute("ui.input.compose", { address: ADDR }, {})).ok).toBe(true);
    expect(input.dataset.uiComposing).toBeUndefined();
    expect(events).toEqual([
      "compositionstart:", `compositionupdate:${jamo}`,
      `compositionupdate:${syllable}`, `compositionend:${syllable}`,
    ]);
  });
});

type NodeIdentityData = {
  nodeIdentity?: string;
};

async function treeNodeIdentity(): Promise<string | undefined> {
  const result = await execute("ui.tree", {}, {});
  const node = (result.data as {
    nodes: ({ address: string } & NodeIdentityData)[];
  }).nodes.find(({ address }) => address === ADDR);
  return node?.nodeIdentity;
}

describe("ui.tree/ui.measure — public DOM node instance identity", () => {
  it("ui.tree returns every data-* a node declares as the public dataset", async () => {
    mountNode(
      `<button data-node="btn" data-composition-kind="slot" data-view-id="view-a" `
      + `data-topology-path="workspace-a/pane-a/view-a" data-visible="true">x</button>`,
    );

    const result = await execute("ui.tree", {}, {});
    const node = (result.data as {
      nodes: Array<{ address: string; dataset?: Record<string, string> }>;
    }).nodes.find(({ address }) => address === ADDR);

    expect(node?.dataset).toEqual({
      node: "btn",
      compositionKind: "slot",
      viewId: "view-a",
      topologyPath: "workspace-a/pane-a/view-a",
      visible: "true",
    });
    expect(getSpec("ui.tree")?.returns).toContain("dataset");
  });

  it("ui.tree returns public accessibility semantics", async () => {
    mountNode(`<textarea data-node="btn" role="textbox" aria-label="Terminal input" aria-live="polite" tabindex="0"></textarea>`);
    const result = await execute("ui.tree", {}, {});
    const node = (result.data as { nodes: Array<Record<string, unknown>> }).nodes
      .find((value) => value.address === ADDR);
    expect(node).toMatchObject({
      role: "textbox", ariaLabel: "Terminal input", ariaLive: "polite", tabIndex: 0,
    });
  });

  it("one live Element keeps the same opaque identity across both commands and repeated queries", async () => {
    mountNode(`<button data-node="btn">x</button>`);

    const treeFirst = await treeNodeIdentity();
    const measuredFirst = await execute("ui.measure", { address: ADDR }, {});
    const treeSecond = await treeNodeIdentity();
    const measuredSecond = await execute("ui.measure", { address: ADDR }, {});

    expect(treeFirst).toEqual(expect.any(String));
    expect(treeFirst).not.toBe(ADDR);
    expect((measuredFirst.data as NodeIdentityData).nodeIdentity).toBe(treeFirst);
    expect(treeSecond).toBe(treeFirst);
    expect((measuredSecond.data as NodeIdentityData).nodeIdentity).toBe(treeFirst);
  });

  it("the identity changes when a new Element remounts at the same address", async () => {
    mountNode(`<button data-node="btn">x</button>`);
    const mounted = document.querySelector<HTMLElement>("[data-node=btn]")!;
    const before = await treeNodeIdentity();

    const remounted = mounted.cloneNode(true) as HTMLElement;
    mounted.replaceWith(remounted);
    const afterTree = await treeNodeIdentity();
    const afterMeasure = await execute("ui.measure", { address: ADDR }, {});

    expect(remounted).not.toBe(mounted);
    expect(afterTree).toEqual(expect.any(String));
    expect(afterTree).not.toBe(before);
    expect((afterMeasure.data as NodeIdentityData).nodeIdentity).toBe(afterTree);
  });

  it("the discoverable spec of both commands declares the nodeIdentity contract", () => {
    for (const name of ["ui.tree", "ui.measure"] as const) {
      const spec = getSpec(name)!;
      // The description is a key now; read the sentence, in both editions, because a contract
      // stated to one reader and not the other is the defect a key exists to prevent.
      for (const language of ["en", "ko"] as const) {
        expect(withReaderLanguage(language, () => text(spec.description)), language)
          .toContain("nodeIdentity");
      }
      expect(spec.returns).toContain("nodeIdentity");
    }
  });
});

describe("ui.measure — public form control value", () => {
  it("returns the current value of an input exposed by address without a private DOM query", async () => {
    mountNode(`<input data-node="btn" value="https://example.com/">`);

    const measured = await execute("ui.measure", { address: ADDR }, {});

    expect(measured.ok).toBe(true);
    expect((measured.data as { value?: unknown }).value).toBe("https://example.com/");
  });

  it("returns the current value of a public input from another document realm regardless of constructor identity", async () => {
    mountNode(`<input data-node="btn" value="https://fixture.invalid/">`);
    // A PluginView's DOM can be in a different Window realm from the host. The same tag then fails the host's
    // HTMLInputElement instanceof check. Public form semantics must be decided by the element's localName,
    // not by the realm.
    vi.stubGlobal("HTMLInputElement", class ForeignInputElement {});

    const measured = await execute("ui.measure", { address: ADDR }, {});

    expect(measured.ok).toBe(true);
    expect((measured.data as { value?: unknown }).value).toBe("https://fixture.invalid/");
    vi.unstubAllGlobals();
  });

  it("returns the current value on the real node receipt for public form state projected by a child renderer", async () => {
    mountNode(`<div data-node="btn" data-form-control="input" data-form-value="https://fixture.invalid/"></div>`);

    const measured = await execute("ui.measure", { address: ADDR }, {});

    expect(measured.ok).toBe(true);
    expect((measured.data as { value?: unknown }).value).toBe("https://fixture.invalid/");
  });

  it("declares value in the discoverable return contract", () => {
    expect(getSpec("ui.measure")?.returns).toContain("value");
  });
});

describe("ui.trace.multi — ledger of the public DOM participants in one tick", () => {
  it("the DOM trace epoch reuses the fixed origin of the transaction presentation clock", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(10);
    const timeOrigin = vi.spyOn(performance, "timeOrigin", "get").mockReturnValue(1_000);
    try {
      expect(presentationNowUnixMs()).toBe(1_010);
      now.mockReturnValue(20);
      timeOrigin.mockReturnValue(1_001);
      mountNode(`<div data-node="slot"></div>`);

      const armed = await execute("ui.trace.multi.start", {
        addresses: ["win/main/center/view/test.v/node/slot"],
        maxMs: 5_000,
        producers: { interval: false },
      }, {});

      expect(armed.ok).toBe(true);
      expect(armed.data).toMatchObject({
        startedAtUnixMs: 1_020,
      });
    } finally {
      now.mockRestore();
      timeOrigin.mockRestore();
    }
  });

  it("binds the native display callback to the exact cause transaction and reads the DOM visual epoch in that callback", async () => {
    try {
      vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      mountNode(`<div data-node="slot" class="flip-move"></div>`);
      const slot = document.querySelector<HTMLElement>('[data-node="slot"]')!;
      slot.getAnimations = vi.fn(() => [{
        animationName: "rail-flip-x",
        playState: "running",
        startTime: 75,
        currentTime: 25,
      }] as unknown as Animation[]);
      const address = "win/main/center/view/test.v/node/slot";
      const armed = await execute("ui.trace.multi.start", {
        addresses: [address], maxMs: 5_000, producers: { interval: false },
      }, {});
      const traceId = (armed.data as { traceId: string }).traceId;
      declareLayoutCause("native/01-left");
      await prepareLayoutMove([{ viewId: "test.v", dx: -160 }]);

      publishPresentationDisplayFrame({
        traceId: "native/01-left",
        producer: "native-display-link",
        clock: "mach-continuous-unix-anchored",
        sourceGeneration: 9,
        frameSequence: 4,
        presentationRevision: 5,
        presentedAtUnixMs: 1234.5,
      });

      const result = await execute("ui.trace.multi.close", { traceId }, {});
      expect(result.ok).toBe(true);
      const data = result.data as {
        producers: Record<string, number>;
        samples: Array<Record<string, unknown>>;
      };
      expect(data.producers["native-display-frame"]).toBe(1);
      expect(data.samples.find(({ producer }) => producer === "native-display-frame")).toMatchObject({
        producer: "native-display-frame",
        transactionId: "layout-1",
        displayFrame: {
          traceId: "native/01-left",
          sourceGeneration: 9,
          frameSequence: 4,
          presentationRevision: 5,
          presentedAtUnixMs: 1234.5,
        },
        nodes: [{ motion: expect.objectContaining({
          producer: "web-animation",
          transactionId: "layout-1",
          visualAtUnixMs: expect.any(Number),
        }) }],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("opens the frame callback series of the same transaction from the glide prepared event and does not swap the source after DOM commit", async () => {
    try {
      const frameCallbacks: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      }));
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      mountNode(`<div data-node="slot"></div>`);
      const slot = document.querySelector<HTMLElement>('[data-node="slot"]')!;
      slot.classList.add("flip-move");
      slot.getAnimations = vi.fn(() => [{
        animationName: "rail-flip-x",
        playState: "running",
        startTime: 75,
        currentTime: 25,
      }] as unknown as Animation[]);
      const address = "win/main/center/view/test.v/node/slot";
      const armed = await execute("ui.trace.multi.start", {
        addresses: [address],
        maxMs: 5_000,
        producers: { interval: false },
      }, {});
      const traceId = (armed.data as { traceId: string }).traceId;

      const prepared = await prepareLayoutMove([{ viewId: "test.v", dx: -160 }]);
      expect(frameCallbacks).toHaveLength(1);
      frameCallbacks.shift()!(100);
      await prepared.commit();
      // The DOM commit binds only commit identity to the same callback source prepared opened.
      expect(cancelAnimationFrame).not.toHaveBeenCalled();
      frameCallbacks.shift()!(116);

      const result = await execute("ui.trace.multi.close", { traceId }, {});
      expect(result).toMatchObject({
        ok: true,
        data: {
          slotObservation: {
            status: "observed",
            transactionId: "layout-1",
            sourceGeneration: 1,
            callbackCount: 2,
          },
          samples: expect.arrayContaining([
            expect.objectContaining({
              producer: "frame-callback",
              transactionId: "layout-1",
              domCommittedAtUnixMs: null,
              nodes: [expect.objectContaining({
                address,
                motion: expect.objectContaining({
                  producer: "web-animation",
                  phase: "active",
                  transactionId: "layout-1",
                  animationName: "rail-flip-x",
                  playState: "running",
                  startTime: 75,
                  currentTime: 25,
                  visualAtUnixMs: performance.timeOrigin + 100,
                  startFrame: expect.any(Object),
                  endFrame: null,
                }),
              })],
            }),
            expect.objectContaining({
              producer: "frame-callback",
              transactionId: "layout-1",
              domCommittedAtUnixMs: layoutTransitionJournal()[0]?.domCommittedAtUnixMs,
            }),
          ]),
        },
      });
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("every display sample keeps the dynamic presence and live element identity of rail, structural frame, and focus boundary at the same instant", async () => {
    document.body.innerHTML = `
      <div data-workspace-plane="workspace-a" data-workspace-active="1">
        <div class="content">
          <div class="sidebar" data-node="rail/left" data-rail-role="resting"></div>
          <div class="rail-link-overlay" data-node="relation/rail/space-a" data-bound-pane="pane-a" data-rail="0,0,10,500" data-box="10,20,300,400">
            <svg><path d="M 0 0 L 310 0 L 310 420 Z"></path></svg>
          </div>
          <div class="space" data-node="layout/space/space-a" data-traveling="true">
            <div class="pane" data-node="layout/pane/pane-a"></div>
            <div class="pane-border" data-node="layout/frame/pane-a"></div>
            <div class="pane-focus-boundary" data-node="layout/focus-boundary/pane-a"></div>
            <div class="tab-viewer" data-view-addr="center/view/test.v">
              <div data-node="slot"></div>
            </div>
          </div>
        </div>
      </div>`;
    const address = "win/main/center/view/test.v/node/slot";
    const armed = await execute("ui.trace.multi.start", {
      addresses: ["win/main/proj/workspace-a/chrome/rail/left", address],
      maxMs: 5_000,
      producers: { interval: false },
    }, {});
    const traceId = (armed.data as { traceId: string }).traceId;
    const result = await execute("ui.trace.multi.close", { traceId }, {});

    expect(result).toMatchObject({
      ok: true,
      data: {
        samples: [expect.objectContaining({
          chrome: {
            projectId: "workspace-a",
            spaceNode: "layout/space/space-a",
            traveling: true,
            rail: {
              count: 1,
              role: "resting",
              visibility: "visible",
              nodeIdentity: expect.any(String),
              rect: expect.any(Object),
            },
            structuralFrames: [{
              pane: "pane-a",
              nodeIdentity: expect.any(String),
              rect: expect.any(Object),
            }],
            movingPaneIds: [],
            paneChrome: [{
              pane: "pane-a",
              nodeIdentity: expect.any(String),
              rect: expect.any(Object),
            }],
            focusBoundaries: [{
              pane: "pane-a",
              nodeIdentity: expect.any(String),
              rect: expect.any(Object),
            }],
            relationOutlines: [{
              pane: "pane-a",
              nodeIdentity: expect.any(String),
              rect: { x: 10, y: 20, w: 300, h: 400 },
              railRect: { x: 0, y: 0, w: 10, h: 500 },
              paneRect: { x: 10, y: 20, w: 300, h: 400 },
              geometry: "rail=0,0,10,500|pane=10,20,300,400|paths=M 0 0 L 310 0 L 310 420 Z",
            }],
          },
        })],
      },
    });
    const chrome = (result.data as { samples: Array<{ chrome: Record<string, unknown> }> })
      .samples[0].chrome;
    expect(chrome.movingPaneIds).toEqual([]);
    expect(chrome.paneChrome).toEqual([expect.objectContaining({
      pane: "pane-a",
      nodeIdentity: expect.any(String),
      rect: expect.any(Object),
    })]);
    expect(chrome.relationOutlines).toEqual([expect.objectContaining({
      pane: "pane-a",
      nodeIdentity: expect.any(String),
      rect: { x: 10, y: 20, w: 300, h: 400 },
      railRect: { x: 0, y: 0, w: 10, h: 500 },
      paneRect: { x: 10, y: 20, w: 300, h: 400 },
      geometry: "rail=0,0,10,500|pane=10,20,300,400|paths=M 0 0 L 310 0 L 310 420 Z",
    })]);
  });

  it("keeps another content's painted rail out of the moving content's rail inventory", async () => {
    document.body.innerHTML = `
      <div data-workspace-plane="workspace-a" data-workspace-active="1">
        <div class="content" data-content="inactive">
          <div class="sidebar" data-node="rail/left" data-rail-role="resting"></div>
        </div>
        <div class="content" data-content="active">
          <div class="rail-plane" data-node="rail/plane"></div>
          <div class="space" data-node="layout/space/space-a" data-traveling="true">
            <div class="tab-viewer" data-view-addr="center/view/test.v">
              <div data-node="slot"></div>
            </div>
          </div>
        </div>
      </div>`;
    const address = "win/main/center/view/test.v/node/slot";
    const armed = await execute("ui.trace.multi.start", {
      addresses: [address],
      maxMs: 5_000,
      producers: { interval: false },
    }, {});
    const traceId = (armed.data as { traceId: string }).traceId;
    const result = await execute("ui.trace.multi.close", { traceId }, {});

    expect(result.ok).toBe(true);
    const sample = (result.data as { samples: Array<{ chrome: Record<string, unknown> }> }).samples[0];
    expect(sample.chrome).toMatchObject({
      projectId: "workspace-a",
      spaceNode: "layout/space/space-a",
      traveling: true,
      rail: { count: 0, role: null, visibility: null, nodeIdentity: null },
    });
  });

  it("the animationend producer keeps the exact transaction completion epoch of a removed CSS animation in later frame callbacks", async () => {
    try {
      const frameCallbacks: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      }));
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      mountNode(`<div data-node="slot" class="flip-move"></div>`);
      const slot = document.querySelector<HTMLElement>('[data-node="slot"]')!;
      const animation = {
        animationName: "rail-flip-x",
        playState: "running",
        startTime: 75,
        currentTime: 25,
      } as unknown as Animation;
      slot.getAnimations = vi.fn(() => [animation]);
      const address = "win/main/center/view/test.v/node/slot";
      const armed = await execute("ui.trace.multi.start", {
        addresses: [address],
        maxMs: 5_000,
        producers: { interval: false },
      }, {});
      const traceId = (armed.data as { traceId: string }).traceId;

      await prepareLayoutMove([{ viewId: "test.v", dx: -160 }]);
      frameCallbacks.shift()!(100);
      slot.getAnimations = vi.fn(() => []);
      const ended = new Event("animationend") as AnimationEvent;
      Object.defineProperties(ended, {
        animationName: { value: "rail-flip-x" },
        elapsedTime: { value: 0.18 },
      });
      document.dispatchEvent(ended);
      frameCallbacks.shift()!(116);

      const result = await execute("ui.trace.multi.close", { traceId }, {});
      const samples = (result.data as { samples: Array<{producer:string; nodes:Array<{motion:unknown}>}> }).samples;
      expect(samples.filter(({ producer }) => producer === "animation-end")).toEqual([
        expect.objectContaining({
          nodes: [expect.objectContaining({
            motion: expect.objectContaining({
              producer: "web-animation",
              phase: "completed",
              transactionId: "layout-1",
              animationName: "rail-flip-x",
              playState: "finished",
              startTime: 75,
              currentTime: 180,
              visualAtUnixMs: performance.timeOrigin + 255,
              startFrame: expect.any(Object),
              endFrame: expect.any(Object),
            }),
          })],
        }),
      ]);
      const frameSamples = samples.filter(({ producer }) => producer === "frame-callback");
      expect(frameSamples[frameSamples.length - 1]).toMatchObject({
        transactionId: "layout-1",
        nodes: [{ motion: { phase: "completed", transactionId: "layout-1" } }],
      });
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("closes with the exact declared endpoint as the completion receipt even when class settlement arrives just before animationend", async () => {
    try {
      const frameCallbacks: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      }));
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      mountNode(`<div data-node="slot" class="flip-move"></div>`);
      const slot = document.querySelector<HTMLElement>('[data-node="slot"]')!;
      const animation = {
        animationName: "rail-flip-x",
        playState: "running",
        startTime: 75,
        currentTime: 178.683,
      } as unknown as Animation;
      slot.getAnimations = vi.fn(() => [animation]);
      const address = "win/main/center/view/test.v/node/slot";
      const armed = await execute("ui.trace.multi.start", {
        addresses: [address], maxMs: 5_000, producers: { interval: false },
      }, {});
      const traceId = (armed.data as { traceId: string }).traceId;

      await prepareLayoutMove([{ viewId: "test.v", dx: -160 }]);
      frameCallbacks.shift()!(253.683);
      slot.getAnimations = vi.fn(() => []);
      slot.classList.remove("flip-move");
      await Promise.resolve();

      const result = await execute("ui.trace.multi.close", { traceId }, {});
      const samples = (result.data as { samples: Array<{producer:string; nodes:Array<{motion:unknown}>}> }).samples;
      expect(samples.filter(({ producer }) => producer === "settlement").slice(-1)[0]).toMatchObject({
        nodes: [{ motion: {
          producer: "web-animation",
          phase: "completed",
          transactionId: "layout-1",
          currentTime: 180,
          visualAtUnixMs: performance.timeOrigin + 255,
          endFrame: expect.any(Object),
        } }],
      });
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("with no interval the frame callback producer owns the slot display observation identity and the skipped count", async () => {
    try {
      const frameCallbacks: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      }));
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      mountNode(`<div data-node="slot"></div>`);
      const element = document.querySelector<HTMLElement>('[data-node="slot"]')!;
      element.getBoundingClientRect = vi.fn(() => ({
        x: 110, y: 80, width: 560, height: 420,
        top: 80, left: 110, right: 670, bottom: 500,
        toJSON: () => ({}),
      } as DOMRect));
      const address = "win/main/center/view/test.v/node/slot";
      const armed = await execute("ui.trace.multi.start", {
        addresses: [address],
        maxMs: 5_000,
        producers: { interval: false },
      }, {});
      const traceId = (armed.data as { traceId: string }).traceId;
      const prepared = await prepareLayoutMove([{ viewId: "test.v", dx: -160 }]);
      await prepared.commit();
      frameCallbacks.shift()!(100);
      frameCallbacks.shift()!(116);
      frameCallbacks.shift()!(132);

      const result = await execute("ui.trace.multi.close", { traceId }, {});
      expect(result).toMatchObject({
        ok: true,
        data: {
          producersEnabled: { interval: false },
          slotObservation: {
            status: "observed",
            producer: "frame-callback",
            clock: "unix-anchored-monotonic",
            transactionId: "layout-1",
            sourceGeneration: 1,
            firstFrameSequence: 0,
            lastFrameSequence: 2,
            callbackCount: 3,
            callbackIntervalsSkipped: 0,
          },
        },
      });
      expect(getSpec("ui.trace.multi.close")?.returns).toContain("slotObservation");
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("the same display epoch owns the Web Animation slot when a native display frame ledger exists", async () => {
    try {
      const frameCallbacks: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      }));
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      mountNode(`<div data-node="slot"></div>`);
      const address = "win/main/center/view/test.v/node/slot";
      const armed = await execute("ui.trace.multi.start", {
        addresses: [address],
        maxMs: 5_000,
        producers: { interval: false },
      }, {});
      const traceId = (armed.data as { traceId: string }).traceId;
      declareLayoutCause("native/slot-owner");
      await prepareLayoutMove([{ viewId: "test.v", dx: -160 }]);
      frameCallbacks.shift()!(100);
      publishPresentationDisplayFrame({
        traceId: "native/slot-owner",
        producer: "native-display-link",
        clock: "unix-anchored-monotonic",
        sourceGeneration: 9,
        frameSequence: 41,
        presentationRevision: 42,
        presentedAtUnixMs: 1_234.5,
      });
      publishPresentationDisplayFrame({
        traceId: "native/slot-owner",
        producer: "native-display-link",
        clock: "unix-anchored-monotonic",
        sourceGeneration: 9,
        frameSequence: 42,
        presentationRevision: 43,
        presentedAtUnixMs: 1_242.833,
      });
      frameCallbacks.shift()!(116);

      const result = await execute("ui.trace.multi.close", { traceId }, {});
      expect(result).toMatchObject({
        ok: true,
        data: {
          producers: { "frame-callback": 2, "native-display-frame": 2 },
          slotObservation: {
            status: "observed",
            producer: "native-display-frame",
            transactionId: "layout-1",
            sourceGeneration: 9,
            firstFrameSequence: 41,
            lastFrameSequence: 42,
            callbackCount: 2,
            callbackIntervalsSkipped: 0,
          },
        },
      });
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("the native display event owns slot observation when frame callbacks stop in an occluded document", async () => {
    try {
      vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      mountNode(`<div data-node="slot"></div>`);
      const address = "win/main/center/view/test.v/node/slot";
      const armed = await execute("ui.trace.multi.start", {
        addresses: [address],
        maxMs: 5_000,
        producers: { interval: false },
      }, {});
      const traceId = (armed.data as { traceId: string }).traceId;
      declareLayoutCause("native/occluded-slot-owner");
      await prepareLayoutMove([{ viewId: "test.v", dx: -160 }]);
      for (const frameSequence of [41, 43]) {
        publishPresentationDisplayFrame({
          traceId: "native/occluded-slot-owner",
          producer: "native-display-link",
          clock: "unix-anchored-monotonic",
          sourceGeneration: 9,
          frameSequence,
          presentationRevision: 42,
          presentedAtUnixMs: 1_234.5 + frameSequence,
        });
      }

      const result = await execute("ui.trace.multi.close", { traceId }, {});
      expect(result).toMatchObject({
        ok: true,
        data: {
          producers: { "frame-callback": 0, "native-display-frame": 2 },
          slotObservation: {
            status: "observed",
            producer: "native-display-frame",
            clock: "unix-anchored-monotonic",
            transactionId: "layout-1",
            sourceGeneration: 9,
            firstFrameSequence: 41,
            lastFrameSequence: 43,
            callbackCount: 2,
            callbackIntervalsSkipped: 1,
          },
        },
      });
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("records the raw participants on every real presentation frame after layout DOM-commit", async () => {
    try {
      const frameCallbacks: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      }));
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      mountNode(`
        <div data-node="rail"></div>
        <div data-node="pane"></div>
        <div data-node="slot"></div>
      `);
      const rects: Record<string, { x: number; y: number; width: number; height: number }> = {
        rail: { x: 10, y: 20, width: 80, height: 500 },
        pane: { x: 90, y: 20, width: 600, height: 500 },
        slot: { x: 110, y: 80, width: 560, height: 420 },
      };
      for (const [node, rect] of Object.entries(rects)) {
        const element = document.querySelector<HTMLElement>(`[data-node="${node}"]`)!;
        element.getBoundingClientRect = vi.fn(() => ({
          ...rect,
          top: rect.y,
          left: rect.x,
          right: rect.x + rect.width,
          bottom: rect.y + rect.height,
          toJSON: () => ({}),
        }));
      }
      const addresses = ["rail", "pane", "slot"]
        .map((node) => `win/main/center/view/test.v/node/${node}`);
      const armed = await execute("ui.trace.multi.start", { addresses, maxMs: 5_000 }, {});
      expect(armed).toMatchObject({
        ok: true,
        data: {
          traceId: expect.any(String),
          addresses,
          startedAtUnixMs: expect.any(Number),
          expiresAtUnixMs: expect.any(Number),
        },
      });
      const traceId = (armed.data as { traceId: string }).traceId;
      rects.rail.x = 170;
      rects.pane.x = 250;
      rects.slot.x = 270;
      const prepared = await prepareLayoutMove([{ viewId: "test.v", dx: -160 }]);
      await prepared.commit();
      expect(frameCallbacks).toHaveLength(1);
      rects.rail.x = 190;
      rects.pane.x = 270;
      rects.slot.x = 290;
      frameCallbacks.shift()!(performance.now());
      const result = await execute("ui.trace.multi.close", { traceId }, {});
      expect(result.ok).toBe(true);
      const data = result.data as {
        addresses: string[];
        samples: Array<{
          sequence: number;
          sampledAtUnixMs: number;
          trigger: "initial" | "layout-dom-commit" | "presentation-frame";
          transactionId: string | null;
          domCommittedAtUnixMs: number | null;
          nodes: Array<{
            address: string;
            connected: boolean;
            rect: { x: number; y: number; w: number; h: number };
          }>;
        }>;
      };
      expect(data.addresses).toEqual(addresses);
      expect(data.samples).toHaveLength(4);
      expect(data.samples[0]).toMatchObject({
        sequence: 0,
        trigger: "initial",
        transactionId: null,
        domCommittedAtUnixMs: null,
        nodes: [
          { address: addresses[0], connected: true, rect: { x: 10, y: 20, w: 80, h: 500 } },
          { address: addresses[1], connected: true, rect: { x: 90, y: 20, w: 600, h: 500 } },
          { address: addresses[2], connected: true, rect: { x: 110, y: 80, w: 560, h: 420 } },
        ],
      });
      expect(data.samples[1]).toMatchObject({
        sequence: 1,
        trigger: "layout-dom-commit",
        transactionId: "layout-1",
        domCommittedAtUnixMs: layoutTransitionJournal()[0]?.domCommittedAtUnixMs,
        nodes: [
          { address: addresses[0], connected: true, rect: { x: 170, y: 20, w: 80, h: 500 } },
          { address: addresses[1], connected: true, rect: { x: 250, y: 20, w: 600, h: 500 } },
          { address: addresses[2], connected: true, rect: { x: 270, y: 80, w: 560, h: 420 } },
        ],
      });
      expect(data.samples[2]).toMatchObject({
        sequence: 2,
        trigger: "presentation-frame",
        transactionId: "layout-1",
        domCommittedAtUnixMs: layoutTransitionJournal()[0]?.domCommittedAtUnixMs,
        nodes: [
          { address: addresses[0], connected: true, rect: { x: 170, y: 20, w: 80, h: 500 } },
          { address: addresses[1], connected: true, rect: { x: 250, y: 20, w: 600, h: 500 } },
          { address: addresses[2], connected: true, rect: { x: 270, y: 80, w: 560, h: 420 } },
        ],
      });
      expect(data.samples[3]).toMatchObject({
        sequence: 3,
        trigger: "presentation-frame",
        transactionId: "layout-1",
        domCommittedAtUnixMs: layoutTransitionJournal()[0]?.domCommittedAtUnixMs,
        nodes: [
          { address: addresses[0], connected: true, rect: { x: 190, y: 20, w: 80, h: 500 } },
          { address: addresses[1], connected: true, rect: { x: 270, y: 20, w: 600, h: 500 } },
          { address: addresses[2], connected: true, rect: { x: 290, y: 80, w: 560, h: 420 } },
        ],
      });
      expect(data.samples.every((sample) => Number.isFinite(sample.sampledAtUnixMs))).toBe(true);
      expect(getSpec("ui.trace.multi.start")?.returns).toContain("traceId");
      expect(getSpec("ui.trace.multi.close")?.returns).toContain("sampledAtUnixMs");
      expect(getSpec("ui.trace.multi.close")?.returns).toContain("transactionId");
      expect(getSpec("ui.trace.multi.close")?.returns).toContain("domCommittedAtUnixMs");
      expect(getSpec("ui.trace.multi")).toBeUndefined();
      expect(await execute("ui.trace.multi.close", { traceId }, {}))
        .toMatchObject({ ok: false, code: "TARGET_NOT_FOUND" });
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  // Mid-glide, samples stopped for 339ms while the event observer of the same session stayed alive afterwards.
  // Without "who observed it" in the ledger, that hole is readable only by back-computing sample intervals. Record
  // the observer by name, and keep one tick's failure from killing the observer.
  it("records the observer on every sample and keeps that observer alive when one tick fails", async () => {
    try {
      vi.useFakeTimers();
      vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      mountNode(`<div data-node="slot"></div>`);
      const element = document.querySelector<HTMLElement>('[data-node="slot"]')!;
      let failNextRead = false;
      element.getBoundingClientRect = vi.fn(() => {
        if (failNextRead) {
          failNextRead = false;
          throw new Error("layout read failed on this tick");
        }
        return {
          x: 110, y: 80, width: 560, height: 420,
          top: 80, left: 110, right: 670, bottom: 500,
          toJSON: () => ({}),
        } as DOMRect;
      });
      const addresses = ["win/main/center/view/test.v/node/slot"];
      const armed = await execute("ui.trace.multi.start", { addresses, maxMs: 5_000 }, {});
      const traceId = (armed.data as { traceId: string }).traceId;
      const prepared = await prepareLayoutMove([{ viewId: "test.v", dx: -160 }]);
      await prepared.commit();

      vi.advanceTimersByTime(32);
      failNextRead = true;
      // A failed tick throws. If the thrown tick takes the next tick with it, the observer dies for good.
      expect(() => vi.advanceTimersByTime(8)).toThrow();
      vi.advanceTimersByTime(32);

      const result = await execute("ui.trace.multi.close", { traceId }, {});
      const data = result.data as {
        producers: Record<string, number>;
        samples: Array<{ producer: string }>;
      };
      expect(data.producers.arm).toBe(1);
      expect(data.producers["layout-commit"]).toBe(1);
      expect(data.producers["commit-anchor"]).toBe(1);
      expect(data.producers["frame-callback"]).toBe(0);
      // 4 ticks before the failure, the failing tick (no sample), 4 ticks after.
      expect(data.producers.interval).toBe(8);
      expect(data.samples.every((sample) => typeof sample.producer === "string")).toBe(true);
      for (const [producer, count] of Object.entries(data.producers)) {
        expect(data.samples.filter((sample) => sample.producer === producer)).toHaveLength(count);
      }
      expect(getSpec("ui.trace.multi.close")?.returns).toContain("producers");
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("rejects a missing or duplicate address with INVALID_PARAMS instead of guessing", async () => {
    const empty = await execute("ui.trace.multi.start", { addresses: [] }, {});
    expect(empty).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    const duplicate = await execute("ui.trace.multi.start", { addresses: [ADDR, ADDR] }, {});
    expect(duplicate).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    const invalidLifetime = await execute(
      "ui.trace.multi.start",
      { addresses: [ADDR], maxMs: Number.NaN },
      {},
    );
    expect(invalidLifetime).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  });
});

describe("ui.measure — interaction and visibility axes", () => {
  it("exposes the exact inline geometry separately from computed style", async () => {
    mountNode(`<div data-node="btn" style="height:36px;flex-basis:36px">x</div>`);
    const r = await execute("ui.measure", { address: ADDR }, {});
    expect(r.ok).toBe(true);
    expect((r.data as { inlineStyle: Record<string, string> }).inlineStyle).toEqual({
      height: "36px",
      flexBasis: "36px",
    });
    expect(getSpec("ui.measure")?.returns).toContain("inlineStyle");
  });

  it("returns the exposed node's data-* state so no private DOM guess is needed", async () => {
    mountNode(`<div data-node="btn" data-projection="focus-near" data-traveling="true">x</div>`);
    const r = await execute("ui.measure", { address: ADDR }, {});
    expect(r.ok).toBe(true);
    expect((r.data as { dataset: Record<string, string> }).dataset).toMatchObject({
      node: "btn",
      projection: "focus-near",
      traveling: "true",
    });
  });

  it("always includes pointerEvents, opacity, and visibility in style", async () => {
    mountNode(`<button data-node="btn" style="pointer-events:none;opacity:0.5;visibility:hidden">x</button>`);
    const r = await execute("ui.measure", { address: ADDR }, {});
    expect(r.ok).toBe(true);
    const style = (r.data as { style: Record<string, string> }).style;
    // Existing layout fields (backward compatible) + the new interaction/visibility axes.
    expect(style.display).toBeDefined();
    expect(style.pointerEvents).toBe("none");
    expect(style.opacity).toBe("0.5");
    expect(style.visibility).toBe("hidden");
  });

  it("queries arbitrary computed properties through props[] (no hardcoded limit)", async () => {
    mountNode(`<button data-node="btn" style="z-index:7;background-color:rgb(1,2,3)">x</button>`);
    const r = await execute("ui.measure", { address: ADDR, props: ["zIndex", "backgroundColor"] }, {});
    expect(r.ok).toBe(true);
    const style = (r.data as { style: Record<string, string> }).style;
    expect(style.zIndex).toBe("7");
    expect(style.backgroundColor).toBe("rgb(1, 2, 3)");
  });

  it("returns global logical (screen) coordinates when screen:true — an OS pointer tool consumes them directly", async () => {
    // Synthetic dispatch cannot reproduce hit testing or default behavior (focus) — real pointer verification
    // needs OS coordinates. The core exposes that conversion (physical innerPosition/scale + viewport rect)
    // through one path so consumers do not reinvent it.
    shellWin.innerPosition = async () => ({ x: 100, y: 200 });
    shellWin.scaleFactor = async () => 2;
    mountNode(`<button data-node="btn">x</button>`);
    const el = document.querySelector('[data-node="btn"]') as HTMLElement;
    el.getBoundingClientRect = () =>
      ({ x: 10, y: 20, width: 30, height: 40 } as DOMRect);
    const r = await execute("ui.measure", { address: ADDR, screen: true }, {});
    expect(r.ok).toBe(true);
    const screen = (r.data as { screen?: Record<string, number> }).screen;
    // Window logical origin (100/2, 200/2) + viewport rect. cx/cy is the center — a click tool uses it directly.
    expect(screen).toEqual({ x: 60, y: 120, cx: 75, cy: 140 });
  });

  it("returns the reachability verdict when occlusion:true", async () => {
    mountNode(`<button data-node="btn">x</button>`);
    const r = await execute("ui.measure", { address: ADDR, occlusion: true }, {});
    expect(r.ok).toBe(true);
    const occ = (r.data as { occlusion?: Record<string, unknown> }).occlusion;
    // Shape contract — reports reachable (boolean) and topTag (the actual hit result depends on layout).
    expect(occ).toBeDefined();
    expect(typeof occ!.reachable).toBe("boolean");
    expect("topTag" in occ!).toBe(true);
  });

  it("omits the reachability field when occlusion is omitted (measurement only)", async () => {
    mountNode(`<button data-node="btn">x</button>`);
    const r = await execute("ui.measure", { address: ADDR }, {});
    expect((r.data as Record<string, unknown>).occlusion).toBeUndefined();
  });

  // "Does this node own that spot" is answered only by retracing the path the hit took down.
  // The hit test pierces shadow (deepElementFromPoint), so if the containment check stops at the boundary with
  // Node.contains, a node holding a shadow-mounted plugin view hits inside itself and still answers "occluded"
  // — the right sidebar is exactly that spot (B09 chromeControl.reachable).
  it("reachability reads containment through shadow — it retraces the path the hit took down", async () => {
    mountNode(`<div data-node="btn"><div id="plugin-host"></div></div>`);
    const host = document.getElementById("plugin-host") as HTMLElement;
    const leaf = document.createElement("span");
    host.attachShadow({ mode: "open" }).appendChild(leaf);
    const orig = document.elementFromPoint;
    Object.defineProperty(document, "elementFromPoint", { value: () => host, configurable: true });
    Object.defineProperty(host.shadowRoot!, "elementFromPoint", {
      value: () => leaf,
      configurable: true,
    });
    try {
      const r = await execute("ui.measure", { address: ADDR, occlusion: true }, {});
      const occ = (r.data as { occlusion?: { reachable: boolean; topTag: string | null } }).occlusion;
      expect(occ!.topTag).toBe("span");
      expect(occ!.reachable).toBe(true);
    } finally {
      Object.defineProperty(document, "elementFromPoint", { value: orig, configurable: true });
    }
  });

  // The opposite direction. Piercing must not become "pass through anything" — when an element inside someone
  // else's shadow is on top, that spot is occluded and unreachable is the answer.
  it("an element inside someone else's shadow on top is unreachable — piercing does not widen containment", async () => {
    mountNode(`<div data-node="btn"></div>`);
    const cover = document.createElement("div");
    document.body.appendChild(cover);
    const leaf = document.createElement("span");
    cover.attachShadow({ mode: "open" }).appendChild(leaf);
    const orig = document.elementFromPoint;
    Object.defineProperty(document, "elementFromPoint", { value: () => cover, configurable: true });
    Object.defineProperty(cover.shadowRoot!, "elementFromPoint", {
      value: () => leaf,
      configurable: true,
    });
    try {
      const r = await execute("ui.measure", { address: ADDR, occlusion: true }, {});
      const occ = (r.data as { occlusion?: { reachable: boolean } }).occlusion;
      expect(occ!.reachable).toBe(false);
    } finally {
      Object.defineProperty(document, "elementFromPoint", { value: orig, configurable: true });
    }
  });
});

describe("ui.measure/ui.hit — spec declaration", () => {
  it("ui.measure declares props and occlusion", () => {
    const spec = getSpec("ui.measure");
    expect(spec!.params.props).toBeDefined();
    expect(spec!.params.occlusion).toBeDefined();
  });
});

describe("ui.input.drag — realtime reproduction surface", () => {
  it("publishes the frame recording contract inside the same control request as the drag", () => {
    const spec = getSpec("ui.input.drag");
    expect(spec?.params.recordDir).toBeDefined();
    expect(spec?.params.recordFrames).toBeDefined();
    expect(spec?.params.recordIntervalMs).toBeDefined();
    expect(spec?.params.recordMaxBytes).toBeDefined();
    expect(spec?.params.captureSteps).toBeUndefined();
  });

  it("states the observation status even when no recording is requested", async () => {
    mountNode(`<div data-node="btn">drag</div>`);
    const node = document.querySelector<HTMLElement>("[data-node=btn]")!;
    vi.spyOn(node, "getBoundingClientRect").mockReturnValue({
      x: 10, y: 10, left: 10, top: 10, right: 30, bottom: 30,
      width: 20, height: 20, toJSON: () => ({}),
    });

    const result = await execute("ui.input.drag", { from: ADDR, dx: 100 }, {});

    expect(result.data).toMatchObject({
      dragged: true,
      recording: { status: "not-requested", mode: "realtime" },
    });
  });

  it("starts the requested recording before the drag and reports the completed frames in the same response", async () => {
    mountNode(`<div data-node="btn">drag</div>`);
    const node = document.querySelector<HTMLElement>("[data-node=btn]")!;
    vi.spyOn(node, "getBoundingClientRect").mockReturnValue({
      x: 10, y: 10, left: 10, top: 10, right: 30, bottom: 30,
      width: 20, height: 20, toJSON: () => ({}),
    });
    vi.mocked(recordWindowFrames).mockImplementationOnce(() =>
      Object.assign(Promise.resolve(7), { ready: Promise.resolve(), stopped: Promise.resolve(undefined) })
    );
    const result = await execute(
      "ui.input.drag",
      {
        from: ADDR,
        dx: 100,
        steps: 3,
        durationMs: 0,
        recordDir: "<local-evidence>/drag-scan",
        recordFrames: 7,
        recordIntervalMs: 0,
        recordLeadMs: 0,
        recordMaxBytes: 4096,
      },
      {},
    );
    expect(recordWindowFrames).toHaveBeenCalledWith({
      dir: "<local-evidence>/drag-scan",
      frames: 7,
      intervalMs: 0,
      maxBytes: 4096,
      onFrame: expect.any(Function),
    });
    expect(result.data).toMatchObject({
      dragged: true,
      recording: {
        status: "complete",
        dir: "<local-evidence>/drag-scan",
        requestedFrames: 7,
        frames: 7,
        mode: "realtime",
      },
    });
  });

  it("sends no mousedown stimulus before the first stored frame is ready", async () => {
    mountNode(`<div data-node="btn">drag</div>`);
    const node = document.querySelector<HTMLElement>("[data-node=btn]")!;
    vi.spyOn(node, "getBoundingClientRect").mockReturnValue({
      x: 10, y: 10, left: 10, top: 10, right: 30, bottom: 30,
      width: 20, height: 20, toJSON: () => ({}),
    });
    const downs: string[] = [];
    node.addEventListener("mousedown", () => downs.push("down"));
    let releaseReady!: () => void;
    vi.mocked(recordWindowFrames).mockImplementationOnce(() =>
      Object.assign(Promise.resolve(1), {
        ready: new Promise<void>((resolve) => { releaseReady = resolve; }),
        stopped: Promise.resolve(undefined),
      })
    );

    const executing = execute("ui.input.drag", {
      from: ADDR,
      dx: 100,
      recordDir: "<local-evidence>/drag-baseline",
    }, {});
    await Promise.resolve();
    expect(downs).toEqual([]);
    releaseReady();
    const result = await executing;

    expect(downs).toEqual(["down"]);
    expect(result.data).toMatchObject({ dragged: true, recording: { status: "complete" } });
  });

  it.each(["ready", "final"] as const)("a realtime recording %s failure does not block the drag or the mouseup", async (phase) => {
    mountNode(`<div data-node="btn">drag</div>`);
    const node = document.querySelector<HTMLElement>("[data-node=btn]")!;
    vi.spyOn(node, "getBoundingClientRect").mockReturnValue({
      x: 10, y: 10, left: 10, top: 10, right: 30, bottom: 30,
      width: 20, height: 20, toJSON: () => ({}),
    });
    const ups: number[] = [];
    const onUp = (event: MouseEvent) => ups.push(event.clientX);
    window.addEventListener("mouseup", onUp);
    vi.mocked(recordWindowFrames).mockImplementationOnce(() =>
      phase === "ready"
        ? Object.assign(Promise.resolve(0), { ready: Promise.reject(new Error("ready failed")), stopped: Promise.resolve(undefined) })
        : Object.assign(Promise.reject(new Error("final failed")), { ready: Promise.resolve(), stopped: Promise.resolve(undefined) })
    );

    try {
      const result = await execute("ui.input.drag", {
        from: ADDR,
        dx: 100,
        recordDir: "<local-evidence>/drag-failed-recording",
      }, {});
      expect(result.data).toMatchObject({
        dragged: true,
        recording: {
          status: "failed",
          dir: "<local-evidence>/drag-failed-recording",
          requestedFrames: 120,
          mode: "realtime",
        },
      });
      expect((result.data as { recording: { reason?: string } }).recording.reason).toContain("failed");
      expect(ups).toEqual([120]);
    } finally {
      window.removeEventListener("mouseup", onUp);
    }
  });

  it.each([0, 1.5, 1_073_741_825])("rejects invalid recordMaxBytes=%s", async (recordMaxBytes) => {
    mountNode(`<div data-node="btn">drag</div>`);
    const result = await execute("ui.input.drag", {
      from: ADDR,
      dx: 100,
      recordDir: "<local-evidence>/drag-invalid-budget",
      recordMaxBytes,
    }, {});
    expect(result).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(recordWindowFrames).not.toHaveBeenCalled();
  });

  it("publishes steps and durationMs and sends one mousemove per requested step", async () => {
    const spec = getSpec("ui.input.drag");
    expect(spec?.params.steps).toBeDefined();
    expect(spec?.params.durationMs).toBeDefined();
    mountNode(`<div data-node="btn">drag</div>`);
    const node = document.querySelector<HTMLElement>("[data-node=btn]")!;
    vi.spyOn(node, "getBoundingClientRect").mockReturnValue({
      x: 10, y: 10, left: 10, top: 10, right: 30, bottom: 30,
      width: 20, height: 20, toJSON: () => ({}),
    });
    const xs: number[] = [];
    const onMove = (event: MouseEvent) => xs.push(event.clientX);
    window.addEventListener("mousemove", onMove);
    const result = await execute(
      "ui.input.drag",
      { from: ADDR, dx: 100, steps: 5, durationMs: 0 },
      {},
    );
    window.removeEventListener("mousemove", onMove);
    expect(result.ok).toBe(true);
    expect(xs).toHaveLength(5);
    expect(xs[0]).toBe(40);
    expect(xs[4]).toBe(120);
  });

  it("keeps one held pointer while following a back-and-forth path", async () => {
    mountNode(`<div data-node="btn">drag</div>`);
    const node = document.querySelector<HTMLElement>("[data-node=btn]")!;
    vi.spyOn(node, "getBoundingClientRect").mockReturnValue({
      x: 10, y: 10, left: 10, top: 10, right: 30, bottom: 30,
      width: 20, height: 20, toJSON: () => ({}),
    });
    const xs: number[] = [];
    const downs: number[] = [];
    const ups: number[] = [];
    const move = (event: MouseEvent) => xs.push(event.clientX);
    const down = () => downs.push(1);
    const up = () => ups.push(1);
    window.addEventListener("mousemove", move);
    window.addEventListener("mousedown", down);
    window.addEventListener("mouseup", up);
    const result = await execute("ui.input.drag", {
      from: ADDR,
      path: [{ dx: 100, dy: 0 }, { dx: 20, dy: 0 }, { dx: 80, dy: 0 }],
      steps: 2,
      durationMs: 0,
    }, {});
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mousedown", down);
    window.removeEventListener("mouseup", up);

    expect(result.ok).toBe(true);
    expect(downs).toHaveLength(1);
    expect(ups).toHaveLength(1);
    expect(xs).toEqual([70, 120, 80, 40, 70, 100]);
  });

  /**
 * The injected sequence must be physically coherent — while moving with the button held, buttons is 1.
   *
 * RED evidence (measured 2026-07-29, live app): a gutter drag died on the first move. The core's pointer order
 * repair (pointerOrderRepair) treats "mousemove with buttons=0 while held" as a ghost hold and fires a synthetic
 * mouseup — that protection is right, and the incoherent side was the injection.
 * The observation surface (ui.input.observe) caught that mouseup at the same instant and coordinates as the first move.
   *
 * Two contracts unaware of each other kill the feature while each one is right — so they are pinned together here.
   */
  it("buttons=1 while moving with the button held — otherwise pointer order repair closes the gesture", async () => {
    mountNode(`<div data-node="btn">drag</div>`);
    const node = document.querySelector<HTMLElement>("[data-node=btn]")!;
    vi.spyOn(node, "getBoundingClientRect").mockReturnValue({
      x: 10, y: 10, left: 10, top: 10, right: 30, bottom: 30,
      width: 20, height: 20, toJSON: () => ({}),
    });
    const seen: { type: string; buttons: number }[] = [];
    const grab = (e: Event) => seen.push({ type: e.type, buttons: (e as MouseEvent).buttons });
    for (const t of ["mousedown", "mousemove", "mouseup"]) {
      window.addEventListener(t, grab, true);
    }
    await execute("ui.input.drag", { from: ADDR, dx: 100, steps: 3, durationMs: 0 }, {});
    for (const t of ["mousedown", "mousemove", "mouseup"]) {
      window.removeEventListener(t, grab, true);
    }
    const downs = seen.filter((s) => s.type === "mousedown");
    const moves = seen.filter((s) => s.type === "mousemove");
    const ups = seen.filter((s) => s.type === "mouseup");
    expect(downs.map((d) => d.buttons)).toEqual([1]);
    expect(moves.map((m) => m.buttons)).toEqual([1, 1, 1]);
    // After release no button is held — an up with buttons=1 is incoherent as well.
    expect(ups.map((u) => u.buttons)).toEqual([0]);
  });

  /** Run it together with the real protection — where the two contracts meet is the real verdict. */
  it("the gesture runs to the end with pointer order repair active", async () => {
    const stop = startPointerOrderRepair();
    try {
      mountNode(`<div data-node="btn">drag</div>`);
      const node = document.querySelector<HTMLElement>("[data-node=btn]")!;
      vi.spyOn(node, "getBoundingClientRect").mockReturnValue({
        x: 10, y: 10, left: 10, top: 10, right: 30, bottom: 30,
        width: 20, height: 20, toJSON: () => ({}),
      });
      const ups: number[] = [];
      const onUp = (e: Event) => ups.push((e as MouseEvent).clientX);
      window.addEventListener("mouseup", onUp, true);
      await execute("ui.input.drag", { from: ADDR, dx: 100, steps: 3, durationMs: 0 }, {});
      window.removeEventListener("mouseup", onUp, true);
      // up happens exactly once, at the end. One more in between means the gesture was cut there.
      expect(ups).toEqual([120]);
    } finally {
      stop();
    }
  });
});

describe("deepActiveElement — focus through shadow", () => {
  it("returns the active element inside a shadow root through the boundary", () => {
    const leaf = document.createElement("input"); // no shadowRoot -> stop
    const host = document.createElement("div");
    const sr = host.attachShadow({ mode: "open" });
    Object.defineProperty(sr, "activeElement", { value: leaf, configurable: true });
    const root = { activeElement: host } as unknown as DocumentOrShadowRoot;
    expect(deepActiveElement(root)).toBe(leaf);
  });

  it("returns the active element unchanged when there is no shadow", () => {
    const el = document.createElement("button");
    const root = { activeElement: el } as unknown as DocumentOrShadowRoot;
    expect(deepActiveElement(root)).toBe(el);
  });

  it("returns null when there is no active element", () => {
    const root = { activeElement: null } as unknown as DocumentOrShadowRoot;
    expect(deepActiveElement(root)).toBeNull();
  });
});

describe("viewContainerOf — view resolution through shadow", () => {
  it("finds the view container of an element inside shadow across the shadow boundary", () => {
    const container = document.createElement("div");
    container.className = "tab-viewer";
    container.dataset.tabId = "tab-v9";
    document.body.appendChild(container);
    const sr = container.attachShadow({ mode: "open" });
    const input = document.createElement("input");
    sr.appendChild(input);
    // light DOM closest is blocked at the shadow boundary → go up to the host and retry.
    expect(viewContainerOf(input)).toBe(container);
  });

  it("returns null for an element outside a view container", () => {
    const loose = document.createElement("div");
    document.body.appendChild(loose);
    expect(viewContainerOf(loose)).toBeNull();
  });
});

describe("ui.input.click — a synthetic event crosses the Shadow DOM boundary (composed, equivalent to a real click)", () => {
  it("publishes the finite frame recording contract in the same request as the click", () => {
    const spec = getSpec("ui.input.click");
    expect(spec?.params.recordDir).toBeDefined();
    expect(spec?.params.recordFrames).toBeDefined();
    expect(spec?.params.recordIntervalMs).toBeDefined();
    expect(spec?.params.recordLeadMs).toBeDefined();
    expect(spec?.params.recordMaxBytes).toBeDefined();
    expect(spec?.params.traceAddresses).toBeDefined();
    expect(spec?.params.traceFrames).toBeUndefined();
  });

  it("starts frame recording before the click and returns the completed recording in the same response", async () => {
    mountNode(`<button data-node="btn">tab</button>`);
    const node = document.querySelector<HTMLElement>("[data-node=btn]")!;
    const mockedInvoke = vi.mocked(frameworkInvoke);
    mockedInvoke.mockClear();
    const order: string[] = [];
    node.addEventListener("click", () => order.push("click"));
    vi.mocked(recordWindowFrames).mockImplementationOnce(() => {
      order.push("record");
      return Object.assign(Promise.resolve(9), { ready: Promise.resolve(), stopped: Promise.resolve(undefined) });
    });

    const result = await execute("ui.input.click", {
      address: ADDR,
      recordDir: "<local-evidence>/click-transition",
      recordFrames: 9,
      recordIntervalMs: 16,
      recordLeadMs: 0,
      recordMaxBytes: 4096,
    }, {});

    expect(order).toEqual(["record", "click"]);
    expect(recordWindowFrames).toHaveBeenCalledWith({
      dir: "<local-evidence>/click-transition",
      frames: 9,
      intervalMs: 16,
      maxBytes: 4096,
      onFrame: expect.any(Function),
    });
    expect(result.data).toMatchObject({
      clicked: true,
      recording: {
        status: "complete",
        dir: "<local-evidence>/click-transition",
        requestedFrames: 9,
        frames: 9,
        mode: "realtime",
      },
    });
    mockedInvoke.mockReset();
    mockedInvoke.mockResolvedValue({});
  });

  it("sends no click stimulus before the first stored frame is ready", async () => {
    mountNode(`<button data-node="btn">tab</button>`);
    const node = document.querySelector<HTMLElement>("[data-node=btn]")!;
    const clicks: string[] = [];
    node.addEventListener("click", () => clicks.push("click"));
    let releaseReady!: () => void;
    vi.mocked(recordWindowFrames).mockImplementationOnce(() =>
      Object.assign(Promise.resolve(1), {
        ready: new Promise<void>((resolve) => { releaseReady = resolve; }),
        stopped: Promise.resolve(undefined),
      })
    );

    const executing = execute("ui.input.click", {
      address: ADDR,
      recordDir: "<local-evidence>/click-baseline",
    }, {});
    await Promise.resolve();
    expect(clicks).toEqual([]);
    releaseReady();
    const result = await executing;

    expect(clicks).toEqual(["click"]);
    expect(result.data).toMatchObject({ clicked: true, recording: { status: "complete" } });
  });

  it("states the observation status even when no recording is requested", async () => {
    mountNode(`<button data-node="btn">tab</button>`);
    const result = await execute("ui.input.click", { address: ADDR }, {});
    expect(result.data).toMatchObject({
      clicked: true,
      recording: { status: "not-requested", mode: "realtime" },
    });
  });

  it.each(["ready", "final"] as const)("a recording %s failure does not block the real click sequence", async (phase) => {
    mountNode(`<button data-node="btn">tab</button>`);
    const node = document.querySelector<HTMLElement>("[data-node=btn]")!;
    const clicks: string[] = [];
    node.addEventListener("click", () => clicks.push("click"));
    vi.mocked(recordWindowFrames).mockImplementationOnce(() =>
      phase === "ready"
        ? Object.assign(Promise.resolve(0), { ready: Promise.reject(new Error("ready failed")), stopped: Promise.resolve(undefined) })
        : Object.assign(Promise.reject(new Error("final failed")), { ready: Promise.resolve(), stopped: Promise.resolve(undefined) })
    );

    const result = await execute("ui.input.click", {
      address: ADDR,
      recordDir: "<local-evidence>/click-failed-recording",
    }, {});

    expect(clicks).toEqual(["click"]);
    expect(result.data).toMatchObject({
      clicked: true,
      recording: {
        status: "failed",
        dir: "<local-evidence>/click-failed-recording",
        requestedFrames: 40,
        mode: "realtime",
      },
    });
    expect((result.data as { recording: { reason?: string } }).recording.reason).toContain("failed");
  });

  it.each([0, 1.5, 1_073_741_825])("rejects invalid recordMaxBytes=%s", async (recordMaxBytes) => {
    mountNode(`<button data-node="btn">tab</button>`);
    const result = await execute("ui.input.click", {
      address: ADDR,
      recordDir: "<local-evidence>/click-invalid-budget",
      recordMaxBytes,
    }, {});
    expect(result).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(recordWindowFrames).not.toHaveBeenCalled();
  });

  it("returns a finite trace of public DOM coordinates and animation clock on the same clock as the recording frame events", async () => {
    mountNode(`<button data-node="btn">tab</button>`);
    let finishRecording!: () => void;
    vi.mocked(recordWindowFrames).mockImplementationOnce((request) => {
      request.onFrame?.(0);
      const finished = new Promise<number>((resolve) => {
        finishRecording = () => {
          request.onFrame?.(1);
          resolve(2);
        };
      });
      return Object.assign(finished, { ready: Promise.resolve(), stopped: Promise.resolve(undefined) });
    });
    const executing = execute("ui.input.click", {
      address: ADDR,
      recordDir: "<local-evidence>/click-trace",
      recordFrames: 2,
      traceAddresses: [ADDR],
    }, {});
    finishRecording();
    const result = await executing;
    expect(result.data).toMatchObject({
      clicked: true,
      recording: { status: "complete", frames: 2 },
      trace: {
        frames: 2,
        samples: [
          { captureFrame: 0, nodes: [{ address: ADDR }] },
          { captureFrame: 1, nodes: [{ address: ADDR }] },
        ],
      },
    });
  });

  it("keeps stored frames and DOM trace samples 1:1 even when the final recording fails", async () => {
    mountNode(`<button data-node="btn">tab</button>`);
    vi.mocked(recordWindowFrames).mockImplementationOnce((request) => {
      request.onFrame?.(0);
      request.onFrame?.(1);
      return Object.assign(Promise.reject(new Error("record tail failed")), {
        ready: Promise.resolve(),
        stopped: Promise.resolve(undefined),
      });
    });

    const result = await execute("ui.input.click", {
      address: ADDR,
      recordDir: "<local-evidence>/click-trace-failed-tail",
      recordFrames: 3,
      traceAddresses: [ADDR],
    }, {});

    expect(result.data).toMatchObject({
      clicked: true,
      recording: { status: "failed", requestedFrames: 3, frames: 2 },
      trace: {
        frames: 2,
        samples: [
          { captureFrame: 0, nodes: [{ address: ADDR }] },
          { captureFrame: 1, nodes: [{ address: ADDR }] },
        ],
      },
    });
  });

  it("rejects a DOM trace requested alone so no separate rAF clock is created", async () => {
    mountNode(`<button data-node="btn">tab</button>`);
    const result = await execute("ui.input.click", {
      address: ADDR,
      traceAddresses: [ADDR],
    }, {});
    expect(result).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  });

  it("a click on a node inside shadow lands on the capture listener outside the boundary (the body click activation path)", async () => {
    // Equivalent to the real structure: view container (scan scope) > shadow host > data-node inside shadow.
    // The outer capture listener = the same positional relation as GroupArea's body slot click activation path.
    const container = document.createElement("div");
    container.className = "tab-viewer";
    container.dataset.viewAddr = "center/view/tplug.v";
    container.dataset.tabId = "tab-p1";
    document.body.appendChild(container);
    const host = document.createElement("div");
    container.appendChild(host);
    const sr = host.attachShadow({ mode: "open" });
    const btn = document.createElement("button");
    btn.setAttribute("data-node", "sbtest/leaf");
    sr.appendChild(btn);
    const seen: boolean[] = [];
    container.addEventListener("mousedown", (e) => seen.push(e.composed), true);

    const tree = (await execute("ui.tree", {}, {})) as unknown as {
      ok: boolean;
      data: { nodes: { address: string }[] };
    };
    const addr = tree.data.nodes.map((n) => n.address).find((a) => a.includes("sbtest/leaf"));
    expect(addr).toBeTruthy(); // the node scan must pierce shadow and expose it
    const r = (await execute("ui.input.click", { address: addr }, {})) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(seen).toEqual([true]); // it crossed the boundary and is composed
  });
});

describe("ui.focus.state — widget-level focus discrimination axes", () => {
  // Measured defect: settled=true (activeElement containment check) while the terminal cursor was not drawn —
  // the user's criterion is "focus landed = black cursor". DOM activeElement alone cannot separate whether the
  // widget (xterm) treats itself as focused (focus event received, focus class, cursor paint) from whether the
  // window is key (document.hasFocus — a non-key window makes the widget skip the cursor). Both axes are
  // exposed as an observation surface: windowFocused + the activeElement ancestor class chain.
  it("reports windowFocused (document.hasFocus) and the activeElement.ancestors class chain", async () => {
    mountNode(
      `<div data-node="btn" class="terminal xterm focus"><textarea class="xterm-helper-textarea"></textarea></div>`,
    );
    const ta = document.querySelector("textarea") as HTMLTextAreaElement;
    ta.focus();
    const orig = document.hasFocus;
    Object.defineProperty(document, "hasFocus", {
      value: () => true,
      configurable: true,
    });
    try {
      const r = await execute("ui.focus.state", {}, {});
      expect(r.ok).toBe(true);
      const d = r.data as {
        windowFocused?: boolean;
        activeElement?: { ancestors?: { tag: string; className: string }[] };
      };
      expect(d.windowFocused).toBe(true);
      const chain = (d.activeElement?.ancestors ?? [])
        .map((a) => a.className)
        .join("|");
      expect(chain).toContain("focus"); // the widget focus class appears in the chain
    } finally {
      Object.defineProperty(document, "hasFocus", {
        value: orig,
        configurable: true,
      });
    }
  });
});

describe("ui.focus.trace — focus causality timeline at the instant of a click", () => {
  // Reading state after the fact is polluted (when the user leaves the window, blur returns activeElement to body).
  // What takes focus and what steals it at "that instant" of a real device click is testified only by the event
  // timeline. start registers focusin/focusout/mousedown/mouseup listeners and stops itself after ms
  // (no endless watching) — read returns the record.
  it("caps at 3 minutes — one timeline holds a full round of real user operation (repeated attempts at an intermittent case)", async () => {
    const r = await execute("ui.focus.trace.start", { ms: 999_999_999 }, {});
    expect(r.ok).toBe(true);
    expect((r.data as { ms: number }).ms).toBe(180_000);
  });

  it("start, record events, read — and stops itself after ms elapses", async () => {
    vi.useFakeTimers();
    try {
      const s = await execute("ui.focus.trace.start", { ms: 500 }, {});
      expect(s.ok).toBe(true);
      mountNode(`<button data-node="btn">x</button>`);
      const el = document.querySelector('[data-node="btn"]') as HTMLElement;
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      const r1 = await execute("ui.focus.trace.read", {}, {});
      expect(r1.ok).toBe(true);
      const d1 = r1.data as { recording: boolean; events: { type: string; dataNode: string | null }[] };
      expect(d1.recording).toBe(true);
      expect(d1.events.map((e) => e.type)).toEqual(["mousedown", "focusin"]);
      expect(d1.events[0].dataNode).toBe("btn");
      vi.advanceTimersByTime(600);
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); // events after the stop are not recorded
      const r2 = await execute("ui.focus.trace.read", {}, {});
      const d2 = r2.data as { recording: boolean; events: unknown[] };
      expect(d2.recording).toBe(false);
      expect(d2.events.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records which pane and tab own both the event target and the actual input focus", async () => {
    document.body.innerHTML = `
      <div data-pane="pan-source"><div class="tab-viewer" data-view-addr="center/view/p.v" data-tab-id="tab-source">
        <div class="terminal xterm focus"><textarea data-node="input"></textarea></div>
      </div></div>
      <div data-pane="pan-target"><div class="tab-viewer" data-view-addr="center/view/p.v" data-tab-id="tab-target">
        <div data-node="target"></div>
      </div></div>`;
    const input = document.querySelector("textarea")!;
    const target = document.querySelector('[data-node="target"]')!;
    input.focus();
    await execute("ui.focus.trace.start", { ms: 500 }, {});
    input.dispatchEvent(new CompositionEvent("compositionupdate", { data: "x", bubbles: true }));
    target.dispatchEvent(new MouseEvent("mousedown", { clientX: 40, clientY: 60, bubbles: true }));

    const result = await execute("ui.focus.trace.read", {}, {});
    const events = (result.data as { events: Array<Record<string, unknown>> }).events;
    expect(events[0]).toMatchObject({
      type: "compositionupdate", targetTabId: "tab-source", targetPaneId: "pan-source",
      activeTabId: "tab-source", activePaneId: "pan-source", composition: "x",
      inputLanded: true,
    });
    expect(events[1]).toMatchObject({
      type: "mousedown", targetTabId: "tab-target", targetPaneId: "pan-target",
      activeTabId: "tab-source", activePaneId: "pan-source", x: 40, y: 60,
      inputLanded: true,
    });
  });
});

describe("ui.input.click — phase split (makes the mid-gesture state verifiable)", () => {
  // Bundling down→up→click into one call makes the middle of the gesture (after mousedown, before mouseup)
  // unobservable from outside — features whose contract is that middle state, like mid-gesture hit ability or
  // deferred activation, become unverifiable. phase splits the sequence so after down, ui.hit/ui.measure verify
  // the middle state and up finishes it.
  it('phase:"down" sends only mousedown, phase:"up" sends only mouseup and click', async () => {
    mountNode(`<button data-node="btn">x</button>`);
    const el = document.querySelector('[data-node="btn"]')!;
    const seen: string[] = [];
    for (const t of ["mousedown", "mouseup", "click"])
      el.addEventListener(t, () => seen.push(t));
    const down = await execute("ui.input.click", { address: ADDR, phase: "down" }, {});
    expect(down.ok).toBe(true);
    expect(seen).toEqual(["mousedown"]);
    const up = await execute("ui.input.click", { address: ADDR, phase: "up" }, {});
    expect(up.ok).toBe(true);
    expect(seen).toEqual(["mousedown", "mouseup", "click"]);
  });

  it("the ui.hit result returns tag and rect intact — no collision with the envelope reserved key 'data'", async () => {
    // Measured defect: the handler payload field was named data, an envelope reserved key, so normalization kept
    // only that value and dropped tag/className/rect entirely — every coordinate was reported as "no element"
    // (live w-d9683c0c, a terminal center hit was canvas but reported null). Domain payloads do not use reserved
    // keys (ok/code/message/data/media) — dataset naming is aligned with ui.measure.
    const btn = document.createElement("button");
    btn.dataset.node = "hit-target";
    document.body.appendChild(btn);
    const orig = document.elementFromPoint;
    Object.defineProperty(document, "elementFromPoint", {
      value: () => btn,
      configurable: true,
    });
    try {
      const r = await execute("ui.hit", { x: 5, y: 5 }, {});
      expect(r.ok).toBe(true);
      const d = r.data as { tag?: string; dataset?: Record<string, string> };
      expect(d.tag).toBe("button");
      expect(d.dataset).toMatchObject({ node: "hit-target" });
    } finally {
      Object.defineProperty(document, "elementFromPoint", {
        value: orig,
        configurable: true,
      });
    }
  });

  it("ui.hit answers the declared owner chain of that point from the top — a consumer does not reinvent the chain", async () => {
    // The input for layer order judgment must be the command response. If consumers splice dataset/host/painters
    // together, an ancestor with a transparent background drops out of the chain and "who is on top" differs per
    // consumer (the spot where a harness just writes target in). closest cannot cross the shadow boundary, so it climbs to the host.
    const outer = document.createElement("div");
    outer.dataset.node = "modal/workspace-new";
    const card = document.createElement("div");
    card.dataset.node = "modal/workspace-new/card";
    const shadowHost = document.createElement("div");
    const sr = shadowHost.attachShadow({ mode: "open" });
    const icon = document.createElement("span"); // no data-node of its own
    sr.appendChild(icon);
    card.appendChild(shadowHost);
    outer.appendChild(card);
    document.body.appendChild(outer);
    const orig = document.elementFromPoint;
    Object.defineProperty(document, "elementFromPoint", { value: () => icon, configurable: true });
    try {
      const r = await execute("ui.hit", { x: 5, y: 5 }, {});
      expect(r.ok).toBe(true);
      const d = r.data as { owners?: string[] };
      expect(d.owners).toEqual(["modal/workspace-new/card", "modal/workspace-new"]);
    } finally {
      Object.defineProperty(document, "elementFromPoint", { value: orig, configurable: true });
    }
  });

  // The chain is the ancestor path. For a consumer (the B09 gate) to read "who owns this spot" as chain containment,
  // the core must answer that name shape and containment are different facts — they split both ways.
  it("a name prefix is not containment — a sibling drops out and a descendant in another namespace comes in", async () => {
    const sidebar = document.createElement("div");
    sidebar.dataset.node = "sidebar/right";
    // A node id declared by a plugin view. It is a name in its own namespace, so it has no prefix, but it is a real descendant.
    const pluginNode = document.createElement("input");
    pluginNode.dataset.node = "search-input";
    sidebar.appendChild(pluginNode);
    // A sibling that is only a name below (App.tsx's resizer placement). Reading the prefix as ownership makes outside the sidebar inside.
    const resizer = document.createElement("div");
    resizer.dataset.node = "sidebar/right/resizer";
    document.body.append(sidebar, resizer);
    const orig = document.elementFromPoint;
    try {
      Object.defineProperty(document, "elementFromPoint", {
        value: () => pluginNode,
        configurable: true,
      });
      const inside = await execute("ui.hit", { x: 5, y: 5 }, {});
      expect((inside.data as { owners?: string[] }).owners).toEqual([
        "search-input",
        "sidebar/right",
      ]);

      Object.defineProperty(document, "elementFromPoint", {
        value: () => resizer,
        configurable: true,
      });
      const sibling = await execute("ui.hit", { x: 5, y: 5 }, {});
      expect((sibling.data as { owners?: string[] }).owners).toEqual(["sidebar/right/resizer"]);
    } finally {
      Object.defineProperty(document, "elementFromPoint", { value: orig, configurable: true });
    }
  });

  it("a point with no declared owner answers an empty chain — absence is not filled in as presence", async () => {
    const plain = document.createElement("div");
    document.body.appendChild(plain);
    const orig = document.elementFromPoint;
    Object.defineProperty(document, "elementFromPoint", { value: () => plain, configurable: true });
    try {
      const r = await execute("ui.hit", { x: 5, y: 5 }, {});
      expect((r.data as { owners?: string[] }).owners).toEqual([]);
    } finally {
      Object.defineProperty(document, "elementFromPoint", { value: orig, configurable: true });
    }
  });

  it("omitting phase sends the same three-event sequence as before (backward compatible)", async () => {
    mountNode(`<button data-node="btn">x</button>`);
    const el = document.querySelector('[data-node="btn"]')!;
    const seen: string[] = [];
    for (const t of ["mousedown", "mouseup", "click"])
      el.addEventListener(t, () => seen.push(t));
    await execute("ui.input.click", { address: ADDR }, {});
    expect(seen).toEqual(["mousedown", "mouseup", "click"]);
  });
});

describe("ui.input.key — drive surface for paths open only to the keyboard", () => {
  // Paths like palette arrows, Esc, Ctrl+R cannot be verified by click injection. With no surface there,
  // "the keyboard path could not be checked" is what remains. So keys are injected, and whether the handler
  // took the key (defaultPrevented) is returned too — swallowed or passed through is decided from outside.
  it("injects keydown and keyup on an exposed node and reports the modifiers and whether the key was consumed", async () => {
    mountNode(`<div data-node="btn" tabindex="0">x</div>`);
    const el = document.querySelector("[data-node=btn]") as HTMLElement;
    const seen: string[] = [];
    el.addEventListener("keydown", (e) => {
      seen.push(`down:${e.key}:${e.ctrlKey ? "ctrl" : ""}`);
      if (e.key === "r") e.preventDefault(); // the handler took it
    });
    el.addEventListener("keyup", (e) => seen.push(`up:${e.key}`));

    const r = await execute("ui.input.key", { address: ADDR, key: "r", ctrl: true }, {});
    expect(r.ok).toBe(true);
    expect(seen).toEqual(["down:r:ctrl", "up:r"]);
    expect((r.data as { defaultPrevented: boolean }).defaultPrevented).toBe(true);

    const fell = await execute("ui.input.key", { address: ADDR, key: "ArrowDown" }, {});
    expect((fell.data as { defaultPrevented: boolean }).defaultPrevented).toBe(false);
  });

  it("NOT_EXPOSED for an unexposed address, INVALID_PARAMS for an empty key — no guessing", async () => {
    mountNode(`<div data-node="btn">x</div>`);
    const ghost = await execute("ui.input.key", { address: "win/main/center/view/test.v/node/nope", key: "Enter" }, {});
    expect(ghost.ok).toBe(false);
    expect(ghost.code).toBe("NOT_EXPOSED");
    const empty = await execute("ui.input.key", { address: ADDR, key: "" }, {});
    expect(empty.ok).toBe(false);
    expect(empty.code).toBe("INVALID_PARAMS");
  });

  it("applies the browser text-input default for an unconsumed printable key", async () => {
    mountNode(`<textarea data-node="btn"></textarea>`);
    const input = document.querySelector("[data-node=btn]") as HTMLTextAreaElement;
    const values: string[] = [];
    input.addEventListener("input", () => values.push(input.value));

    const result = await execute("ui.input.key", { address: ADDR, key: "x" }, {});
    expect(result).toMatchObject({ ok: true, data: { defaultPrevented: false } });
    expect(values).toEqual(["x"]);
    expect(input.value).toBe("x");
  });
});

describe("ui.input.scroll — bring an exposed node into its scroll viewport", () => {
  it("uses scrollIntoView and returns the before/after rectangles", async () => {
    mountNode(`<div data-node="btn">x</div>`);
    const el = document.querySelector("[data-node=btn]") as HTMLElement;
    let y = 900;
    vi.spyOn(el, "getBoundingClientRect").mockImplementation(() => ({
      x: 10, y, top: y, left: 10, right: 110, bottom: y + 20,
      width: 100, height: 20, toJSON: () => ({}),
    }));
    const scrollIntoView = vi.fn(() => { y = 120; });
    el.scrollIntoView = scrollIntoView;

    const result = await execute("ui.input.scroll", { address: ADDR, block: "center" }, {});

    expect(result.ok).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "instant", block: "center", inline: "nearest" });
    expect(result.data).toMatchObject({ address: ADDR, before: { y: 900 }, after: { y: 120 }, dx: 0, dy: -780 });
  });
});

// ui.verify's tab.sized — a diagnosis must state for itself what it scanned.
//
// (Measured defect) After the tab body's DOM address moved from layout/slot/ to layout/tab/, this check was still
// scanning the old prefix. With 0 targets there are 0 violations, so the check always passes — that is not a pass,
// it is a closed eye. So two things are pinned together here: ① it actually catches a collapsed body,
// ② even on a pass it reports the scanned count (scanning 0 and passing shows that count as 0).
type VerifyRes = { passed: boolean; failed: number; checks: { name: string; ok: boolean; detail: string }[] };

function mountTabBody(id: string, rect: { width: number; height: number }): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-node", `layout/tab/${id}`);
  document.body.appendChild(el);
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => ({
      x: 0, y: 0, top: 0, left: 0,
      width: rect.width,
      height: rect.height,
      right: Math.max(rect.width, 1), // passes the onScreen verdict
      bottom: Math.max(rect.height, 1),
      toJSON: () => ({}),
    }),
    configurable: true,
  });
  return el;
}

describe("ui.verify — tab.sized actually scans the tab bodies", () => {
  const sized = (r: VerifyRes) => r.checks.find((c) => c.name === "tab.sized")!;

  it("a sized body passes and the answer reports the scanned count", async () => {
    mountTabBody("tab-a", { width: 800, height: 600 });
    const r = (await execute("ui.verify", {}, {})).data as unknown as VerifyRes;
    const check = sized(r);
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("1"); // scanning 0 and passing shows 0 here
  });

  it("catches a visible body with zero size — that cell is a blank screen", async () => {
    mountTabBody("tab-a", { width: 800, height: 600 });
    mountTabBody("tab-collapsed", { width: 0, height: 600 });
    const r = (await execute("ui.verify", {}, {})).data as unknown as VerifyRes;
    const check = sized(r);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("layout/tab/tab-collapsed");
    // The verdict is passed in the payload (ok is an envelope reserved key — placed here it is swallowed).
    expect(r.passed).toBe(false);
    expect(r.failed).toBe(1);
  });
});

// The gutter highlight of ui.input.pointer — arming and clearing must be observable on the same surface.
//
// (Measured defect) After the gutter element's anchor moved from data-divider-key to data-gutter-key, this command
// was still reading the old name. The highlight then never turns on, but the answer is just gutterHover: null, which
// is indistinguishable from "that spot is not a gutter" — the failure disguises itself as a normal response.
describe("ui.input.pointer — the gutter highlight arms and clears as state", () => {
  const GUTTER = "gutter/pan-a/right";

  function mountGutter(): void {
    document.body.innerHTML = "";
    const el = document.createElement("div");
    el.setAttribute("data-node", GUTTER);
    el.dataset.gutterKey = GUTTER; // the anchor GroupArea plants
    document.body.appendChild(el);
  }

  it("entering a gutter arms that gutter address and the answer reports the armed key", async () => {
    mountGutter();
    const r = await execute("ui.input.pointer", { address: `win/main/chrome/${GUTTER}` }, {});
    expect(r.ok).toBe(true);
    expect((r.data as { gutterHover: string | null }).gutterHover).toBe(GUTTER);
  });

  it("calling without an address (leave) clears it and the answer reports the clear", async () => {
    mountGutter();
    await execute("ui.input.pointer", { address: `win/main/chrome/${GUTTER}` }, {});
    const r = await execute("ui.input.pointer", {}, {});
    expect(r.ok).toBe(true);
    expect((r.data as { gutterHover: string | null }).gutterHover).toBeNull();
  });
});

/** Inside a content view is another process, so a click made through the DOM does not land there. And even if it did,
 *  there is no user activation, so the engine blocks things like window opening (measured 2026-08-02: pressing a
 *  `_blank` link by script produced 0 window-open requests). So when this command points at a content view, it puts
 *  real input inside — and creating one where there is none is part of this site's job (A27). */
describe("ui.input.click — pointing at a content view puts the input inside it", () => {
  /** A content view is not a descendant of the tab node — it is placed on a surface outside the pane. Building it as
   *  a descendant measures a world different from the real one, and that GREEN proves nothing (measured 2026-08-02:
   *  the descendant-built check was GREEN while the live app leaked through DOM clicks). */
  function plantContentView() {
    mountNode(`<div data-node="layout/tab/tab-probe"></div>`);
    const view = document.createElement("div");
    view.setAttribute("data-content-view", "browser.main.tab-probe");
    // The plugin declares the surface and its label; the core reads that rather than rebuilding one.
    view.setAttribute("data-native-surface", "browser");
    view.setAttribute("data-native-surface-id", "browser.main.tab-probe");
    view.id = "cv";
    Object.defineProperty(view, "getBoundingClientRect", {
      value: () => ({ left: 100, top: 50, width: 200, height: 100, right: 300, bottom: 150 }),
    });
    document.body.appendChild(view);
  }

  /** The address is obtained through the discovery path — hand-built, only the check dies quietly the day its format changes. */
  async function probeAddress(): Promise<string> {
    const r = (await execute("ui.tree", {}, {})) as {
      data?: { nodes?: { address: string; nodePath: string }[] };
    };
    const hit = r.data?.nodes?.find((n) => n.nodePath.endsWith("layout/tab/tab-probe"));
    if (!hit) throw new Error("tab node not found in the tree — it is not exposed");
    return hit.address;
  }

  it.each([undefined, "down", "up"] as const)(
    "the surface %s phase success receipt echoes the declared causeTraceId",
    async (phase) => {
      plantContentView();
      const address = await probeAddress();
      const result = await execute("ui.input.click", {
        address,
        causeTraceId: "surface-trace-echo",
        ...(phase === undefined ? {} : { phase }),
      }, {});

      expect(result.data).toMatchObject({ causeTraceId: "surface-trace-echo" });
    },
  );

  it("puts the input inside through the host contract — not a DOM click", async () => {
    plantContentView();
    const address = await probeAddress();
    let domClicks = 0;
    document.getElementById("cv")!.addEventListener("mousedown", () => (domClicks += 1));
    const r = (await execute("ui.input.click", { address }, {})) as {
      ok: boolean;
      data?: { surface?: string };
    };
    expect(r.ok).toBe(true);
    expect(r.data?.surface).toBe("browser.main.tab-probe");
    // A press and a release must be paired for a click — sending only the press leaves that surface half-pressed.
    expect(sentInput).toEqual([
      ["browser.main.tab-probe", { x: 0, y: 0, kind: "down", button: "left", clickCount: 1 }],
      ["browser.main.tab-probe", { x: 0, y: 0, kind: "up", button: "left", clickCount: 1 }],
    ]);
    expect(domClicks).toBe(0);
  });

  // Coordinates are surface-local. Where the view is placed on screen is no business of the page inside it —
  // using the viewport position (100,50) as the default presses (100,50) inside the page when the top-left was asked for.
  it("the offset is surface coordinates — top left by default, wherever the view is on screen", async () => {
    plantContentView();
    const address = await probeAddress();
    await execute("ui.input.click", { address, x: 7, y: 9 }, {});
    expect(sentInput).toEqual([
      ["browser.main.tab-probe", { x: 7, y: 9, kind: "down", button: "left", clickCount: 1 }],
      ["browser.main.tab-probe", { x: 7, y: 9, kind: "up", button: "left", clickCount: 1 }],
    ]);
  });
});

describe("ui.input.click — projected realm coordinates use the producer's surface-local declaration", () => {
  it("sends the exact local center regardless of the projection container's screen position or DOM parent", async () => {
    mountNode(`
      <div data-node="plugin-view/rlm-realm/urlbar"
        data-realm="rlm-realm" data-realm-node="urlbar"
        data-realm-x="128" data-realm-y="3"></div>
    `);
    const el = document.querySelector<HTMLElement>("[data-realm=rlm-realm]")!;
    Object.defineProperty(el, "getBoundingClientRect", {
      value: () => ({ left: 348, top: 124, width: 228, height: 22, right: 576, bottom: 146 }),
    });

    const result = await execute("ui.input.click", {
      address: "win/main/center/view/test.v/node/plugin-view/rlm-realm/urlbar",
    }, {});

    expect(result.ok).toBe(true);
    expect(sentInput).toEqual([
      ["rlm-realm", { x: 242, y: 14, kind: "down", button: "left", clickCount: 1 }],
      ["rlm-realm", { x: 242, y: 14, kind: "up", button: "left", clickCount: 1 }],
    ]);
  });
});
