// The presentation ledger self-audit recovers only the product axes the event itself proves — surface identity, survival, paint.
// The callback interval is determined jointly by variable refresh rate and observation latency, so it is not reclassified as a product violation.
import { describe, expect, it } from "vitest";
import {
  PRESENTATION_AUDITABLE_VIOLATIONS,
  auditPresentationReceipt,
  presentationEventsToCover,
  recomputePresentationViolations,
} from "./presentationLedgerAudit";
import {
  __resetPresentationLedgerForTest,
  registerPresentationLedgerHost,
} from "./presentationLedger";
import { PRESENTATION_CLOCK, PRESENTATION_CLOCK_OWNER } from "../lib/presentationClock";
import { getSpec } from "../commands/registry";
import type { CommandContext } from "../commands/registry";
import type {
  PresentationDisplayEvent,
  PresentationTraceReceipt,
  PresentationViolations,
} from "./presentationLedger";

const REFRESH_120HZ = 8.333251953125;
const REFRESH_60HZ = 16.680419921875;

// A surface identity is the label the declaring plugin put on it — `<kind>-<window>-<viewId>`
// (lib/surfaceLabels.ts). The audit compares identities across frames, so the fixture uses the
// value an issuer produces: the plugin's kind, the host's window name, the view id from state/ids.ts.
const SURFACE_ID = "browser.win-h3d5qm.tab-k6jivs";

function surface(overrides: Record<string, unknown> = {}) {
  return {
    viewId: "tab-k6jivs",
    surfaceId: SURFACE_ID,
    generation: 1,
    live: true,
    visible: true,
    painted: true,
    domFrame: { x: 0, y: 0, w: 640, h: 480 },
    surfaceFrame: { x: 0, y: 0, w: 640, h: 480 },
    ...overrides,
  } as PresentationDisplayEvent["surfaces"][number];
}

/** Places display epochs at interval multiples, like a real ledger. `steps` is the number of intervals elapsed since the previous frame. */
function ledger(steps: readonly number[], refreshIntervalMs = REFRESH_120HZ) {
  const events: PresentationDisplayEvent[] = [];
  let displayedAt = 1_786_084_035_298.228;
  steps.forEach((step, index) => {
    if (index > 0) displayedAt += refreshIntervalMs * step;
    events.push({
      sequence: index,
      sourceGeneration: 1,
      presentationRevision: index + 1,
      displayTimestampUnixMs: displayedAt,
      targetTimestampUnixMs: displayedAt + refreshIntervalMs,
      callbackObservedAtUnixMs: displayedAt + 0.4,
      refreshIntervalMs,
      presentedAtUnixMs: displayedAt,
      surfaces: [surface()],
    });
  });
  return events;
}

function receipt(
  presentationEvents: PresentationDisplayEvent[],
  violations: Partial<PresentationViolations> = {},
): Pick<PresentationTraceReceipt, "clock" | "presentationEvents" | "violations"> {
  return {
    clock: PRESENTATION_CLOCK,
    presentationEvents,
    violations: {
      replacements: 0, disappearances: 0, unpresented: 0, droppedEvents: 0, ...violations,
    },
  };
}

describe("presentation ledger self-audit", () => {
  it("does not turn a variable refresh callback interval into a product violation axis", () => {
    const adaptive = receipt(ledger([1, 1, 1, 1.5, 1, 1]));
    expect(auditPresentationReceipt(adaptive)).toEqual({ ok: true, underReported: [], errors: [] });
  });

  it("reports no under-counted axis for an even display train", () => {
    const audit = auditPresentationReceipt(receipt(ledger([1, 1, 1, 1, 1, 1], REFRESH_60HZ)));
    expect(audit).toEqual({ ok: true, underReported: [], errors: [] });
  });

  it("observation latency does not change the product violation counts", () => {
    const events = ledger([1, 1, 1, 1, 1, 1], REFRESH_60HZ);
    events[3].callbackObservedAtUnixMs = events[2].callbackObservedAtUnixMs + 29.75;
    expect(recomputePresentationViolations(events)).toEqual({
      replacements: 0, disappearances: 0, unpresented: 0,
    });
    expect(auditPresentationReceipt(receipt(events)).ok).toBe(true);
  });

  it("does not read a frame whose interval changed as a skip under a variable refresh rate", () => {
    // A 60Hz frame after a 120Hz frame: the actual 16.68ms interval is the next display time declared by the previous frame.
    const events = ledger([1, 1, 1], REFRESH_120HZ);
    const pivot = events[1];
    pivot.refreshIntervalMs = REFRESH_60HZ;
    pivot.targetTimestampUnixMs = pivot.displayTimestampUnixMs + REFRESH_60HZ;
    events[2].displayTimestampUnixMs = pivot.targetTimestampUnixMs;
    events[2].presentedAtUnixMs = events[2].displayTimestampUnixMs;
    expect(recomputePresentationViolations(events)).toEqual({
      replacements: 0, disappearances: 0, unpresented: 0,
    });
  });

  it("recovers disappearance, unpresented and replacement counts from the events themselves", () => {
    const events = ledger([1, 1, 1]);
    // An invisible surface is a disappearance, not a replacement — the identity (surfaceId·generation) is unchanged.
    events[1].surfaces = [surface({ visible: false })];
    events[2].surfaces = [surface({ painted: false, generation: 2 })];
    expect(recomputePresentationViolations(events)).toEqual({
      replacements: 1, disappearances: 1, unpresented: 1,
    });
    expect(auditPresentationReceipt(receipt(events)).errors).toEqual([
      "violations.replacements=1/0",
      "violations.disappearances=1/0",
      "violations.unpresented=1/0",
    ]);
  });

  it("a report larger than the recovered count is not a defect when events were dropped", () => {
    const audit = auditPresentationReceipt(
      receipt(ledger([1, 1, 1]), { disappearances: 3, unpresented: 3, droppedEvents: 135 }),
    );
    expect(audit.ok).toBe(true);
  });

  it("rejects a non-numeric product violation axis by name", () => {
    const broken = receipt(ledger([1, 1, 1]));
    (broken.violations as unknown as Record<string, unknown>).unpresented = null;
    expect(auditPresentationReceipt(broken).errors).toEqual(["violations.unpresented=integer/null"]);
  });

  it("droppedEvents is not a recoverable axis — an event never recorded cannot be recovered", () => {
    expect(PRESENTATION_AUDITABLE_VIOLATIONS).not.toContain("droppedEvents");
  });
});

describe("close includes the audit in the receipt", () => {
  it("the receipt includes selfAudit — the facts arrive without a caller request", async () => {
    __resetPresentationLedgerForTest();
    const events = ledger([1, 1, 1, 2.5, 1, 1]);
    registerPresentationLedgerHost({
      owners: async () => [],
      arm: async () => ({
        traceId: "t-1", clock: PRESENTATION_CLOCK, clockOwner: PRESENTATION_CLOCK_OWNER,
        ownerViewIds: ["tab-k6jivs"], armedAtUnixMs: 0,
        baselineFrameSequence: 0, sourceGeneration: 1,
      }),
      prepareCheckpoint: async ({ traceId, trigger }) => ({
        traceId, checkpointId: "checkpoint-1", trigger, registeredAfterFrameSequence: 0,
        registeredAfterPresentationRevision: 1, sourceGeneration: 1,
        baselineSurfaces: [{
          viewId: "tab-k6jivs", surfaceId: SURFACE_ID, generation: 1,
          domFrame: { x: 0, y: 0, w: 100, h: 100 },
          surfaceFrame: { x: 0, y: 0, w: 100, h: 100 },
        }],
      }),
      readCheckpoint: async ({ traceId }) => ({
        traceId, trigger: "next-display", frameSequence: 1,
        sourceGeneration: 1, presentationRevision: 2,
        clock: PRESENTATION_CLOCK, clockOwner: PRESENTATION_CLOCK_OWNER, presentedAtUnixMs: 16,
      }),
      close: async ({ traceId }) => ({
        traceId,
        clock: PRESENTATION_CLOCK,
        clockOwner: PRESENTATION_CLOCK_OWNER,
        closed: true,
        ownerViewIds: ["tab-k6jivs"],
        armedAtUnixMs: 0,
        baselineFrameSequence: 0,
        presentationEvents: events,
        violations: {
          replacements: 0, disappearances: 0, unpresented: 0, droppedEvents: 0,
        },
        observation: { callbackIntervalsSkipped: 1, maxCallbackLatencyMs: 0 },
      }),
    });
    const spec = getSpec("view.presentation.trace.close");
    expect(spec).toBeTruthy();
    const closed = await spec!.handler({ traceId: "t-1" }, {} as CommandContext) as {
      selfAudit: { ok: boolean; errors: string[] };
    };
    expect(closed.selfAudit).toEqual({ ok: true, underReported: [], errors: [] });
    __resetPresentationLedgerForTest();
  });
});

describe("capacity that covers the display window", () => {
  it("the same window requires a different count at each refresh rate", () => {
    // The count needed to cover the window the harness declares (settle 8s + hold 310ms). 512 is correct only at 60Hz.
    expect(presentationEventsToCover({ coverMs: 8_310, refreshIntervalMs: REFRESH_60HZ })).toBe(500);
    expect(presentationEventsToCover({ coverMs: 8_310, refreshIntervalMs: REFRESH_120HZ })).toBe(999);
  });

  it("retraces the measured loss — 512 does not cover 4.27s at 120Hz", () => {
    // Measured: the trace stayed open 4270.8ms and the 512 slots filled up, losing 135 actual display frames.
    expect(presentationEventsToCover({ coverMs: 4_270.8, refreshIntervalMs: REFRESH_120HZ }))
      .toBeGreaterThan(512);
  });

  it("both the window and the interval must be positive", () => {
    expect(() => presentationEventsToCover({ coverMs: 0, refreshIntervalMs: REFRESH_60HZ }))
      .toThrow(/coverMs/);
    expect(() => presentationEventsToCover({ coverMs: 100, refreshIntervalMs: 0 }))
      .toThrow(/refreshIntervalMs/);
  });
});

// Rule — clock declaration: the name `...UnixMs` does not mean the same clock. The producer of a ledger must
// declare its own clock before its times can be compared on one axis with another producer's. A ledger with no
// declaration cannot be a decision input, and that absence must surface as a name, not a silent 0.
describe("clock declaration", () => {
  it("a receipt with no declared clock fails the audit by name", () => {
    const base = receipt(ledger([1, 1, 1]));
    const { clock: _clock, ...withoutClock } = base;
    const audit = auditPresentationReceipt(withoutClock as typeof base);
    expect(audit.ok).toBe(false);
    expect(audit.errors).toEqual(expect.arrayContaining(["clock=non-empty/undefined"]));
  });

  it("a receipt with a declared clock does not fail on that axis", () => {
    const audit = auditPresentationReceipt(receipt(ledger([1, 1, 1])));
    expect(audit.errors.some((error) => error.startsWith("clock="))).toBe(false);
  });
});
