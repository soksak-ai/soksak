// ui.* DOM address commands — query, measure, and manipulate the DOM through structural path addresses
// (no arbitrary selectors).
//
// Single truth: address grammar in address.ts, node collection in nodeScan.ts. This file exposes both as
// socket commands.
//  - ui.tree:        the exposed DOM address tree plus the opaque nodeIdentity of the live Element.
//  - ui.measure:     address → nodeIdentity + rect + computed style. Selectors rejected; addresses only.
//  - ui.input.click: address → click dispatch on the element (danger:inject). A mismatch is NOT_EXPOSED.
// An element not exposed through data-node is absent from the address tree and unreachable → an explicit
// error (no guessing).

import { moduleState } from "../lib/moduleState";
import {
  onPresentationDisplayFrame,
  type PresentationDisplayFrame,
} from "../lib/presentationDisplayFrames";
import { currentWindow, invoke } from "../framework";
import { currentWindowLabel } from "../lib/webviewLabels";
import { surfaceLabelOfView } from "../lib/surfaceLabels";
import { contentViewHost, hasContentViewHost, type SurfacePointerInput } from "../lib/contentViews";
import { surfaceInputProvider } from "../lib/surfaceInputProviders";
import { surfacesOutsideWindow, type SurfaceFrameFact } from "../lib/surfaceInsideWindow";
import { parseAddress, isParseError } from "./address";
import { lightingRegionsIn } from "./focusLighting";
import { scanNodes, type ScannedNode } from "../plugins/nodeScan";
import { register } from "./registry";
import { tmsg, key} from "../i18n";
import { viewFocusSnapshot } from "../plugins/viewFocus";
import { useGutterHover } from "../state/gutterHover";
import { useSessions } from "../state/sessions";
import { motionLiveList, motionLiveRates, setMotionDebug, motionRecentBirths, motionJourneys, motionSwaps, motionTriggers } from "../lib/motionDebug";
import { railTravelDeclaredMs, railTravelMs, railTravelWallMs } from "../lib/railMotion";
import {
  recordWindowFrames,
  startWindowRecording,
  validWindowRecordMaxBytes,
} from "./windowRecorder";
import { createFiniteDomTraceSampler } from "./finiteDomTrace";
import { layoutSettlementStatus, waitLayoutSettled } from "./waitLayoutSettled";
import { layoutDecorationMotionFacts } from "../lib/layoutDecorationPresentation";
import { layoutDecorationClearanceFacts } from "../lib/layoutDecorationClearance";
import { pluginViewHostOverlayStatus } from "../components/pluginViewHostOverlay";
import { declareLayoutCause, onLayoutTransitionJournal } from "../lib/layoutTransitionJournal";
import {
  PRESENTATION_CLOCK,
  presentationNowUnixMs,
  presentationUnixMsFromDocumentTime,
} from "../lib/presentationClock";
import {
  LayoutSettlementFailure,
  LayoutSettlementTimeout,
  serializePresentationProviderError,
} from "../lib/presentationSettlement";
import { stackingPathOf, type StackingComputedStyle } from "../lib/stackingOrder";

type FocusTraceEntry = {
  t: number;
  type: string;
  tag: string | null;
  className: string;
  dataNode: string | null;
  hasFocus: boolean;
};

// Distinct things stand apart — put them in one bag and it is a bag, not state.
/** Focus trace — the events being recorded and the handle that stops the recording are one unit. */
const focusTrace = moduleState("commands/catalogDom#focusTrace", () => ({
  focusTrace: null as { events: FocusTraceEntry[]; recording: boolean } | null,
  focusTraceStop: null as (() => void) | null,
}));

// A structural address identifies a logical position, so it stays the same when a new Element mounts in
// that spot. The axis that observes instance replacement is keyed by the Element itself. Being a
// WeakMap, this identity does not extend the DOM lifecycle, and the value excludes internal structure
// such as address, tag, or dataset.
const domNodeIdentity = moduleState("commands/catalogDom#domNodeIdentity", () => ({
  byElement: new WeakMap<Element, string>(),
}));

type MultiDomTraceMotion = {
  producer: "web-animation";
  phase: "active" | "completed";
  transactionId: string;
  animationName: "rail-flip-x";
  playState: AnimationPlayState;
  startTime: number;
  currentTime: number;
  visualAtUnixMs: number;
  startFrame: { x: number; y: number; w: number; h: number };
  endFrame: { x: number; y: number; w: number; h: number } | null;
};
type MultiDomTraceNode = {
  address: string;
  connected: boolean;
  rect: { x: number; y: number; w: number; h: number };
  motion: null | MultiDomTraceMotion;
};
/**
 * The observer that actually produced the sample. When a transaction has no samples, "the DOM stopped"
 * and "nobody sampled" must be separated, and only the per-observer counts answer that. Without
 * observers in the ledger the reason for a gap is guesswork (measured: a run where the frame callback
 * never fired had to be back-computed from a 16ms sample interval).
 */
type MultiDomTraceProducer =
  | "arm"
  | "layout-commit"
  | "commit-anchor"
  | "frame-callback"
  | "native-display-frame"
  | "interval"
  | "animation-end"
  | "settlement";
type MultiDomTraceSample = {
  sequence: number;
  sampledAtUnixMs: number;
  trigger: "initial" | "layout-dom-commit" | "presentation-frame";
  producer: MultiDomTraceProducer;
  transactionId: string | null;
  domCommittedAtUnixMs: number | null;
  displayFrame?: PresentationDisplayFrame;
  nodes: MultiDomTraceNode[];
  chrome: MultiDomTraceChrome;
};
type MultiDomTraceChromeNode = {
  pane: string;
  nodeIdentity: string;
  rect: { x: number; y: number; w: number; h: number };
};
type MultiDomTraceChrome = {
  projectId: string | null;
  spaceNode: string | null;
  traveling: boolean;
  rail: {
    count: number;
    role: string | null;
    visibility: string | null;
    nodeIdentity: string | null;
    rect: { x: number; y: number; w: number; h: number } | null;
  };
  movingPaneIds: string[];
  paneChrome: MultiDomTraceChromeNode[];
  structuralFrames: MultiDomTraceChromeNode[];
  focusBoundaries: MultiDomTraceChromeNode[];
  relationOutlines: MultiDomTraceChromeNode[];
};
type MultiDomTraceSession = {
  traceId: string;
  addresses: string[];
  targets: { address: string; el: HTMLElement }[];
  unixFromPerformance: number;
  startedAtUnixMs: number;
  expiresAtUnixMs: number;
  endedAtUnixMs: number | null;
  timedOut: boolean;
  samples: MultiDomTraceSample[];
  presentationFrame: number | null;
  presentationTransactionId: string | null;
  presentationTraceId: string | null;
  presentationDomCommittedAtUnixMs: number | null;
  motionLifecycleByAddress: Map<string, MultiDomTraceMotion>;
  motionStartFrameByAddress: Map<string, { x: number; y: number; w: number; h: number }>;
  animationEndHandler: ((event: AnimationEvent) => void) | null;
  settlementObserver: MutationObserver | null;
  intervalProducer: ReturnType<typeof setInterval> | null;
  /** Observers enabled for this transaction. Separating whether the instrument displaced what it
   *  observed requires comparing two runs, so what was enabled must stay on the receipt. Default is all
   *  on — this axis only makes that comparison possible. */
  intervalEnabled: boolean;
  unsubscribe: () => void;
  unsubscribeDisplayFrames: () => void;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  evictionTimer: ReturnType<typeof setTimeout> | null;
  producerCounts: Record<MultiDomTraceProducer, number>;
  /** The requestAnimationFrame producer owns the identifier and cadence of its own callback series. */
  slotObservation: {
    transactionId: string;
    sourceGeneration: number;
    frameTimesUnixMs: number[];
  } | null;
  nativeSlotObservation: {
    transactionId: string;
    clock: string;
    sourceGeneration: number;
    frameSequences: number[];
  } | null;
  nextSlotSourceGeneration: number;
};

/** The observer list is derived from one place — list it twice by hand and one copy will miss an
 *  entry. */
const MULTI_DOM_TRACE_PRODUCERS = [
  "arm",
  "layout-commit",
  "commit-anchor",
  "frame-callback",
  "native-display-frame",
  "interval",
  "animation-end",
  "settlement",
] as const satisfies readonly MultiDomTraceProducer[];

function emptyMultiDomProducerCounts(): Record<MultiDomTraceProducer, number> {
  return Object.fromEntries(
    MULTI_DOM_TRACE_PRODUCERS.map((producer) => [producer, 0]),
  ) as Record<MultiDomTraceProducer, number>;
}
const multiDomTraceSessions = moduleState(
  "commands/catalogDom#multiDomTraceSessions",
  () => new Map<string, MultiDomTraceSession>(),
);
const MULTI_DOM_TRACE_MAX_SESSIONS = 8;
const MULTI_DOM_TRACE_MAX_MS = 15_000;
const MULTI_DOM_TRACE_RECEIPT_RETENTION_MS = 30_000;

function multiDomTraceNow(session: MultiDomTraceSession): number {
  return session.unixFromPerformance + performance.now();
}

function multiDomChromeSnapshot(session: MultiDomTraceSession): MultiDomTraceChrome {
  const anchor = session.targets[0]?.el ?? null;
  const workspace = anchor?.closest<HTMLElement>("[data-workspace-plane]") ?? null;
  // The trace inventory is ordered rail → pane → slot. The rail is a workspace-plane sibling
  // of the space, so the first address cannot own the space lookup. Resolve it from the exact
  // target set instead; this remains producer-owned and does not query an unrelated active space.
  const space = session.targets
    .map(({ el }) => el.closest<HTMLElement>(".space[data-node]"))
    .find((value): value is HTMLElement => value !== null) ?? null;
  const content = space?.closest<HTMLElement>(".content") ?? null;
  const rectOf = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x * 10) / 10,
      y: Math.round(rect.y * 10) / 10,
      w: Math.round(rect.width * 10) / 10,
      h: Math.round(rect.height * 10) / 10,
    };
  };
  const nodes = (selector: string, prefix: string): MultiDomTraceChromeNode[] => (
    space ? [...space.querySelectorAll<HTMLElement>(selector)].map((element) => ({
      pane: (element.dataset.node ?? "").slice(prefix.length),
      nodeIdentity: nodeIdentityOf(element),
      rect: rectOf(element),
    })) : []
  );
  const declaredRect = (value: string | undefined): MultiDomTraceChromeNode["rect"] | null => {
    const parts = value?.split(",").map(Number) ?? [];
    return parts.length === 4 && parts.every(Number.isFinite)
      ? { x: parts[0], y: parts[1], w: parts[2], h: parts[3] }
      : null;
  };
  const rails = content
    ? [...content.querySelectorAll<HTMLElement>('[data-node="rail/left"]')]
    : [];
  const rail = rails.length === 1 ? rails[0] : null;
  return {
    projectId: workspace?.dataset.workspacePlane ?? null,
    spaceNode: space?.dataset.node ?? null,
    traveling: space?.dataset.traveling === "true",
    rail: {
      count: rails.length,
      role: rail?.dataset.railRole ?? null,
      visibility: rail ? getComputedStyle(rail).visibility : null,
      nodeIdentity: rail ? nodeIdentityOf(rail) : null,
      rect: rail ? rectOf(rail) : null,
    },
    movingPaneIds: (space?.dataset.movingPanes ?? "")
      .split(" ")
      .filter((pane) => pane.length > 0),
    paneChrome: nodes('[data-node^="layout/pane/"]', "layout/pane/"),
    structuralFrames: nodes('[data-node^="layout/frame/"]', "layout/frame/"),
    focusBoundaries: nodes('[data-node^="layout/focus-boundary/"]', "layout/focus-boundary/"),
    relationOutlines: content
      ? [...content.querySelectorAll<HTMLElement>('[data-node^="relation/rail/"][data-bound-pane]')]
        .map((element) => {
          const railRect = declaredRect(element.dataset.rail);
          const paneRect = declaredRect(element.dataset.box);
          const paths = [...element.querySelectorAll<SVGGeometryElement>("path, line")]
            .map((shape) => shape.tagName.toLowerCase() === "path"
              ? shape.getAttribute("d") ?? ""
              : ["x1", "y1", "x2", "y2"].map((name) => shape.getAttribute(name) ?? "").join(","))
            .join(";");
          return {
            pane: element.dataset.boundPane ?? "",
            nodeIdentity: nodeIdentityOf(element),
            // Keep the existing consumer's pane rect name, and report the inputs that own the real
            // outline shape on a separate axis.
            rect: paneRect ?? rectOf(element),
            railRect,
            paneRect,
            geometry: `rail=${element.dataset.rail ?? ""}|pane=${element.dataset.box ?? ""}|paths=${paths}`,
          };
        })
        .filter((entry) => entry.pane.length > 0)
      : [],
  };
}

function appendMultiDomTraceSample(
  session: MultiDomTraceSession,
  trigger: MultiDomTraceSample["trigger"],
  producer: MultiDomTraceProducer,
  transactionId: string | null,
  domCommittedAtUnixMs: number | null,
  frameTime?: number,
  displayFrame?: PresentationDisplayFrame,
): void {
  const motionOf = (address: string, el: HTMLElement): MultiDomTraceNode["motion"] => {
    if (producer !== "frame-callback" && producer !== "native-display-frame") {
      return producer === "animation-end" || producer === "settlement"
        ? session.motionLifecycleByAddress.get(address) ?? null
        : null;
    }
    const owner = el.matches(".flip-move") ? el : el.closest<HTMLElement>(".flip-move");
    if (!owner || typeof owner.getAnimations !== "function") {
      return session.motionLifecycleByAddress.get(address) ?? null;
    }
    const motions = owner.getAnimations().filter((animation) => (
      (animation as CSSAnimation).animationName === "rail-flip-x"
        && typeof animation.startTime === "number"
        && typeof animation.currentTime === "number"
    ));
    if (motions.length !== 1) return session.motionLifecycleByAddress.get(address) ?? null;
    const animation = motions[0];
    const startFrame = session.motionStartFrameByAddress.get(address);
    if (!startFrame) return null;
    const motion: MultiDomTraceMotion = {
      producer: "web-animation",
      phase: "active",
      transactionId: session.presentationTransactionId!,
      animationName: "rail-flip-x",
      playState: animation.playState,
      startTime: animation.startTime as number,
      currentTime: animation.currentTime as number,
      // The DOM rect is the on-screen fact at this animation timeline position. An rAF callback
      // timestamp is the callback delivery time, not the owner of the CSS visual epoch, so it does not
      // stand in for the trajectory time.
      visualAtUnixMs: session.unixFromPerformance
        + (animation.startTime as number)
        + (animation.currentTime as number),
      startFrame,
      endFrame: null,
    };
    session.motionLifecycleByAddress.set(address, motion);
    return motion;
  };
  const sample: MultiDomTraceSample = {
    sequence: session.samples.length,
    sampledAtUnixMs: frameTime === undefined
      ? multiDomTraceNow(session)
      : session.unixFromPerformance + frameTime,
    trigger,
    producer,
    transactionId,
    domCommittedAtUnixMs,
    ...(displayFrame === undefined ? {} : { displayFrame }),
    chrome: multiDomChromeSnapshot(session),
    // Reads every participant inside the same event callback. No interpolation, no projected
    // displacement.
    nodes: session.targets.map(({ address, el }) => {
      const rect = el.getBoundingClientRect();
      return {
        address,
        connected: el.isConnected,
        rect: {
          x: Math.round(rect.x * 10) / 10,
          y: Math.round(rect.y * 10) / 10,
          w: Math.round(rect.width * 10) / 10,
          h: Math.round(rect.height * 10) / 10,
        },
        motion: motionOf(address, el),
      };
    }),
  };
  // The count is the number of samples kept. Counting attempts inflates "sampled" and hides the gap.
  session.samples.push(sample);
  session.producerCounts[producer] += 1;
}

/**
 * The real document presentation ledger opened by layout prepared. `requestAnimationFrame` is not a
 * timer polling loop that re-reads positions; it is the callback WebKit issues when it builds the next
 * display frame. Session close/timeout is the explicit bound, and a new transaction replaces the
 * previous callback ownership.
 */
function startMultiDomPresentationFrames(
  session: MultiDomTraceSession,
  transactionId: string,
): void {
  if (session.presentationFrame !== null) cancelAnimationFrame(session.presentationFrame);
  session.presentationTransactionId = transactionId;
  session.presentationDomCommittedAtUnixMs = null;
  session.motionLifecycleByAddress.clear();
  session.motionStartFrameByAddress = new Map(session.targets.map(({ address, el }) => {
    const rect = el.getBoundingClientRect();
    return [address, {
      x: Math.round(rect.x * 10) / 10,
      y: Math.round(rect.y * 10) / 10,
      w: Math.round(rect.width * 10) / 10,
      h: Math.round(rect.height * 10) / 10,
    }];
  }));
  session.nextSlotSourceGeneration += 1;
  session.slotObservation = {
    transactionId,
    sourceGeneration: session.nextSlotSourceGeneration,
    frameTimesUnixMs: [],
  };
  // rAF is legitimately suspended for an occluded WebKit document. CSS
  // animationend is an event from the same compositor transaction and gives
  // us the real final DOM rect without a timer/polling loop.
  session.animationEndHandler = (event: AnimationEvent) => {
    if (session.endedAtUnixMs !== null
        || session.presentationTransactionId !== transactionId
        || event.animationName !== "rail-flip-x"
        || !Number.isFinite(event.elapsedTime) || event.elapsedTime < 0) return;
    const currentTime = event.elapsedTime * 1_000;
    for (const [address, motion] of session.motionLifecycleByAddress) {
      if (motion.transactionId !== transactionId || motion.phase !== "active") continue;
      const target = session.targets.find((entry) => entry.address === address);
      if (!target) continue;
      const rect = target.el.getBoundingClientRect();
      session.motionLifecycleByAddress.set(address, {
        ...motion,
        phase: "completed",
        playState: "finished",
        currentTime,
        visualAtUnixMs: session.unixFromPerformance + motion.startTime + currentTime,
        endFrame: {
          x: Math.round(rect.x * 10) / 10,
          y: Math.round(rect.y * 10) / 10,
          w: Math.round(rect.width * 10) / 10,
          h: Math.round(rect.height * 10) / 10,
        },
      });
    }
    appendMultiDomTraceSample(
      session,
      "presentation-frame",
      "animation-end",
      transactionId,
      session.presentationDomCommittedAtUnixMs,
    );
  };
  document.addEventListener("animationend", session.animationEndHandler, true);
  // The class removal is the application's explicit animation settlement
  // event. MutationObserver is event-driven and observes the real DOM; it is
  // not a coordinate polling loop. This covers WebKit documents where both
  // rAF and animationend are throttled while a native surface occludes them.
  session.settlementObserver = new MutationObserver(() => {
    if (session.endedAtUnixMs !== null
        || session.presentationTransactionId !== transactionId
        || session.targets.some(({ el }) => (
          el.matches(".flip-move") || el.closest(".flip-move") !== null
        ))) return;
    const currentTime = railTravelDeclaredMs();
    for (const [address, motion] of session.motionLifecycleByAddress) {
      if (motion.transactionId !== transactionId || motion.phase !== "active") continue;
      const target = session.targets.find((entry) => entry.address === address);
      if (!target) continue;
      const rect = target.el.getBoundingClientRect();
      session.motionLifecycleByAddress.set(address, {
        ...motion,
        phase: "completed",
        playState: "finished",
        currentTime,
        visualAtUnixMs: session.unixFromPerformance + motion.startTime + currentTime,
        endFrame: {
          x: Math.round(rect.x * 10) / 10,
          y: Math.round(rect.y * 10) / 10,
          w: Math.round(rect.width * 10) / 10,
          h: Math.round(rect.height * 10) / 10,
        },
      });
    }
    appendMultiDomTraceSample(
      session,
      "presentation-frame",
      "settlement",
      transactionId,
      session.presentationDomCommittedAtUnixMs,
    );
  });
  session.settlementObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style"],
    subtree: true,
  });
  // Last-resort only: WebKit exposes no event for intermediate transformed
  // rects when an occluded document suspends both rAF and animation events.
  // This bounded recorder ends at the trace expiry and is never used for
  // normal DOM observation; it exists to keep that missing evidence RED rather
  // than silently projecting native coordinates into the DOM.
  //
  // Not a self-rearming setTimeout chain. In that chain a single tick that does not run (late or
  // throwing) kills the observer for good and leaves an unexplained gap in the ledger — measured:
  // samples stopped for 339ms at the start of the glide while the event observers of the same session
  // stayed alive. With interval, one failed tick does not take the next one, and termination is owned by
  // finishMultiDomTrace alone.
  if (session.intervalProducer !== null) clearInterval(session.intervalProducer);
  // The condition is placed at the install site, not inside the tick — inside the tick the timer keeps
  // running and that itself perturbs what is being measured.
  if (session.intervalEnabled) session.intervalProducer = setInterval(() => {
    if (session.endedAtUnixMs !== null || session.presentationTransactionId !== transactionId) return;
    if (multiDomTraceNow(session) >= session.expiresAtUnixMs) return;
    appendMultiDomTraceSample(
      session,
      "presentation-frame",
      "interval",
      transactionId,
      session.presentationDomCommittedAtUnixMs,
    );
  }, 8);
  const sample = (frameTime: number) => {
    if (session.endedAtUnixMs !== null
        || session.presentationTransactionId !== transactionId) return;
    appendMultiDomTraceSample(
      session,
      "presentation-frame",
      "frame-callback",
      transactionId,
      session.presentationDomCommittedAtUnixMs,
      frameTime,
    );
    const observation = session.slotObservation;
    if (observation?.transactionId === transactionId) {
      observation.frameTimesUnixMs.push(session.unixFromPerformance + frameTime);
    }
    session.presentationFrame = requestAnimationFrame(sample);
  };
  session.presentationFrame = requestAnimationFrame(sample);
}

/** Binds only the DOM commit boundary to the callback source prepared opened, without replacing that
 *  source. */
function bindMultiDomPresentationCommit(
  session: MultiDomTraceSession,
  transactionId: string,
  domCommittedAtUnixMs: number,
): void {
  if (session.presentationTransactionId !== transactionId) {
    startMultiDomPresentationFrames(session, transactionId);
  }
  session.presentationDomCommittedAtUnixMs = domCommittedAtUnixMs;
  // One-shot post-commit DOM anchor. It is a real layout read at the
  // transaction boundary, not a timer sample; keeping it alongside the
  // settlement anchor gives the mapper start/middle/end coverage even when
  // WebKit suppresses all frame callbacks for an occluded document.
  appendMultiDomTraceSample(
    session,
    "presentation-frame",
    "commit-anchor",
    transactionId,
    domCommittedAtUnixMs,
  );
}

function multiDomSlotObservation(session: MultiDomTraceSession) {
  const observation = session.slotObservation;
  if (!observation) return null;
  const callbackCount = observation.frameTimesUnixMs.length;
  const native = session.nativeSlotObservation;
  // When Tauri publishes the native display ledger of the same transaction, that epoch owns the real
  // display time. rAF is a secondary observer that reads the DOM, and an interval where the main thread
  // was pushed back once must not be turned into a compositor drop. Only implementations without a
  // native ledger (Electron etc) use the rAF receipt.
  if (native && native.transactionId === observation.transactionId) {
    const sequences = [...native.frameSequences].sort((a, b) => a - b);
    if (sequences.length >= 2) {
      const firstFrameSequence = sequences[0];
      const lastFrameSequence = sequences[sequences.length - 1];
      return {
        status: "observed" as const,
        producer: "native-display-frame" as const,
        clock: native.clock,
        transactionId: native.transactionId,
        sourceGeneration: native.sourceGeneration,
        firstFrameSequence,
        lastFrameSequence,
        callbackCount: sequences.length,
        callbackIntervalsSkipped: lastFrameSequence - firstFrameSequence + 1 - sequences.length,
      };
    }
  }
  const base = {
    producer: "frame-callback" as const,
    clock: PRESENTATION_CLOCK,
    transactionId: observation.transactionId,
    sourceGeneration: observation.sourceGeneration,
    firstFrameSequence: callbackCount > 0 ? 0 : null,
    lastFrameSequence: callbackCount > 0 ? callbackCount - 1 : null,
    callbackCount,
  };
  if (callbackCount < 2) {
    return { status: "unmeasured" as const, ...base, callbackIntervalsSkipped: null };
  }
  return {
    status: "observed" as const,
    ...base,
    // The rAF callback is itself the slot sample producer. There is no second callback recorder between
    // the producer and the sample, so the intervals a recorder missed is 0. Gaps in the display epoch
    // between sample times are judged by the evaluator together with this ownership receipt.
    callbackIntervalsSkipped: 0,
  };
}

function finishMultiDomTrace(session: MultiDomTraceSession, timedOut: boolean): void {
  if (session.endedAtUnixMs !== null) return;
  session.endedAtUnixMs = multiDomTraceNow(session);
  session.timedOut = timedOut;
  session.unsubscribe();
  session.unsubscribe = () => {};
  session.unsubscribeDisplayFrames();
  session.unsubscribeDisplayFrames = () => {};
  if (session.presentationFrame !== null) cancelAnimationFrame(session.presentationFrame);
  session.presentationFrame = null;
  if (session.animationEndHandler !== null) {
    document.removeEventListener("animationend", session.animationEndHandler, true);
    session.animationEndHandler = null;
  }
  session.settlementObserver?.disconnect();
  session.settlementObserver = null;
  if (session.intervalProducer !== null) clearInterval(session.intervalProducer);
  session.intervalProducer = null;
  session.presentationTransactionId = null;
  session.presentationDomCommittedAtUnixMs = null;
  if (session.expiryTimer !== null) clearTimeout(session.expiryTimer);
  session.expiryTimer = null;
  if (timedOut) {
    // Reclaimed after a finite grace period for reading the close receipt. A one-shot per-session
    // removal, not a periodic sweep.
    session.evictionTimer = setTimeout(() => {
      if (multiDomTraceSessions.get(session.traceId) === session) {
        multiDomTraceSessions.delete(session.traceId);
      }
    }, MULTI_DOM_TRACE_RECEIPT_RETENTION_MS);
  }
}

export function __resetMultiDomTraceForTest(): void {
  for (const session of multiDomTraceSessions.values()) {
    finishMultiDomTrace(session, false);
    if (session.evictionTimer !== null) clearTimeout(session.evictionTimer);
  }
  multiDomTraceSessions.clear();
}

function nodeIdentityOf(el: Element): string {
  const existing = domNodeIdentity.byElement.get(el);
  if (existing) return existing;
  const identity = crypto.randomUUID();
  domNodeIdentity.byElement.set(el, identity);
  return identity;
}

const notExposed = (addr: string) => ({
  ok: false as const,
  code: "NOT_EXPOSED" as const,
  message: tmsg("msg.ui.address.notExposed", { address: addr }),
});

// Single selector for the view container — if the two traversals below (collect, exclude) do not see the
// same set, a node is counted twice or silently dropped, and the address-uniqueness decision (A1) rests
// on that. The file viewer container uses the same class, so the baseAddress attribute separates them.
const VIEW_CONTAINER = ".tab-viewer[data-view-addr]";

// Collects every exposed node of the current window as an absolute address (view containers plus host
// chrome). Direct DOM traversal.
export function collectExposed(): ScannedNode[] {
  const out: ScannedNode[] = [];
  // The window prefix is added only when there is a name. An empty name is not a name, so `win//…` is a
  // string the parser rejects, and then the side that produced the address (ui.tree) and the side that
  // resolves it (ui.input.*) disagree over a string just built — the disagreement shows up only as "no
  // such address" and points at the address rather than at the missing label (measured 2026-08-15).
  const label = currentWindowLabel();
  const win = label ? `win/${label}/` : "";
  // View containers — data-view-addr (<region>/view/<viewKey>) is the baseAddress. The win prefix is the
  // current window.
  for (const c of document.querySelectorAll<HTMLElement>(VIEW_CONTAINER)) {
    const base = c.dataset.viewAddr ?? "";
    if (!base) continue;
    out.push(...scanNodes(c, `${win}${base}`));
  }
  // Host chrome — [data-node] outside a view container.
  //
  // Every workspace plane is mounted (an inactive one only has its DOM visibility turned off). So a chrome
  // node inside a plane exists once per workspace, and without the workspace axis rail/left resolves to two
  // (measured). The canonical address includes the workspace, and only the active plane also gets the
  // short alias (the grammar's "omitted = active").
  for (const el of document.querySelectorAll<HTMLElement>("[data-node]")) {
    if (el.closest(VIEW_CONTAINER)) continue; // view-container nodes are collected above
    const nodePath = el.dataset.node ?? "";
    if (!nodePath) continue;
    const plane = el.closest<HTMLElement>("[data-workspace-plane]");
    const proj = plane?.dataset.workspacePlane;
    if (!proj) {
      out.push({ address: `${win}chrome/${nodePath}`, nodePath, el });
      continue;
    }
    out.push({
      address: `${win}proj/${proj}/chrome/${nodePath}`,
      nodePath,
      el,
      ...(plane?.dataset.workspaceActive === "1"
        ? { alias: `${win}chrome/${nodePath}` }
        : {}),
    });
  }
  return out;
}

/**
 * Address → element. Unless exactly one matches, nothing is picked (address axiom A2).
 *
 * This used to assume one address could sit on several elements and picked "the visible one". That guess
 * collapses when both are visible — measured: 6 panes all used tab/view/0, so which pane a click went to
 * was unknowable. A non-unique address is a defect on the side that produces addresses, not something a
 * pick should cover. Rejecting here exposes the defect where it is.
 */
export type Resolved =
  | { el: HTMLElement }
  | { ok: false; code: "NOT_EXPOSED" | "AMBIGUOUS"; message: string };

export function resolveExposed(addressStr: string): Resolved {
  const parsed = parseAddress(addressStr);
  if (isParseError(parsed)) return notExposed(addressStr);
  const want = addressStr.replace(/^\/+|\/+$/g, "");
  const wantWithWin = want.startsWith("win/") ? want : `win/${currentWindowLabel()}/${want}`;
  const matches = collectExposed().filter(
    (n) =>
      n.address === want ||
      n.address === wantWithWin ||
      n.alias === want ||
      n.alias === wantWithWin,
  );
  if (matches.length === 0) return notExposed(addressStr);
  if (matches.length > 1) {
    return {
      ok: false as const,
      code: "AMBIGUOUS" as const,
      message: tmsg("msg.ui.address.ambiguous", { n: matches.length, address: addressStr }),
    };
  }
  return { el: matches[0].el };
}

// Finds the topmost element at a coordinate through Shadow DOM. document.elementFromPoint stops at a
// shadow host (plugin views mount inside a shadow root), so this descends through
// shadowRoot.elementFromPoint and returns the real deepest element — symmetric with ui.tree/nodeScan
// collecting data-node through shadow boundaries. It stops when inner is the host itself (infinite-loop
// guard). The doc argument is for test injection.
export function deepElementFromPoint(
  x: number,
  y: number,
  doc: DocumentOrShadowRoot = document,
): Element | null {
  // elementFromPoint needs a layout engine — a real webview always has one, some environments (jsdom
  // etc) do not. Without it a coordinate hit test is impossible, so return null (no guessing).
  const efp = (root: DocumentOrShadowRoot): Element | null =>
    typeof root.elementFromPoint === "function" ? root.elementFromPoint(x, y) : null;
  let el = efp(doc);
  while (el?.shadowRoot) {
    const inner = efp(el.shadowRoot);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

// The declared-owner chain above a point — collects data-node while climbing from the deepest (=
// topmost) element. closest cannot cross a shadow boundary, so the climb switches to the host (symmetric
// with deepElementFromPoint).
//
// If a consumer deciding layer order stitches dataset, host, and background painters by its own rule, an
// ancestor with a transparent background drops out of the chain and "which one is on top" gets a
// different answer per consumer. The core answers the chain in one place. With no declared owner the
// result is an empty array — absence is not filled with another value.
export function declaredOwnerChain(el: Element | null): string[] {
  const owners: string[] = [];
  const seen = new Set<string>();
  for (let node: Node | null = el; node; ) {
    if (node instanceof HTMLElement) {
      const owner = node.dataset.node;
      if (owner && !seen.has(owner)) {
        seen.add(owner);
        owners.push(owner);
      }
    }
    const parent = node instanceof Element ? node.parentElement : null;
    node = parent ?? ((node.getRootNode() as ShadowRoot | null)?.host ?? null);
  }
  return owners;
}

// Containment test across shadow boundaries — is `container` the node itself or one of its ancestors?
//
// Node.contains stops at a shadow boundary. The hit test (deepElementFromPoint) descends through that
// boundary, so unless the descent is retraced with the same steps, a point inside the node itself
// answers "something else covers it" (plugin views mount inside a shadow root — the right sidebar is
// one). When parentElement runs out, the climb switches to the host — the same steps as
// declaredOwnerChain.
export function containsDeep(container: Element | null, node: Element | null): boolean {
  if (!container || !node) return false;
  for (let cur: Node | null = node; cur; ) {
    if (cur === container) return true;
    const parent: Element | null = cur instanceof Element ? cur.parentElement : null;
    cur = parent ?? ((cur.getRootNode() as ShadowRoot | null)?.host ?? null);
  }
  return false;
}

// Reads a computed property by camelCase or kebab-case name (getPropertyValue wants kebab).
function readComputed(cs: CSSStyleDeclaration, name: string): string {
  const kebab = name.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
  return cs.getPropertyValue(kebab) || (cs as unknown as Record<string, string>)[name] || "";
}

// The final active element through Shadow DOM. document.activeElement stops at a shadow host (plugin
// views mount inside a shadow root), so this descends through shadowRoot.activeElement — symmetric with
// deepElementFromPoint. The root argument is for test injection.
export function deepActiveElement(root: DocumentOrShadowRoot = document): Element | null {
  let ae = root.activeElement;
  while (ae?.shadowRoot?.activeElement) ae = ae.shadowRoot.activeElement;
  return ae;
}

// The view container that contains the element (the one with the tab instance anchor). closest on an
// element inside a shadow root cannot cross the boundary, so when it stops there the search climbs to
// the shadow host and retries (shadow-piercing ancestor search).
//
// The canonical name of the tab host anchor is data-tab-id alone (viewHostAnchors — the old data-pane-id
// was removed after every consumer migrated, 2026-07-27).
const TAB_ANCHORED = ".tab-viewer[data-tab-id]";

/** The tab id that container names — reads only the canonical anchor (data-tab-id). */
export function tabIdOfContainer(host: HTMLElement | null): string | null {
  return host?.dataset.tabId ?? null;
}

export function viewContainerOf(el: Element | null): HTMLElement | null {
  let cur: Node | null = el;
  while (cur instanceof Element) {
    const host = cur.closest<HTMLElement>(TAB_ANCHORED);
    if (host) return host;
    const root = cur.getRootNode();
    cur = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

export function registerDomCatalog(): void {
  register("ui.plugin-view.overlay", {
    description: key("cmd.ui.plugin-view.overlay.desc"),
    params: {},
    returns: "{ current:[{viewKey,viewId,containerGeneration,registryPresent,bootPhase,overlayReason:'none'|'registry-loading'|'registry-missing'|'presentation-error',error,sequence}],events:[...],maxEvents:64 }",
    message: (data) =>
      tmsg("msg.ui.plugin-view.overlay", { n: Array.isArray(data.current) ? data.current.length : 0 }),
    handler: () => pluginViewHostOverlayStatus(),
  });
  register("ui.tree", {
    description: key("cmd.ui.tree.desc"),
    triggers: { ko: "DOM 트리 주소목록 노드목록 ui트리 노드식별자 재마운트 인스턴스" },
    params: {
      rects: {
        type: "boolean",
        description: key("cmd.ui.tree.param.rects"),
        default: false,
      },
    },
    returns: "{ window, count, duplicates, nodes: [{ address, nodePath, nodeIdentity, dataset, rect? }] }",
    message: (d) => tmsg("msg.ui.tree", { n: Number(d.count ?? 0) }),
    examples: ["ui.tree", 'ui.tree \'{"rects":true}\''],
    handler: (p) => {
      const withRects = p.rects === true;
      const scanned = collectExposed();
      // The observation surface for address axiom A1 — a violation shows up here. Silence makes it
      // unfixable.
      const seen = new Map<string, number>();
      for (const n of scanned) seen.set(n.address, (seen.get(n.address) ?? 0) + 1);
      const duplicates = [...seen.entries()]
        .filter(([, c]) => c > 1)
        .map(([address, count]) => ({ address, count }));
      const nodes = scanned.map((n) => {
        const exposed = {
          address: n.address,
          nodePath: n.nodePath,
          nodeIdentity: nodeIdentityOf(n.el),
          // The data-* of an element published through data-node is an already declared interface. If
          // tree dropped it, a consumer would call ui.measure per discovered address or go back to
          // guessing private DOM.
          dataset: Object.fromEntries(Object.entries(n.el.dataset)),
        };
        if (!withRects) return exposed;
        const r = n.el.getBoundingClientRect();
        return {
          ...exposed,
          rect: { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) },
        };
      });
      return { window: currentWindowLabel(), count: nodes.length, duplicates, nodes };
    },
  });

  register("ui.measure", {
    description: key("cmd.ui.measure.desc"),
    triggers: { ko: "DOM 측정 레이아웃 rect 크기 스타일 포인터이벤트 가시성 가림 도달성 스크린 전역좌표 실클릭 노드식별자 재마운트 인스턴스" },
    params: {
      address: { type: "string", description: key("cmd.ui.measure.param.address"), required: true },
      props: {
        type: "json",
        description:
          key("cmd.ui.measure.param.props"),
        required: false,
      },
      pseudo: {
        type: "string",
        description:
          key("cmd.ui.measure.param.pseudo"),
        required: false,
      },
      occlusion: {
        type: "boolean",
        description: key("cmd.ui.measure.param.occlusion"),
        default: false,
      },
      screen: {
        type: "boolean",
        description: key("cmd.ui.measure.param.screen"),
        default: false,
      },
      stacking: {
        type: "boolean",
        description: key("cmd.ui.measure.param.stacking"),
        default: false,
      },
    },
    returns:
      "{ address, nodeIdentity, dataset, value?:string, rect:{x,y,w,h}, inlineStyle:{height,flexBasis}, style, occlusion?:{ reachable, topTag, topNode }, screen?:{ x, y, cx, cy }, stacking?:[{ identity, node, zIndex, positioned, order }] } — nodeIdentity is the opaque live Element identity shared with ui.tree; dataset contains every declared data-* field on the exposed node; value is the current public value of an exposed input, textarea, or select; stacking entries carry zIndex null for an undeclared layer",
    message: (d) =>
      tmsg("msg.ui.measure", {
        w: Number((d.rect as { w?: number })?.w ?? 0),
        h: Number((d.rect as { h?: number })?.h ?? 0),
      }),
    errors: ["NOT_EXPOSED", "AMBIGUOUS", "INVALID_PARAMS"],
    examples: ['ui.measure \'{"address":"content/view/soksak-plugin-<id>.<view>/node/send"}\''],
    handler: async (p) => {
      const addr = p.address as string;
      const found = resolveExposed(addr);
      if (!("el" in found)) return found;
      const el = found.el;
      const r = el.getBoundingClientRect();
      // pseudo — the axis for measuring pixels that belong to no node at all, such as a veil (::after).
      // Without this spot, the dimming of a hole slot can only be eyeballed (incident 2026-08-02: 7% was
      // read as 22%). An unknown value is rejected with its name — silently dropping it into an element
      // measurement would make the answer "measured" a lie.
      const pseudo = typeof p.pseudo === "string" ? p.pseudo : null;
      if (pseudo && pseudo !== "::before" && pseudo !== "::after") {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: tmsg("msg.ui.measure.pseudoInvalid", { pseudo }),
        };
      }
      const cs = getComputedStyle(el, pseudo);
      // Answers all four sides and both axes symmetrically. Answering only the vertical axis leaves a
      // claim about the horizontal sides unprovable by number (R5), and the only path left is a human
      // looking at the screen — measured 2026-08-15: asked whether the plane had a right outline, this
      // command answered borderTop/borderBottom only, and someone who knew the spot had to point it out
      // with a screenshot.
      const style: Record<string, string> = {
        display: cs.display,
        width: cs.width,
        height: cs.height,
        paddingTop: cs.paddingTop,
        paddingRight: cs.paddingRight,
        paddingBottom: cs.paddingBottom,
        paddingLeft: cs.paddingLeft,
        borderTop: cs.borderTopWidth,
        borderRight: cs.borderRightWidth,
        borderBottom: cs.borderBottomWidth,
        borderLeft: cs.borderLeftWidth,
        fontSize: cs.fontSize,
        alignItems: cs.alignItems,
        alignSelf: cs.alignSelf,
        // Interaction/visibility axis — layout fields alone cannot tell whether a node is actually
        // visible and clickable.
        pointerEvents: cs.pointerEvents,
        opacity: cs.opacity,
        visibility: cs.visibility,
      };
      // props[] — request arbitrary computed properties (lifts the hardcoded field set).
      if (Array.isArray(p.props)) {
        for (const name of p.props as unknown[]) {
          if (typeof name === "string") style[name] = readComputed(cs, name);
        }
      }
      // pseudo must be able to answer "none" too — with content:none that veil is never painted at all.
      if (pseudo) style.content = readComputed(cs, "content");
      const formElement = ["input", "textarea", "select"].includes(el.localName);
      const projectedForm = ["input", "textarea", "select"].includes(el.dataset.formControl ?? "")
        && Object.prototype.hasOwnProperty.call(el.dataset, "formValue");
      const publicValue = formElement
        ? (el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value
        : projectedForm ? el.dataset.formValue : undefined;
      const out: Record<string, unknown> = {
        address: addr,
        nodeIdentity: nodeIdentityOf(el),
        ...(pseudo ? { pseudo } : {}),
        ...(publicValue !== undefined
          // A PluginView node can come from a realm other than the host Window, so instanceof against a
          // host constructor is false even for the same HTML tag. localName has the DOM standard form
          // meaning and is realm-independent. A child renderer projection uses only the data-form-*
          // receipt carried by the same public node frame; the host does not guess the value.
          ? { value: publicValue }
          : {}),
        // Every data-* declaration is public state. Automation and plugins read it through the one path
        // ui.tree → ui.measure instead of guessing private DOM attribute names again.
        dataset: Object.fromEntries(Object.entries(el.dataset)),
        rect: {
          x: +r.x.toFixed(2),
          y: +r.y.toFixed(2),
          w: +r.width.toFixed(2),
          h: +r.height.toFixed(2),
        },
        inlineStyle: {
          height: (el as HTMLElement).style?.height ?? "",
          flexBasis: (el as HTMLElement).style?.flexBasis ?? "",
        },
        style,
      };
      // occlusion — a shadow-piercing hit test at the rect center reports what covers the node and
      // whether it is reachable. A consumer could derive it by combining ui.hit, but the decision is
      // common enough to provide here (no reinvention).
      if (p.occlusion === true) {
        const top = deepElementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        out.occlusion = {
          // Containment is read through shadow boundaries (containsDeep) — if the decision does not
          // cross the boundary the hit test descended through, hitting inside the node itself reads as
          // unreachable.
          reachable: containsDeep(el, top) || containsDeep(top, el),
          topTag: top ? top.tagName.toLowerCase() : null,
          topNode: top instanceof HTMLElement ? (top.dataset.node ?? null) : null,
        };
      }
      // stacking — the ancestor chain that determines paint order. Subtracting two nodes' z directly
      // skips the stacking context between them and can answer the opposite of the screen (incident:
      // rail 7 > veil 6 is true, but what actually separated them was the 1 on the .space-plane in
      // between). The comparison is made by whoever receives this chain — the core only supplies the
      // grounds for the order.
      if (p.stacking === true) {
        out.stacking = stackingPathOf(el, {
          getStyle: (node) => getComputedStyle(node) as unknown as Partial<StackingComputedStyle>,
          identify: nodeIdentityOf,
        });
      }
      // screen — global logical coordinates. A synthetic dispatch cannot reproduce hit testing or
      // default actions, so the core supplies the coordinate conversion a real-pointer check (an OS
      // click tool) consumes, through one path.
      if (p.screen === true) {
        const win = currentWindow();
        const [pos, scale] = await Promise.all([
          win.innerPosition(),
          win.scaleFactor(),
        ]);
        const ox = pos.x / scale;
        const oy = pos.y / scale;
        out.screen = {
          x: +(ox + r.x).toFixed(2),
          y: +(oy + r.y).toFixed(2),
          cx: +(ox + r.x + r.width / 2).toFixed(2),
          cy: +(oy + r.y + r.height / 2).toFixed(2),
        };
      }
      return out;
    },
  });

  register("ui.slot", {
    description: key("cmd.ui.slot.desc"),
    triggers: { ko: "슬롯 뷰컨테이너 rect present타깃 dpr 측정" },
    params: {
      address: {
        type: "string",
        description: key("cmd.ui.slot.param.address"),
        required: true,
      },
    },
    returns: "{ address, rect:{x,y,w,h}, dpr }",
    message: (d) =>
      tmsg("msg.ui.slot", {
        w: Number((d.rect as { w?: number })?.w ?? 0),
        h: Number((d.rect as { h?: number })?.h ?? 0),
        dpr: Number(d.dpr ?? 1),
      }),
    errors: ["NOT_EXPOSED", "AMBIGUOUS", "INVALID_PARAMS"],
    examples: ['ui.slot \'{"address":"win/main/content/view/soksak-plugin-<id>.<view>"}\''],
    handler: (p) => {
      const addr = (p.address as string) ?? "";
      const want = addr.replace(/^\/+|\/+$/g, "");
      const win = currentWindowLabel();
      const wantWithWin = want.startsWith("win/") ? want : `win/${win}/${want}`;
      // Matches view containers by base address (the same construction rule as collectExposed) — a view
      // address with no node.
      for (const c of document.querySelectorAll<HTMLElement>(VIEW_CONTAINER)) {
        const base = c.dataset.viewAddr ?? "";
        if (!base) continue;
        const full = `win/${win}/${base}`;
        if (full === wantWithWin || full === want) {
          const r = c.getBoundingClientRect();
          return {
            address: addr,
            rect: {
              x: +r.x.toFixed(2),
              y: +r.y.toFixed(2),
              w: +r.width.toFixed(2),
              h: +r.height.toFixed(2),
            },
            dpr: window.devicePixelRatio,
          };
        }
      }
      return notExposed(addr);
    },
  });

  register("ui.focus.state", {
    description: key("cmd.ui.focus.state.desc"),
    triggers: { ko: "키보드 포커스 소유자 활성 뷰 포커스 상태 창키 커서" },
    params: {},
    returns:
      "{ requestedTabId, mounted, delivered, activeTabId, realms:[{ realm, focused, node }], settled, windowFocused, activeElement:{ tag, dataNode, className, ancestors }, lighting:{ scope, base, aperture, cutouts[], exempt[], blocked[] } — each region is { node, target, rect:{x,y,w,h} }; aperture null means nothing is focused, which is a real state }",
    message: (d) =>
      tmsg("msg.ui.focus.state", {
        view: String(d.activeTabId ?? "none"),
      }),
    examples: ["ui.focus.state"],
    handler: () => {
      const request = viewFocusSnapshot();
      const active = deepActiveElement();
      const host = viewContainerOf(active);
      const activeTabId = tabIdOfContainer(host);
      // Ancestor class chain (up to the view container) — a widget turns on its own focus marks (class,
      // cursor paint) only after it receives a focus event. activeElement alone does not show that axis.
      const ancestors: { tag: string; className: string }[] = [];
      for (
        let el = active instanceof HTMLElement ? active.parentElement : null;
        el && el !== host?.parentElement && ancestors.length < 12;
        el = el.parentElement ?? ((el.getRootNode() as ShadowRoot).host as HTMLElement | null)
      ) {
        ancestors.push({ tag: el.tagName.toLowerCase(), className: el.className });
        if (el === host) break;
      }
      // Focus in the child realm — reading the host document alone does not show this fact. It reports
      // the value the projection carried, verbatim (the host invents nothing). For a view whose chrome
      // is in a child document, such as a browser, "typing does not land" shows up here as a value.
      const realms = [...document.querySelectorAll<HTMLElement>("[data-realm-focused]")].reduce(
        (rows, el) => {
          const declared = el.dataset.node ?? "";
          const m = /^[^/]+\/plugin-view\/([^/]+)\/(.+)$/.exec(declared);
          if (!m) return rows;
          const row = rows.find((r) => r.realm === m[1])
            ?? (rows.push({ realm: m[1], focused: el.dataset.realmFocused === "true", node: null as string | null }), rows[rows.length - 1]);
          if (el.dataset.focused === "true") row.node = m[2];
          return rows;
        },
        [] as { realm: string; focused: boolean; node: string | null }[],
      );
      return {
        requestedTabId: request.requestedViewId,
        mounted: request.mounted,
        delivered: request.delivered,
        activeTabId,
        realms,
        // Where the light is, as addresses. Whether the lighting dims the right pane is a visual
        // question with a numeric answer — the aperture's address is the focused pane's — and
        // without this the only way to ask it was to look at a picture, which is not a judgement (L6).
        lighting: lightingRegionsIn(document),
        settled:
          request.delivered && request.requestedViewId === activeTabId,
        // When the window is not key, a widget paints no focus mark — an axis independent of settled.
        windowFocused: document.hasFocus(),
        activeElement:
          active instanceof HTMLElement
            ? {
                tag: active.tagName.toLowerCase(),
                dataNode: active.dataset.node ?? null,
                className: active.className,
                ancestors,
              }
            : null,
      };
    },
  });

  // ── Focus causality timeline ────────────────────────────────────────────
  // Reading state after the fact is contaminated (when the user leaves the window, blur reverts
  // activeElement). Only the event record shows what took focus and what stole it at the moment of a
  // real-device input. Registers 4 listeners and cleans itself up after the given ms — not an unbounded
  // watch.
  register("ui.focus.trace.start", {
    description: key("cmd.ui.focus.trace.start.desc"),
    triggers: { ko: "포커스 추적 타임라인 기록 클릭 인과" },
    params: {
      ms: {
        type: "number",
        description: key("cmd.ui.focus.trace.start.param.ms"),
        required: false,
      },
    },
    returns: "{ recording: true, ms }",
    message: (d) => tmsg("msg.ui.focus.trace.start", { ms: Number(d.ms ?? 0) }),
    examples: ['ui.focus.trace.start \'{"ms":10000}\''],
    handler: (p) => {
      focusTrace.focusTraceStop?.();
      const ms = Math.min(Math.max(Number(p.ms) || 10_000, 100), 180_000);
      const buf: FocusTraceEntry[] = [];
      const t0 = performance.now();
      const record = (e: Event) => {
        if (buf.length >= 300) return;
        const path = e.composedPath?.();
        const target = (path && path.length ? path[0] : e.target) as Element | null;
        const el = target instanceof HTMLElement ? target : null;
        buf.push({
          t: Math.round(performance.now() - t0),
          type: e.type,
          tag: target instanceof Element ? target.tagName.toLowerCase() : null,
          className: (el?.className ?? "").slice(0, 80),
          dataNode: el?.dataset.node ?? null,
          hasFocus: document.hasFocus(),
        });
      };
      const types = ["mousedown", "mouseup", "focusin", "focusout"] as const;
      for (const t of types) window.addEventListener(t, record, true);
      const timer = window.setTimeout(() => focusTrace.focusTraceStop?.(), ms);
      focusTrace.focusTrace = { events: buf, recording: true };
      focusTrace.focusTraceStop = () => {
        window.clearTimeout(timer);
        for (const t of types) window.removeEventListener(t, record, true);
        if (focusTrace.focusTrace) focusTrace.focusTrace.recording = false;
        focusTrace.focusTraceStop = null;
      };
      return { recording: true, ms };
    },
  });

  register("ui.focus.trace.read", {
    description: key("cmd.ui.focus.trace.read.desc"),
    triggers: { ko: "포커스 추적 읽기 타임라인 결과" },
    params: {},
    returns: "{ recording, events: [{ t, type, tag, className, dataNode, hasFocus }] }",
    message: (d) =>
      tmsg("msg.ui.focus.trace.read", {
        n: Array.isArray(d.events) ? (d.events as unknown[]).length : 0,
      }),
    examples: ["ui.focus.trace.read"],
    handler: () => ({
      recording: focusTrace.focusTrace?.recording ?? false,
      events: focusTrace.focusTrace?.events ?? [],
    }),
  });

/** Reports whether this node is a projection of a node in another realm.
 *
 * A view whose content is a native child webview workspaces that content's nodes
 * into the host document: a transparent `<div>` of the same size at the same
 * position, carrying the values in its dataset. Observation works on it —
 * ui.tree finds the node and ui.measure returns its values.
 *
 * Input does not. The div receives no events and the real node is in the other
 * realm, so an event dispatched here changes nothing while the answer reports
 * success. Measured 2026-08-08: three browsers' address bars behaved that way,
 * and the report was "the address cannot be typed".
 *
 * The test is the declaration, never the address. Matching the address shape
 * (`<something>/plugin-view/<middle>/…`) got two things wrong at once: a
 * whole-surface projection spells the same way and was read as a realm
 * (measured 2026-08-08), and the test depended on a framework name in the
 * address's first segment. An address is owned by whoever mints it.
 */
function projectedRealmNode(el: Element): boolean {
  return el instanceof HTMLElement && el.dataset.realm !== undefined;
}

/** The realm a projection names, and the node's address inside that realm.
 *  Both are declared values, not derived ones. */
function projectedTarget(el: Element): { realm: string; node: string } | null {
  if (!(el instanceof HTMLElement)) return null;
  const realm = el.dataset.realm;
  const node = el.dataset.realmNode;
  return realm && node ? { realm, node } : null;
}

/** A projection missing a declaration that input needs.
 *
 * The event is not passed on to the host DOM. That path produces "nothing
 * happened and the answer said success", and the caller then doubts the address
 * and repeats the same call. */
function undeclaredProjection(addr: string, screen: string, missing: string) {
  return {
    ok: false as const,
    code: "PROJECTION_UNDECLARED" as const,
    // The fact and the next action: what is missing, and who sets it.
    message: tmsg("msg.ui.projection.undeclared", { screen, missing, address: addr }),
  };
}

/** The result of meeting a projection with a missing declaration. It differs
 *  from a surface by having `ok`. */
type UndeclaredProjection = ReturnType<typeof undeclaredProjection>;

/** The surface a pointer goes into, and the place this node occupies inside it (surface-local CSS
 *  px). */
interface GestureSurface {
  label: string;
  x: number; y: number; w: number; h: number;
  /** Whether this node is the whole surface — a content view is. */
  whole: boolean;
}

/**
 * Which place on which surface a pointer injected into this node goes to.
 *
 * Two cases give the same answer. A content view is itself the surface (the
 * position inside it is the page's, so the caller supplies coordinates),
 * and a projected node is a node from another realm drawn at that position.
 *
 * A projection's position inside its realm is the value it holds. It is not
 * subtracted from host-document geometry: the projection's position in the host
 * is chosen by the host, and the subtraction points at a different coordinate as
 * soon as the realm is scrolled, the container has a border or padding, or the
 * projection is not a direct child. Only the producer has the realm coordinate.
 */
function gestureSurface(el: Element, addr: string): GestureSurface | UndeclaredProjection | null {
  const declared = el instanceof HTMLElement ? el.dataset : undefined;
  // Whole-surface projection: this node is the content surface. Its top-left is
  // (0,0) in surface coordinates, not the position it occupies on screen.
  if (declared?.surface) {
    const r = el.getBoundingClientRect();
    return { label: declared.surface, x: 0, y: 0, w: r.width, h: r.height, whole: true };
  }
  // Node projection: one node inside another realm. The projection declares
  // where it is in that realm.
  if (declared?.realm !== undefined) {
    const r = el.getBoundingClientRect();
    const x = Number(declared.realmX);
    const y = Number(declared.realmY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return undeclaredProjection(addr, declared.realm, "data-realm-x / data-realm-y");
    }
    return {
      label: declared.realm,
      x, y, w: r.width, h: r.height,
      whole: false,
    };
  }
  // A content view is not a descendant of its tab node — it is placed on a surface outside the cell
  // (measured 2026-08-02: it had no `[data-pane]` ancestor either). Searching descendants finds nothing
  // and silently becomes a DOM click.
  // Ownership is in the label: `<kind>-<window>-<view>`. Read the label the plugin declared for the
  // view id the address names, then look for it.
  const viewId = el.getAttribute("data-node")?.match(/^layout\/tab\/(.+)$/)?.[1];
  // No value is interpolated into a selector — escaping exists in some environments and not others, and
  // the day a label contains a special character the selector silently picks something else. Read the
  // attribute and compare.
  //
  // The label comes from the declaration. Rebuilding it needs the surface's kind, and the kind is
  // the plugin's word — a core that held one could only find the surfaces of the plugin it had been
  // written against.
  const wanted = viewId ? surfaceLabelOfView(viewId) : null;
  const byLabel = wanted
    ? Array.from(document.querySelectorAll<HTMLElement>("[data-content-view]")).find(
        (n) => n.getAttribute("data-content-view") === wanted,
      ) ?? null
    : null;
  const view = el.matches("[data-content-view]")
    ? el
    : (el.querySelector<HTMLElement>("[data-content-view]") ?? byLabel);
  if (view === null) return null;
  const r = view.getBoundingClientRect();
  return {
    label: view.getAttribute("data-content-view") ?? "",
    x: 0, y: 0, w: r.width, h: r.height,
    whole: true,
  };
}

/**
 * Where a gesture starts inside this surface.
 *
 * When the node is the whole surface, it is the top-left — defaulting to the center lets the page decide
 * what gets pressed and ties the check to page content. When it is one node inside the surface, it is
 * that node's center.
 */
function gesturePoint(surface: GestureSurface, p: Record<string, unknown>): { x: number; y: number } {
  const x = typeof p.x === "number" ? p.x : surface.whole ? 0 : Math.round(surface.x + surface.w / 2);
  const y = typeof p.y === "number" ? p.y : surface.whole ? 0 : Math.round(surface.y + surface.h / 2);
  return { x, y };
}

function noGesturePath(addr: string) {
  return {
    ok: false as const,
    code: "OTHER_REALM" as const,
    message: tmsg("msg.ui.gesture.noPath", { address: addr }),
  };
}

/**
 * Injects every step of a gesture inside one call.
 *
 * Letting the caller stitch the steps puts the interval in the caller's hands — a CLI round trip exceeds
 * the double-click interval, so two presses become two separate single clicks (measured 2026-08-08). One
 * gesture, one call.
 */
async function playGesture(
  label: string,
  steps: readonly SurfacePointerInput[],
): Promise<{ ok: false; code: "SURFACE_INPUT_UNAVAILABLE"; message: string } | null> {
  // Goes to the surface's owner. The framework's path has no route to a surface a plugin draws through
  // an engine sidecar (measured 2026-08-08: only one of three browsers worked). Special-casing that
  // engine in the core would couple them, so the owner answers for itself and the core only delivers.
  // With no owner, the framework takes it.
  const sink = surfaceInputProvider(label) ?? contentViewHost();
  try {
    for (const step of steps) await sink.sendInput(label, step);
    return null;
  } catch (error) {
    // That a surface exists and that this framework holds it are two different facts. A surface drawn by
    // a sidecar engine is owned by that plugin, and this path has no route to it. Leaking as an
    // exception leaves only "failed unexpectedly" in the response, and the caller doubts its own
    // address.
    return {
      ok: false as const,
      code: "SURFACE_INPUT_UNAVAILABLE" as const,
      message: tmsg("msg.ui.gesture.pointerFailed", {
        surface: label,
        error: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}

/** One press pair — the same pair a human press makes. Sending only the press never forms a click. */
function press(
  at: { x: number; y: number },
  button: "left" | "right",
  clickCount: number,
): SurfacePointerInput[] {
  return [
    { ...at, kind: "down", button, clickCount },
    { ...at, kind: "up", button, clickCount },
  ];
}

/**
 * Performs an operation on a projected node in the realm that node is in.
 *
 * The host's projection is transparent and receives no events — sending there does nothing. The real
 * node is in the child document, and the way into that document is already in the contract (`evalJs`,
 * `typeText`). What was missing was which document the address names: until now it carried the content
 * surface name and pointed where no node was.
 */
async function inProjectedRealm(
  el: Element,
  addr: string,
  action: { kind: "fill"; value: string },
) {
  const target = projectedTarget(el);
  // The realm is declared and the node inside it is not. Stop here: passing this
  // on writes the value into the host's transparent div, and the code that reads
  // that value is in the other realm.
  if (target === null) {
    return undeclaredProjection(addr, (el as HTMLElement).dataset.realm ?? "", "data-realm-node");
  }
  if (!hasContentViewHost()) return noGesturePath(addr);
  const host = contentViewHost();
  const pick = `document.querySelector(${JSON.stringify(`[data-node="${target.node}"]`)})`;
  // No value assignment — code in that realm updates state only from its own input events. Focus, select
  // the existing value, then inject through native input, and the path is the same as a human typing.
  const ready = await host.evalJs(target.realm, `const el = ${pick}; if (!el) return "none"; el.focus(); if (el.select) el.select(); return "ok";`);
  if (!String(ready).includes("ok")) {
    return {
      ok: false as const,
      code: "NOT_EXPOSED" as const,
      message: tmsg("msg.ui.input.fill.nodeMissingInScreen", { address: addr }),
    };
  }
  await host.typeText(target.realm, action.value);
  return { filled: true, realm: target.realm, address: addr };
}

function clickStimulusReceipt<T extends Record<string, unknown>>(
  causeTraceId: string | undefined,
  receipt: T,
): T & { causeTraceId?: string } {
  return {
    ...receipt,
    ...(causeTraceId === undefined ? {} : { causeTraceId }),
  };
}

  register("ui.input.click", {
    description: key("cmd.ui.input.click.desc"),
    triggers: { ko: "클릭 주입 ui클릭 버튼클릭 E2E 게스처 다운 업 분해" },
    params: {
      address: { type: "string", description: key("cmd.ui.input.click.param.address"), required: true },
      phase: {
        type: "string",
        description: key("cmd.ui.input.click.param.phase"),
        required: false,
      },
      x: {
        type: "number",
        description: key("cmd.ui.input.click.param.x"),
        required: false,
      },
      y: { type: "number", description: key("cmd.ui.input.click.param.y"), required: false },
      button: {
        type: "string",
        description: key("cmd.ui.input.click.param.button"),
        enum: ["left", "right"],
        required: false,
      },
      recordDir: {
        type: "string",
        description: key("cmd.ui.input.click.param.recordDir"),
        required: false,
      },
      recordFrames: {
        type: "number",
        description: key("cmd.ui.input.click.param.recordFrames"),
        default: 40,
      },
      recordIntervalMs: {
        type: "number",
        description: key("cmd.ui.input.click.param.recordIntervalMs"),
        default: 16,
      },
      recordLeadMs: {
        type: "number",
        description: key("cmd.ui.input.click.param.recordLeadMs"),
        default: 0,
      },
      recordMaxBytes: {
        type: "number",
        description: key("cmd.ui.input.click.param.recordMaxBytes"),
        required: false,
      },
      traceAddresses: {
        type: "json",
        description: key("cmd.ui.input.click.param.traceAddresses"),
        required: false,
      },
      causeTraceId: {
        type: "string",
        description: key("cmd.ui.input.click.param.causeTraceId"),
        required: false,
      },
    },
    returns: "{ clicked, address, atUnixMs, clock, causeTraceId?, phase?, surface?, recording:{status:'not-requested'|'complete'|'failed',mode:'realtime',dir?,requestedFrames?,frames?,reason?}, trace?:{frames,samples} }",
    message: () => tmsg("msg.ui.input.click"),
    errors: ["NOT_EXPOSED", "AMBIGUOUS", "INVALID_PARAMS", "OTHER_REALM", "SURFACE_INPUT_UNAVAILABLE", "PROJECTION_UNDECLARED"],
    danger: "inject",
    examples: ['ui.input.click \'{"address":"win/main/chrome/modal/consent/agree"}\''],
    handler: async (p) => {
      const addr = p.address as string;
      const found = resolveExposed(addr);
      if (!("el" in found)) return found;
      const el = found.el;
      // A sequence equivalent to a real click — el.click() (a single click event) cannot press
      // mousedown-driven elements (sidebar tab drag-select and such). One round of the same pattern as
      // the dblclick command. phase split: features whose contract is between down and up (hit
      // availability, deferred activation) need observation in the middle, so the sequence can be split.
      const phase = p.phase as string | undefined;
      if (phase !== undefined && phase !== "down" && phase !== "up") {
        return {
          ok: false,
          code: "INVALID_PARAMS",
          message: `phase must be 'down' or 'up', got: ${phase}`,
        };
      }
      // An empty cause cannot be told apart from "no cause". Silently turning it into a causeless
      // transaction leaves the caller believing it declared one while reading someone else's transaction
      // from the ledger.
      const causeTraceId = p.causeTraceId as string | undefined;
      if (causeTraceId !== undefined && (typeof causeTraceId !== "string" || causeTraceId.length === 0)) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: tmsg("msg.ui.input.click.causeTraceIdInvalid"),
        };
      }
      const recordDir = p.recordDir as string | undefined;
      const recordFrames = p.recordFrames === undefined ? 40 : Number(p.recordFrames);
      const recordIntervalMs = p.recordIntervalMs === undefined ? 16 : Number(p.recordIntervalMs);
      const recordLeadMs = p.recordLeadMs === undefined ? 0 : Number(p.recordLeadMs);
      const recordMaxBytes = p.recordMaxBytes;
      const traceAddresses = p.traceAddresses === undefined ? [] : p.traceAddresses;
      if (
        recordDir &&
        (!Number.isInteger(recordFrames) || recordFrames < 1 || recordFrames > 600 ||
          !Number.isFinite(recordIntervalMs) || recordIntervalMs < 0 ||
          !Number.isFinite(recordLeadMs) || recordLeadMs < 0 || recordLeadMs > 2_000)
      ) {
        return { ok: false as const, code: "INVALID_PARAMS", message: tmsg("msg.ui.record.argsRange") };
      }
      if (
        recordMaxBytes !== undefined &&
        (!recordDir || !validWindowRecordMaxBytes(recordMaxBytes))
      ) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS",
          message: tmsg("msg.ui.record.maxBytesInvalid"),
        };
      }
      if (
        !Array.isArray(traceAddresses) ||
        traceAddresses.length > 16 ||
        traceAddresses.some((address) => typeof address !== "string" || address.length === 0) ||
        (traceAddresses.length > 0 && !recordDir)
      ) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS",
          message: tmsg("msg.ui.record.traceAddressesInvalid"),
        };
      }
      const traceTargets = [];
      for (const address of traceAddresses as string[]) {
        const resolved = resolveExposed(address);
        if (!("el" in resolved)) return resolved;
        traceTargets.push({ address, el: resolved.el });
      }
      const trace = traceTargets.length > 0
        ? createFiniteDomTraceSampler(traceTargets)
        : null;
      const recording = recordDir
        ? startWindowRecording({
            dir: recordDir,
            frames: recordFrames,
            intervalMs: recordIntervalMs,
            ...(recordMaxBytes === undefined ? {} : { maxBytes: recordMaxBytes }),
            onFrame: (frame) => trace?.sample(frame),
          }, recordWindowFrames)
        : null;
      const recordingReady = await (recording?.ready ?? Promise.resolve(false));
      if (recordingReady && recordLeadMs > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, recordLeadMs));
      }
      const observationResult = async () => {
        // trace.samples() is a snapshot of the current array. Evaluating it alongside the recording in
        // the same Promise.all arguments copies only the one frame just after the first ready event and
        // loses the rest of the onFrame events. Recording completion bounds every frame event, so pass
        // that boundary first, then snapshot.
        const recordingReport = recording
          ? await recording.report
          : { status: "not-requested" as const, mode: "realtime" as const };
        const traceSamples = trace?.samples() ?? null;
        return {
          recording: recordingReport,
          ...(traceSamples == null
            ? {}
            : { trace: { frames: traceSamples.length, samples: traceSamples } }),
        };
      };
      // A node on another surface takes a real pointer injected into that surface.
      //
      // Content view or projected node, the real node is not in this document. A click built in the DOM
      // has no route to it, and even when it does land, the absence of user activation makes the engine
      // block things such as window opening (measured 2026-08-02: pressing a `_blank` link by script
      // produced 0 window-open requests). It must be real engine input.
      const surface = gestureSurface(el, addr);
      // A projection with a missing declaration stops here. Falling through to the
      // host DOM matches nothing and still answers success.
      if (surface && "ok" in surface) return surface;
      if (surface) {
        if (!hasContentViewHost()) return noGesturePath(addr);
        const at = gesturePoint(surface, p);
        // Goes through the host contract — touching the tag directly makes this spot die silently the
        // day that implementation changes. An implementation that cannot do it rejects on the spot with
        // its name (no silent success).
        if (causeTraceId !== undefined) declareLayoutCause(causeTraceId);
        const atUnixMs = presentationNowUnixMs();
        const pair = press(at, p.button === "right" ? "right" : "left", 1);
        const refused = await playGesture(
          surface.label,
          phase === "down" ? [pair[0]] : phase === "up" ? [pair[1]] : pair,
        );
        if (refused) return refused;
        return clickStimulusReceipt(causeTraceId, {
          clicked: true,
          address: addr,
          atUnixMs,
          clock: PRESENTATION_CLOCK,
          surface: surface.label,
          ...(phase ? { phase } : {}),
          ...(await observationResult()),
        });
      }
      const types =
        phase === "down"
          ? ["mousedown"]
          : phase === "up"
            ? ["mouseup", "click"]
            : ["mousedown", "mouseup", "click"];
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      // The cause declaration comes before the stimulus — a click handler can open a layout transaction
      // in the same tick.
      if (causeTraceId !== undefined) declareLayoutCause(causeTraceId);
      const atUnixMs = presentationNowUnixMs();
      for (const type of types) {
        el.dispatchEvent(
          new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, composed: true, button: 0 }),
        );
      }
      return clickStimulusReceipt(causeTraceId, phase
        ? {
          clicked: true, address: addr, atUnixMs, clock: PRESENTATION_CLOCK, phase,
          ...(await observationResult()),
        }
        : {
          clicked: true, address: addr, atUnixMs, clock: PRESENTATION_CLOCK,
          ...(await observationResult()),
        });
    },
  });

  // If only committed strings can be injected, the composition span is never exercised and "Hangul input
  // works" gets claimed anyway.
  register("ui.input.compose", {
    description: key("cmd.ui.input.compose.desc"),
    triggers: { ko: "조합 IME 한글 미확정 preedit 입력중 컴포지션 주입" },
    params: {
      address: { type: "string", description: key("cmd.ui.input.compose.param.address"), required: true },
      text: { type: "string", description: key("cmd.ui.input.compose.param.text"), required: false },
    },
    returns: "{ address, surface, composing }",
    message: (d) => tmsg(d.composing == null ? "msg.ui.input.compose.end" : "msg.ui.input.compose"),
    errors: ["NOT_EXPOSED", "AMBIGUOUS", "NOT_A_SURFACE", "SURFACE_INPUT_UNAVAILABLE", "PROJECTION_UNDECLARED"],
    danger: "inject",
    examples: [
      'ui.input.compose \'{"address":"win/main/…/surface","text":"한"}\'',
      'ui.input.compose \'{"address":"win/main/…/surface"}\'   # end the composition',
    ],
    handler: async (p) => {
      const addr = p.address as string;
      const found = resolveExposed(addr);
      if (!("el" in found)) return found;
      const surface = gestureSurface(found.el, addr);
      if (surface && "ok" in surface) return surface;
      if (surface === null) {
        return {
          ok: false as const,
          code: "NOT_A_SURFACE" as const,
          message: tmsg("msg.ui.compose.notASurface", { address: addr }),
        };
      }
      if (!hasContentViewHost()) return noGesturePath(addr);
      const text = typeof p.text === "string" ? (p.text as string) : "";
      try {
        // Composition is still a fact of the surface the framework holds — the axis opens when an owner
        // declares that spot.
        await contentViewHost().markText(surface.label, text);
      } catch (error) {
        return {
          ok: false as const,
          code: "SURFACE_INPUT_UNAVAILABLE" as const,
          message: tmsg("msg.ui.compose.failed", {
            surface: surface.label,
            error: error instanceof Error ? error.message : String(error),
          }),
        };
      }
      return { address: addr, surface: surface.label, composing: text.length === 0 ? null : text };
    },
  });

  // When a pointer does not arrive at a surface, that fact alone fixes nothing. Every condition that
  // determines delivery is state of that surface and window — with nowhere to ask, the cause stays a
  // guess forever.
  register("ui.input.state", {
    description: key("cmd.ui.input.state.desc"),
    triggers: { ko: "표면 입력 상태 왜 안닿음 배달조건 responder 보이는사각형 진단" },
    params: {
      address: { type: "string", description: key("cmd.ui.input.state.param.address"), required: true },
      x: { type: "number", description: key("cmd.ui.input.state.param.x"), required: false },
      y: { type: "number", description: key("cmd.ui.input.state.param.y"), required: false },
    },
    returns: "{ address, surface, state:{ attached, hidden?, windowIsKey?, acceptsMouseMovedEvents?, isFirstResponder?, bounds?, visibleRect?, askedPoint?, topWindowAtPoint?, windowTopmostAtPoint? } }",
    message: () => tmsg("msg.ui.input.state"),
    errors: ["NOT_EXPOSED", "AMBIGUOUS", "NOT_A_SURFACE", "SURFACE_INPUT_UNAVAILABLE", "PROJECTION_UNDECLARED"],
    examples: ['ui.input.state \'{"address":"win/main/content/view/x/tab/t1/node/plugin-view/b-main-t1/surface"}\''],
    handler: async (p) => {
      const addr = p.address as string;
      const found = resolveExposed(addr);
      if (!("el" in found)) return found;
      const surface = gestureSurface(found.el, addr);
      if (surface && "ok" in surface) return surface;
      if (surface === null) {
        return {
          ok: false as const,
          code: "NOT_A_SURFACE" as const,
          message: tmsg("msg.ui.input.state.notASurface", { address: addr }),
        };
      }
      if (!hasContentViewHost()) return noGesturePath(addr);
      try {
        const at = typeof p.x === "number" && typeof p.y === "number"
          ? { x: p.x as number, y: p.y as number }
          : undefined;
        const sink = surfaceInputProvider(surface.label) ?? contentViewHost();
        return { address: addr, surface: surface.label, state: await sink.inputState(surface.label, at) };
      } catch (error) {
        return {
          ok: false as const,
          code: "SURFACE_INPUT_UNAVAILABLE" as const,
          message: tmsg("msg.ui.input.state.failed", {
            surface: surface.label,
            error: error instanceof Error ? error.message : String(error),
          }),
        };
      }
    },
  });

  // Features reachable only by keyboard (palette arrows, Esc, shortcuts such as Ctrl+R) cannot be
  // checked by click injection. With no surface for that, "the keyboard path was not verified" is what
  // remains — so keys are injected.
  register("ui.input.key", {
    description: key("cmd.ui.input.key.desc"),
    triggers: { ko: "키 입력 키보드 단축키 방향키 엔터 이스케이프 주입 E2E" },
    params: {
      address: { type: "string", description: key("cmd.ui.input.key.param.address"), required: true },
      key: { type: "string", description: key("cmd.ui.input.key.param.key"), required: true },
      ctrl: { type: "boolean", description: key("cmd.ui.input.key.param.ctrl") },
      meta: { type: "boolean", description: key("cmd.ui.input.key.param.meta") },
      shift: { type: "boolean", description: key("cmd.ui.input.key.param.shift") },
      alt: { type: "boolean", description: key("cmd.ui.input.key.param.alt") },
    },
    returns: "{ key, address, defaultPrevented }",
    message: (d) => tmsg("msg.ui.input.key", { key: String(d.key ?? "") }),
    errors: ["NOT_EXPOSED", "AMBIGUOUS", "INVALID_PARAMS", "OTHER_REALM", "SURFACE_INPUT_UNAVAILABLE", "PROJECTION_UNDECLARED"],
    danger: "inject",
    examples: [
      'ui.input.key \'{"address":"win/main/content/view/x/node/composer-input","key":"r","ctrl":true}\'',
      'ui.input.key \'{"address":"…/node/composer-input","key":"ArrowDown"}\'',
    ],
    handler: async (p) => {
      const addr = p.address as string;
      const key = p.key as string;
      if (typeof key !== "string" || key.length === 0) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "key is required" };
      }
      const found = resolveExposed(addr);
      if (!("el" in found)) return found;
      const el = found.el;
      // A node on another surface takes real keys injected into that surface — a key event built on the
      // host has no route inside, and even when it does land, the absence of user activation makes the
      // engine block it.
      const keySurface = gestureSurface(el, addr);
      if (keySurface && "ok" in keySurface) return keySurface;
      if (keySurface) {
        if (!hasContentViewHost()) return noGesturePath(addr);
        try {
          await contentViewHost().sendKey(keySurface.label, key, {
            ctrl: p.ctrl === true, meta: p.meta === true,
            shift: p.shift === true, alt: p.alt === true,
          });
        } catch (error) {
          return {
            ok: false as const,
            code: "SURFACE_INPUT_UNAVAILABLE" as const,
            message: tmsg("msg.ui.input.key.failed", {
              surface: keySurface.label,
              error: error instanceof Error ? error.message : String(error),
            }),
          };
        }
        return { dispatched: true, address: addr, key, surface: keySurface.label };
      }
      const init: KeyboardEventInit = {
        key,
        ctrlKey: p.ctrl === true,
        metaKey: p.meta === true,
        shiftKey: p.shift === true,
        altKey: p.alt === true,
        bubbles: true,
        composed: true,
        cancelable: true,
      };
      // Without focus, even an event delivered to the element with the handler diverges from the browser
      // default action.
      if (el instanceof HTMLElement) el.focus();
      const down = new KeyboardEvent("keydown", init);
      el.dispatchEvent(down);
      el.dispatchEvent(new KeyboardEvent("keyup", init));
      return { key, address: addr, defaultPrevented: down.defaultPrevented };
    },
  });

  // Drives both pointer presence and absence on the same surface.
  //
  // Why: a hover state such as gutter emphasis was owned by CSS :hover, and :hover can be neither turned
  // on nor off by script — not drivable meant not verifiable. On top of that, when the pointer left into
  // a native child (a browser surface) the webview never received leave and stayed latched, and the
  // accent vertical line remained across the browser at the full height of the window body (measured
  // 2026-07-26: ui.hit returned that gutter, and its rect matched the native emphasis bar frame).
  //
  // Once ownership moved into state, that state must be drivable through the same path as the OS. leave
  // is not a separate verb but the absence of the same verb — one command emits both (the pair is never
  // split).
  register("ui.input.pointer", {
    description: key("cmd.ui.input.pointer.desc"),
    triggers: { ko: "포인터 이동 hover 강조 진입 이탈 마우스 주입 E2E" },
    params: {
      address: { type: "string", description: key("cmd.ui.input.pointer.param.address") },
      x: { type: "number", description: key("cmd.ui.input.pointer.param.x"), required: false },
      y: { type: "number", description: key("cmd.ui.input.pointer.param.y"), required: false },
    },
    returns: "{ address, surface?, gutterHover }",
    message: () => tmsg("msg.ui.input.pointer"),
    errors: ["NOT_EXPOSED", "AMBIGUOUS", "OTHER_REALM", "SURFACE_INPUT_UNAVAILABLE", "PROJECTION_UNDECLARED"],
    danger: "inject",
    examples: [
      'ui.input.pointer \'{"address":"win/main/chrome/gutter/pan-g2h3j4/right"}\'',
      "ui.input.pointer   # leave (clears the highlight)",
    ],
    handler: async (p) => {
      const addr = typeof p.address === "string" ? p.address : null;
      if (addr == null) {
        useGutterHover.getState().set(null);
        return { address: null, gutterHover: useGutterHover.getState().key };
      }
      const found = resolveExposed(addr);
      if (!("el" in found)) return found;
      const el = found.el;
      // A move to a place on another surface is injected into that surface — a move planted on the host
      // cannot create hover inside it.
      const surface = gestureSurface(el, addr);
      // A projection with a missing declaration stops here. Falling through to the
      // host DOM matches nothing and still answers success.
      if (surface && "ok" in surface) return surface;
      if (surface) {
        if (!hasContentViewHost()) return noGesturePath(addr);
        const at = gesturePoint(surface, p);
        // A human pointer enters first and then moves — the engine starts hover from that pair.
        // Sending only the move means moving on a surface never entered, so it never settles.
        const refused = await playGesture(surface.label, [
          { ...at, kind: "enter", button: "left", clickCount: 1 },
          { ...at, kind: "move", button: "left", clickCount: 1 },
        ]);
        if (refused) return refused;
        return { address: addr, surface: surface.label, gutterHover: useGutterHover.getState().key };
      }
      const key = el instanceof HTMLElement ? (el.dataset.gutterKey ?? null) : null;
      if (key != null) useGutterHover.getState().set(key);
      el.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false, composed: true }));
      el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, composed: true }));
      el.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, composed: true }));
      return { address: addr, gutterHover: useGutterHover.getState().key };
    },
  });

  // Runs the phase slowly and scans the DOM at the stopped position.
  //
  // Why: these defects are visible only mid-motion — a surface stranded at its old place makes the
  // sidebar look doubled, a tab return flickers, and a vertical line remains while the panel is
  // narrowed. No amount of capturing a resting state catches the instant. Observation requires making it
  // slow and stoppable.
  //
  // scale: stretches every transition/animation by this factor (:root --motion-scale).
  // hold:  freezes the running phase in place (animation-play-state: paused plus transitions stopped).
  //        Whether the window holds together structurally right now — the defects people reported are
  //        stated as invariants and the app answers for itself.
  //
  // These defects have to be checked the same way every time, and writing a one-off probe for each check
  // starts from scratch the next time. Observation must be a command — what is here is the standard, and
  // the e2e gate only calls this command.
  register("ui.verify", {
    description: key("cmd.ui.verify.desc"),
    triggers: { ko: "창 점검 불변식 검증 무결성 주소중복 레일잔존 빈슬롯 자가진단" },
    params: {},
    returns: "{ passed, failed, unanswered, checks: [{ name, ok, answered, detail }] }",
    message: (d) =>
      tmsg("msg.ui.verify", {
        failed: String(d.failed ?? 0),
        total: String((d.checks as unknown[] | undefined)?.length ?? 0),
      }),
    examples: ["ui.verify"],
    handler: async () => {
      const scanned = collectExposed();
      // A check has three answers: passed, violated, and not measurable. Folding
      // three into two makes one of them false. Reporting a check that could not
      // run as passed is a fake GREEN; reporting it as violated sends someone to
      // fix a defect that was never measured. A check that could not run has
      // `answered:false`, and `passed` is false while any check is unanswered.
      const checks: { name: string; ok: boolean; detail: string; answered?: boolean }[] = [];

      // A1 uniqueness — when one address resolves to two, neither a measurement nor a click has a known
      // destination.
      const seen = new Map<string, number>();
      for (const n of scanned) seen.set(n.address, (seen.get(n.address) ?? 0) + 1);
      const dup = [...seen.entries()].filter(([, c]) => c > 1);
      checks.push({
        name: "address.unique",
        ok: dup.length === 0,
        detail:
          dup.length === 0
            ? `${scanned.length} addresses, all unique`
            : dup.map(([a, c]) => `${a} ×${c}`).join(", "),
      });

      // Once the journey ends no departing rail remains — one that remains makes the sidebar look
      // doubled.
      const traveling = document.querySelector(".space-body.rail-traveling") != null;
      const leaving = scanned.filter((n) => n.nodePath === "rail/left/leaving");
      checks.push({
        name: "rail.settled",
        ok: traveling || leaving.length === 0,
        detail: traveling
          ? "travel in progress — verdict withheld"
          : leaving.length === 0
            ? "no rail left behind"
            : leaving.map((n) => n.address).join(", "),
      });

      // A visible tab body has a size — 0 means that cell is a blank screen.
      const collapsed = scanned.filter((n) => {
        if (!n.nodePath.startsWith("layout/tab/")) return false;
        const r = n.el.getBoundingClientRect();
        const onScreen =
          r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight;
        return onScreen && (r.width <= 0 || r.height <= 0);
      });
      checks.push({
        name: "tab.sized",
        ok: collapsed.length === 0,
        detail:
          collapsed.length === 0
            ? `${scanned.filter((n) => n.nodePath.startsWith("layout/tab/")).length} visible tab bodies, all sized`
            : collapsed.map((n) => n.address).join(", "),
      });

      // The time the screen uses and the time the phase closes are the same — split them and landing is
      // declared mid-move.
      const wall = railTravelWallMs();
      const timer = railTravelMs();
      checks.push({
        name: "motion.paired",
        ok: wall === timer,
        detail: `screen ${wall}ms / phase ${timer}ms`,
      });

      // A? Surfaces are inside the window — a surface outside the document is not caught by a DOM check.
      //
      // Incident 2026-08-09: content surfaces scattered outside the window and overlapped on the right
      // of the screen, and this check answered pass at that very moment. Nobody knew until a person
      // looked at a screenshot and said so. Geometry is judged by geometry.
      try {
        // Reads the framework's engine surface observation as is — the same place webview.surfaces uses.
        const surfaces = await invoke<{ surfaces?: SurfaceFrameFact[] }>("engine_surface_stats");
        const root = document.documentElement;
        const outside = surfacesOutsideWindow(surfaces?.surfaces ?? [], {
          w: root.clientWidth,
          h: root.clientHeight,
        });
        // Records how many were seen — an empty list would otherwise pass as "all inside".
        const visible = (surfaces?.surfaces ?? []).filter(
          (row) => row.hidden !== true && row.effectivelyHidden !== true,
        ).length;
        // A surface the app does not know — one missing from the ledger and left only in native cannot
        // be found through the ledger.
        checks.push({
          name: "surface-inside-window",
          ok: outside.length === 0,
          detail: outside.length === 0
            ? `${visible} visible surfaces, all inside the window`
            : outside
                .map((row) => `${row.label} outside the window by ${JSON.stringify(row.overflow)}`)
                .join(", "),
        });
      } catch (error) {
        // What could not be read is not a pass. This axis answers "not measurable"
        // under its own name.
        checks.push({
          name: "surface-inside-window",
          ok: false,
          answered: false,
          detail: `surface geometry unreadable: ${error instanceof Error ? error.message : String(error)}`,
        });
      }

      // Whether the document fits the window. A mismatch clips the right and bottom by that difference,
      // and any line drawn there is invisible — the screen looks identical to "no line was drawn", but
      // the cause is different.
      //
      // Measured 2026-08-15: window 999, document 1000. The plane's right edge sat 1px outside the
      // viewport, and overlapping with flat not drawing a frame it looked like a single symptom.
      //
      // The window size is asked of the framework. A document checking itself against its own size
      // always passes.
      try {
        const monitors = await invoke<{
          windows?: { label?: string; contentW?: number | null; contentH?: number | null }[];
        }>("window_monitors");
        const label = currentWindowLabel();
        const mine = (monitors?.windows ?? []).find((row) => row.label === label);
        const root = document.documentElement;
        // Compared against the content rect. The window frame (w/h) is a different rect that includes
        // chrome, so comparing against it reports only the fact that the two measurements measured
        // different things as a defect.
        if (!mine || typeof mine.contentW !== "number" || typeof mine.contentH !== "number") {
          checks.push({
            name: "viewport-fits-window",
            ok: false,
            answered: false,
            detail: `the framework did not report this window's content size (${label})`,
          });
        } else {
          const overflowX = root.clientWidth - mine.contentW;
          const overflowY = root.clientHeight - mine.contentH;
          checks.push({
            name: "viewport-fits-window",
            ok: overflowX <= 0 && overflowY <= 0,
            detail:
              overflowX <= 0 && overflowY <= 0
                ? `document ${root.clientWidth}×${root.clientHeight} fits the content area ${mine.contentW}×${mine.contentH}`
                : `document is larger than the content area — clipped by ${overflowX}px across and ${overflowY}px down` +
                  ` (document ${root.clientWidth}×${root.clientHeight}, content ${mine.contentW}×${mine.contentH})`,
          });
        }
      } catch (error) {
        checks.push({
          name: "viewport-fits-window",
          ok: false,
          answered: false,
          detail: `window geometry unreadable: ${error instanceof Error ? error.message : String(error)}`,
        });
      }

      // Measured violations and unmeasurable axes are counted apart. `failed` is
      // the number of observed violations, so it is the number of places to fix.
      // `unanswered` is the number of axes this build cannot judge yet, which is
      // a wiring gap. One combined number sends the caller after defects that
      // were never measured.
      const answered = checks.map((c) => ({ ...c, answered: c.answered !== false }));
      const failed = answered.filter((c) => c.answered && !c.ok);
      const unanswered = answered.filter((c) => !c.answered);
      // The verdict is passed in the payload — ok is a reserved envelope key, so putting it here gets it
      // swallowed and the caller reads "the command ran" as "the check passed" (the check itself becomes
      // a fake GREEN).
      return {
        passed: failed.length === 0 && unanswered.length === 0,
        failed: failed.length,
        unanswered: unanswered.length,
        checks: answered,
      };
    },
  });

  register("ui.layout.status", {
    description: key("cmd.ui.layout.status.desc"),
    triggers: { ko: "레이아웃 거래 상태 장벽 진단 정착 리비전 애니메이션" },
    params: {},
    returns: "{ settled, motion, settlement, settlementEvents:[{key,phase:'invalidated'|'settled',revision,clock,atUnixMs}], arrangementPhases:[{ownerKey,current,displayed,phase,preparationTargetKey,lastFailure}], transitionIntents:{owners:[{ownerKey,active,queued}],events:[{sequence,ownerKey,revision,generation,phase,reason?,transactionId?,failure?}],maxEvents}, decorationMotions:[{scope,receipt:{status,owner,generation,sequence,activeAnimations}}], decorationClearance:{owners:[{transactionId,status,producer,railRole,railVisibility,callbackCount,clearedAtUnixUs?,failure?,sequence}],events,maxEvents}, animations, contentViewLabels, presentationPending:[{owner:'content'|'view',stage?,labels,startedAtUnixMs,elapsedMs}] }",
    message: () => tmsg("msg.ui.motion"),
    examples: ["ui.layout.status"],
    handler: () => ({
      ...layoutSettlementStatus(useSessions.getState().activeId || undefined),
      decorationMotions: layoutDecorationMotionFacts(),
      decorationClearance: layoutDecorationClearanceFacts(),
    }),
  });

  register("ui.layout.wait-settled", {
    description: key("cmd.ui.layout.wait-settled.desc"),
    triggers: { ko: "레이아웃 거래 정착 대기 애니메이션 완료" },
    params: {
      timeoutMs: { type: "number", description: key("cmd.ui.layout.wait-settled.param.timeoutMs") },
    },
    returns: "{ settled:true, waitedMs, animations, settledAtUnixMs, clock, syncPending, presentation:{content:{owner:'content',status:'settled',elapsedMs,labels,details?}|null,view:{owner:'view',status:'settled',elapsedMs,labels,details?}|null} }",
    message: () => tmsg("msg.ui.motion"),
    errors: ["INVALID_PARAMS", "TIMEOUT", "PRESENTATION_PROVIDER_FAILED", "LAYOUT_SETTLEMENT_FAILED"],
    examples: ['ui.layout.wait-settled \'{"timeoutMs":8000}\''],
    handler: async (p) => {
      const timeoutMs = typeof p.timeoutMs === "number" ? p.timeoutMs : 4_000;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "timeoutMs must be in (0, 30000]" };
      }
      try {
        return await waitLayoutSettled(timeoutMs, useSessions.getState().activeId || undefined);
      } catch (error) {
        if (error instanceof LayoutSettlementFailure) {
          return {
            ok: false as const,
            code: error.code,
            message: error.message,
            data: error.receipt,
          };
        }
        if (error instanceof LayoutSettlementTimeout) {
          return {
            ok: false as const,
            code: error.code,
            message: error.message,
            data: { status: error.status },
          };
        }
        return {
          ok: false as const,
          code: "LAYOUT_SETTLEMENT_FAILED" as const,
          message: "layout settlement failed",
          data: { providerError: serializePresentationProviderError(error) },
        };
      }
    },
  });

  register("ui.motion", {
    description: key("cmd.ui.motion.desc"),
    triggers: { ko: "모션 느리게 정지 일시정지 애니메이션 배속 관측 디버그" },
    params: {
      scale: { type: "number", description: key("cmd.ui.motion.param.scale") },
      hold: { type: "boolean", description: key("cmd.ui.motion.param.hold") },
    },
    returns: "{ scale, hold, applied, running, rates, wallMs, animations }",
    message: () => tmsg("msg.ui.motion"),
    errors: ["INVALID_PARAMS"],
    danger: "inject",
    examples: [
      'ui.motion \'{"scale":20}\'   # twenty times slower',
      'ui.motion \'{"hold":true}\'  # freeze in place',
      "ui.motion            # read the current setting",
    ],
    handler: (p) => {
      if (typeof p.scale === "number" && (!(p.scale > 0) || p.scale > 200)) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "scale must be in (0, 200]" };
      }
      // motionDebug alone owns the setting — this command reads the exact moment the dev UI paused,
      // unchanged.
      const st = setMotionDebug({
        scale: typeof p.scale === "number" ? p.scale : undefined,
        hold: typeof p.hold === "boolean" ? p.hold : undefined,
      });
      // running and rates are results — "the setting was applied" does not stand in for "it slowed down"
      // (incident: the custom property existed with no consumer, so the state read 20 while the screen
      // was unchanged).
      return { ...st, ...motionLiveRates(), animations: motionLiveList(), recentBirths: motionRecentBirths(), journeys: motionJourneys(), swaps: motionSwaps(), triggers: motionTriggers() };
    },
  });

  // Captures the change of a moving node as fact — a time-bounded rect series (an observation command,
  // user requirement 2026-07-26: "when the DOM moves, the change of that DOM must be traceable too").
  // Events such as transitionrun can be missing depending on the engine implementation (measured: births
  // 0 on a registered-variable transition), but rect is the screen result itself and cannot be missing.
  // rAF samples, so a capture, not polling (5s cap). Whether an injected input arrives — the blank
  // between driving and judging.
  //
  // Without it a failure splits two ways that cannot be told apart: the event never went, or it went and
  // the receiver did not move. Those are fixed in completely different places (injection surface vs app
  // logic). "No idea what happened inside" is not a diagnosis; it means there is no observation surface
  // — hence this one.
  //
  // Attached to window in capture: it sees the event before the app's listeners, so arrival is recorded
  // whether the app blocks it or removes it. Arrived but the app did not move is a fact about the app;
  // not arrived is a fact about the injection surface.
  register("ui.input.observe", {
    description: key("cmd.ui.input.observe.desc"),
    triggers: { ko: "입력 도착 관측 이벤트 수신 확인 주입 검증" },
    params: {
      events: {
        type: "json",
        description: key("cmd.ui.input.observe.param.events"),
      },
      ms: { type: "number", description: key("cmd.ui.input.observe.param.ms") },
    },
    returns: "{ ms, counts: { <type>: n }, samples: [{ t, type, x, y, target }] }",
    message: (d) =>
      tmsg("msg.ui.input.observe", {
        n: Object.values((d.counts as Record<string, number>) ?? {}).reduce((a, b) => a + b, 0),
      }),
    examples: ['ui.input.observe \'{"events":["mousemove"],"ms":1500}\''],
    handler: async (p) => {
      const ms = Math.min(Math.max(typeof p.ms === "number" ? p.ms : 1000, 50), 5000);
      const types = Array.isArray(p.events) && p.events.length > 0
        ? p.events.map(String)
        : ["mousedown", "mousemove", "mouseup"];
      const counts: Record<string, number> = {};
      for (const t of types) counts[t] = 0;
      // Samples are capped — one drag at hundreds of frames would push the answer out of the ledger.
      const samples: { t: number; type: string; x: number; y: number; target: string }[] = [];
      const t0 = performance.now();
      const wired: [string, EventListener][] = types.map((type) => [
        type,
        (e: Event) => {
          counts[type] += 1;
          if (samples.length >= 60) return;
          const me = e as MouseEvent;
          const el = e.target as HTMLElement | null;
          samples.push({
            t: Math.round(performance.now() - t0),
            type,
            x: Math.round(me.clientX ?? -1),
            y: Math.round(me.clientY ?? -1),
            // Where it went is a fact too — the same coordinate with a different target is a different
            // story.
            target:
              el?.getAttribute?.("data-node") ??
              (el?.tagName ? el.tagName.toLowerCase() : String(e.target === window ? "window" : "?")),
          });
        },
      ]);
      for (const [type, fn] of wired) window.addEventListener(type, fn, true);
      try {
        await new Promise<void>((done) => setTimeout(done, ms));
      } finally {
        for (const [type, fn] of wired) window.removeEventListener(type, fn, true);
      }
      return { ms, counts, samples };
    },
  });

  register("ui.trace", {
    description: key("cmd.ui.trace.desc"),
    triggers: { ko: "노드 추적 이동 기록 rect 시계열 트레이스" },
    params: {
      address: { type: "string", description: key("cmd.ui.trace.param.address"), required: true },
      ms: { type: "number", description: key("cmd.ui.trace.param.ms") },
    },
    returns:
      "{ address, from, to, samples: [{ t, x, y, w, h }], moved, translatedOnly(true = x/y changed while w/h stayed — the move-contract), resized }",
    message: (d) => tmsg("msg.ui.trace", { n: String((d.samples as unknown[])?.length ?? 0) }),
    errors: ["NOT_EXPOSED", "AMBIGUOUS", "INVALID_PARAMS"],
    handler: async (p) => {
      const ms = Math.min(Math.max(typeof p.ms === "number" ? p.ms : 1000, 50), 5000);
      const found = resolveExposed(String(p.address ?? ""));
      if ("ok" in found) return found;
      const el = found.el;
      const t0 = performance.now();
      const samples: { t: number; x: number; y: number; w: number; h: number }[] = [];
      // The sample cadence is a timer — rAF stops in an occluded window and this command would never
      // finish (measured: a background-window trace hit TIMEOUT — the trap in
      // reference_live-drag-verify-traps). A capture command has time as its axis, so a timer is exact
      // and it completes regardless of occlusion.
      await new Promise<void>((done) => {
        const tick = () => {
          const r = el.getBoundingClientRect();
          samples.push({
            t: Math.round(performance.now() - t0),
            x: Math.round(r.x * 10) / 10,
            y: Math.round(r.y * 10) / 10,
            w: Math.round(r.width * 10) / 10,
            h: Math.round(r.height * 10) / 10,
          });
          if (performance.now() - t0 >= ms) done();
          else setTimeout(tick, 16);
        };
        tick();
      });
      const first = samples[0];
      const last = samples[samples.length - 1];
      // Move contract decision — "content only moves, it never shrinks" (user invariant). Along with the
      // start and end rects it answers, as fact, whether the size changed at any sample (resized) and
      // whether it was a pure translation (translatedOnly) — the harness catches violations with this
      // decision.
      const translated = samples.some(
        (s2) => Math.abs(s2.x - first.x) > 0.5 || Math.abs(s2.y - first.y) > 0.5,
      );
      const resized = samples.some(
        (s2) => Math.abs(s2.w - first.w) > 0.5 || Math.abs(s2.h - first.h) > 0.5,
      );
      return {
        address: String(p.address ?? ""),
        from: { x: first.x, y: first.y, w: first.w, h: first.h },
        to: { x: last.x, y: last.y, w: last.w, h: last.h },
        samples,
        moved: translated || resized,
        translatedOnly: translated && !resized,
        resized,
      };
    },
  });

  register("ui.trace.multi.start", {
    description: key("cmd.ui.trace.multi.start.desc"),
    triggers: { ko: "다중 DOM 거래 추적 시작 구독 무장" },
    params: {
      addresses: {
        type: "json",
        description: key("cmd.ui.trace.multi.start.param.addresses"),
        required: true,
      },
      maxMs: {
        type: "number",
        description: key("cmd.ui.trace.multi.start.param.maxMs", { max: MULTI_DOM_TRACE_MAX_MS }),
      },
      producers: {
        type: "json",
        description: key("cmd.ui.trace.multi.start.param.producers"),
      },
    },
    returns:
      "{ traceId, clock, addresses, startedAtUnixMs, expiresAtUnixMs, producersEnabled } —"
      + " the subscription is installed before this ACK",
    message: () => tmsg("msg.ui.trace", { n: "1" }),
    errors: ["NOT_EXPOSED", "AMBIGUOUS", "INVALID_PARAMS"],
    handler: (p) => {
      const addresses = p.addresses;
      if (!Array.isArray(addresses)
          || addresses.length < 1
          || addresses.length > 16
          || addresses.some((address) => typeof address !== "string" || address.length === 0)
          || new Set(addresses).size !== addresses.length
          || (p.maxMs !== undefined
            && (typeof p.maxMs !== "number" || !Number.isFinite(p.maxMs) || p.maxMs <= 0))) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: tmsg("msg.ui.trace.multi.addressesInvalid"),
        };
      }
      const targets: { address: string; el: HTMLElement }[] = [];
      for (const address of addresses as string[]) {
        const found = resolveExposed(address);
        if ("ok" in found) return found;
        targets.push({ address, el: found.el });
      }
      if (multiDomTraceSessions.size >= MULTI_DOM_TRACE_MAX_SESSIONS) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: tmsg("msg.ui.trace.multi.tooMany", { max: MULTI_DOM_TRACE_MAX_SESSIONS }),
        };
      }
      const maxMs = Math.min(
        Math.max(typeof p.maxMs === "number" ? p.maxMs : 5_000, 50),
        MULTI_DOM_TRACE_MAX_MS,
      );
      const requested = p.producers as { interval?: unknown } | undefined;
      const producersParam = {
        interval: typeof requested?.interval === "boolean" ? requested.interval : true,
      };
      const unixFromPerformance = presentationUnixMsFromDocumentTime(0);
      const traceId = crypto.randomUUID();
      const startedAtUnixMs = unixFromPerformance + performance.now();
      const session: MultiDomTraceSession = {
        traceId,
        addresses: [...addresses] as string[],
        targets,
        unixFromPerformance,
        startedAtUnixMs,
        expiresAtUnixMs: startedAtUnixMs + maxMs,
        endedAtUnixMs: null,
        timedOut: false,
        samples: [],
        presentationFrame: null,
        presentationTransactionId: null,
        presentationTraceId: null,
        presentationDomCommittedAtUnixMs: null,
        motionLifecycleByAddress: new Map(),
        motionStartFrameByAddress: new Map(),
        animationEndHandler: null,
        settlementObserver: null,
        intervalProducer: null,
        intervalEnabled: producersParam.interval,
        unsubscribe: () => {},
        unsubscribeDisplayFrames: () => {},
        expiryTimer: null,
        evictionTimer: null,
        producerCounts: emptyMultiDomProducerCounts(),
        slotObservation: null,
        nativeSlotObservation: null,
        nextSlotSourceGeneration: 0,
      };
      // There is no await, timer, or callback boundary between the initial read and the listener
      // install. The start ACK is emitted only after the same JS stack finishes, so a stimulus that
      // received the ACK cannot slip in before this subscription.
      appendMultiDomTraceSample(session, "initial", "arm", null, null);
      session.unsubscribeDisplayFrames = onPresentationDisplayFrame((frame) => {
        const transactionId = session.presentationTransactionId;
        if (session.endedAtUnixMs !== null
            || transactionId === null
            || frame.traceId !== session.presentationTraceId) return;
        appendMultiDomTraceSample(
          session,
          "presentation-frame",
          "native-display-frame",
          transactionId,
          session.presentationDomCommittedAtUnixMs,
          undefined,
          frame,
        );
        const observation = session.nativeSlotObservation;
        if (!observation
            || observation.transactionId !== transactionId
            || observation.sourceGeneration !== frame.sourceGeneration) {
          session.nativeSlotObservation = {
            transactionId,
            clock: frame.clock,
            sourceGeneration: frame.sourceGeneration,
            frameSequences: [frame.frameSequence],
          };
        } else if (!observation.frameSequences.includes(frame.frameSequence)) {
          observation.frameSequences.push(frame.frameSequence);
        }
      });
      session.unsubscribe = onLayoutTransitionJournal((event) => {
        if (event.type === "prepared" && event.mode === "glide") {
          session.presentationTraceId = event.causeTraceId ?? null;
          startMultiDomPresentationFrames(session, event.transactionId);
          return;
        }
        if (event.type !== "dom-committed") return;
        appendMultiDomTraceSample(
          session,
          "layout-dom-commit",
          "layout-commit",
          event.transactionId,
          event.domCommittedAtUnixMs,
        );
        bindMultiDomPresentationCommit(
          session,
          event.transactionId,
          event.domCommittedAtUnixMs,
        );
      });
      multiDomTraceSessions.set(traceId, session);
      // A single termination barrier that always reclaims, even in an occluded window. Not coordinate
      // polling.
      session.expiryTimer = setTimeout(() => finishMultiDomTrace(session, true), maxMs);
      return {
        traceId,
        clock: PRESENTATION_CLOCK,
        addresses: [...session.addresses],
        startedAtUnixMs: session.startedAtUnixMs,
        expiresAtUnixMs: session.expiresAtUnixMs,
        producersEnabled: { interval: session.intervalEnabled },
      };
    },
  });

  register("ui.trace.multi.close", {
    description: key("cmd.ui.trace.multi.close.desc"),
    triggers: { ko: "다중 DOM 거래 추적 닫기 원장 조회" },
    params: {
      traceId: { type: "string", description: key("cmd.ui.trace.multi.close.param.traceId"), required: true },
    },
    returns:
      "{ traceId, clock, addresses, startedAtUnixMs, endedAtUnixMs, timedOut, producers:{arm,layout-commit,commit-anchor,frame-callback,native-display-frame,interval,animation-end,settlement}, producersEnabled:{interval}, slotObservation:{status:'observed'|'unmeasured',producer:'frame-callback'|'native-display-frame',clock,transactionId,sourceGeneration,firstFrameSequence,lastFrameSequence,callbackCount,callbackIntervalsSkipped}, samples:[{sequence,sampledAtUnixMs,trigger:'initial'|'layout-dom-commit'|'presentation-frame',producer,transactionId:string|null,domCommittedAtUnixMs:number|null,displayFrame?:{traceId,producer:'native-display-link',clock,sourceGeneration,frameSequence,presentationRevision,presentedAtUnixMs},chrome:{projectId,spaceNode,traveling,rail:{count,role,visibility,nodeIdentity},movingPaneIds:[pane],paneChrome:[{pane,nodeIdentity,rect}],structuralFrames:[{pane,nodeIdentity,rect}],focusBoundaries:[{pane,nodeIdentity,rect}],relationOutlines:[{pane,nodeIdentity,rect,railRect,paneRect,geometry}]},nodes:[{address,connected,rect:{x,y,w,h},motion:null|{producer:'web-animation',phase:'active'|'completed',transactionId,animationName:'rail-flip-x',playState,startTime,currentTime,visualAtUnixMs,startFrame:{x,y,w,h},endFrame:{x,y,w,h}|null}}]}] }",
    message: (d) => tmsg("msg.ui.trace", { n: String((d.samples as unknown[])?.length ?? 0) }),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    handler: (p) => {
      const traceId = typeof p.traceId === "string" ? p.traceId : "";
      if (!traceId) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: tmsg("msg.ui.trace.multi.traceIdRequired"),
        };
      }
      const session = multiDomTraceSessions.get(traceId);
      if (!session) {
        return {
          ok: false as const,
          code: "TARGET_NOT_FOUND" as const,
          message: tmsg("msg.ui.trace.multi.notFound", { traceId }),
        };
      }
      finishMultiDomTrace(session, false);
      multiDomTraceSessions.delete(traceId);
      if (session.evictionTimer !== null) clearTimeout(session.evictionTimer);
      return {
        traceId,
        // Name of the clock that produced this ledger's `...UnixMs` times. The same suffix does not mean
        // the same clock, so comparing against another producer's times on one axis requires both to
        // report this name.
        clock: PRESENTATION_CLOCK,
        addresses: [...session.addresses],
        startedAtUnixMs: session.startedAtUnixMs,
        endedAtUnixMs: session.endedAtUnixMs,
        timedOut: session.timedOut,
        // The reason for a gap is in the observer counts, not between samples. 0 is not "it did not
        // move" but the fact that that observer never fired.
        producers: { ...session.producerCounts },
        // Which observers were on for this ledger — telling two runs apart later requires this fact on
        // the receipt.
        producersEnabled: { interval: session.intervalEnabled },
        slotObservation: multiDomSlotObservation(session),
        samples: session.samples,
      };
    },
  });

  // What is where and how large at the stopped position — scanned in one pass.
  //
  // ui.measure measures one node. Reading an instant requires seeing several nodes of that moment at
  // once: which vertical line is where, how wide the panel is, how large the slots and surfaces inside
  // it are. Several round trips let the state move in between, so different moments end up compared.
  register("ui.snapshot.dom", {
    description: key("cmd.ui.snapshot.dom.desc"),
    triggers: { ko: "돔 일괄 측정 스냅샷 좌표 폭 한번에 관측 선 위치" },
    params: {
      filter: { type: "string", description: key("cmd.ui.snapshot.dom.param.filter") },
      selector: {
        type: "string",
        description: key("cmd.ui.snapshot.dom.param.selector"),
      },
      props: { type: "json", description: key("cmd.ui.snapshot.dom.param.props") },
    },
    examples: [
      "ui.snapshot.dom",
      'ui.snapshot.dom \'{"filter":"pane","props":["backgroundColor"]}\'',
    ],
    returns: "{ count, nodes: [{ address, nodePath, rect, style? }] }",
    message: (d) => tmsg("msg.ui.snapshot.dom", { count: String(d.count ?? 0) }),
    errors: ["INVALID_PARAMS"],
    handler: (p) => {
      const filter = typeof p.filter === "string" ? p.filter : null;
      const props = Array.isArray(p.props) ? (p.props as string[]).filter((x) => typeof x === "string") : [];
      const nodes: unknown[] = [];
      // With a selector, only that is measured — mixing it into the address scan results hides which one
      // is the answer.
      const bySelector = typeof p.selector === "string" && p.selector.trim() !== "";
      for (const n of bySelector ? [] : collectExposed()) {
        const address = n.address;
        if (filter && !address.includes(filter)) continue;
        const el = n.el;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const style: Record<string, string> = {};
        for (const k of props) style[k] = cs.getPropertyValue(k) || (cs as unknown as Record<string, string>)[k] || "";
        nodes.push({
          address,
          nodePath: n.nodePath,
          rect: { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) },
          ...(props.length > 0 ? { style } : {}),
        });
      }
      // Elements without an address are measured too — observation only. Input still requires an address
      // (that contract is "do not knock on what you cannot name", not "do not look at what you cannot
      // name").
      //
      // Without it diagnosis stops there: the content view host (<webview>) and plugin bodies have no
      // address, so there was nowhere at all to ask "where is the surface and how large is it" (measured
      // 2026-07-29: after maximizing a tab the browser was blank, and whether that was a position
      // problem or a visibility problem could not be separated).
      if (bySelector) {
        const sel = String(p.selector);
        for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          const style: Record<string, string> = {};
          for (const k of props) {
            style[k] = cs.getPropertyValue(k) || (cs as unknown as Record<string, string>)[k] || "";
          }
          nodes.push({
            selector: sel,
            // When one selector matches several, which is which must be separable — a mark is included.
            mark:
              el.getAttribute("data-content-view") ??
              el.getAttribute("data-node") ??
              (el.className || el.tagName.toLowerCase()),
            rect: { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) },
            ...(props.length > 0 ? { style } : {}),
          });
        }
      }
      return { count: nodes.length, nodes };
    },
  });

  register("ui.input.dblclick", {
    description: key("cmd.ui.input.dblclick.desc"),
    triggers: { ko: "더블클릭 두번클릭 이름변경 rename 주입 E2E" },
    params: {
      address: { type: "string", description: key("cmd.ui.input.dblclick.param.address"), required: true },
      x: { type: "number", description: key("cmd.ui.input.dblclick.param.x"), required: false },
      y: { type: "number", description: key("cmd.ui.input.dblclick.param.y"), required: false },
      button: { type: "string", description: key("cmd.ui.input.dblclick.param.button"), enum: ["left", "right"], required: false },
    },
    returns: "{ dblclicked, address, surface? }",
    message: () => tmsg("msg.ui.input.dblclick"),
    errors: ["NOT_EXPOSED", "AMBIGUOUS", "INVALID_PARAMS", "OTHER_REALM", "SURFACE_INPUT_UNAVAILABLE", "PROJECTION_UNDECLARED"],
    danger: "inject",
    examples: ['ui.input.dblclick \'{"address":"win/main/chrome/tab/left/a.x"}\''],
    handler: async (p) => {
      const addr = p.address as string;
      const found = resolveExposed(addr);
      if (!("el" in found)) return found;
      const el = found.el;
      // A node on another surface is pressed twice inside that surface — the engine reads a double click
      // only when the second press has click count 2. These four events go out back to back inside one
      // call.
      const surface = gestureSurface(el, addr);
      // A projection with a missing declaration stops here. Falling through to the
      // host DOM matches nothing and still answers success.
      if (surface && "ok" in surface) return surface;
      if (surface) {
        if (!hasContentViewHost()) return noGesturePath(addr);
        const at = gesturePoint(surface, p);
        const button = p.button === "right" ? "right" as const : "left" as const;
        const refused = await playGesture(surface.label, [...press(at, button, 1), ...press(at, button, 2)]);
        if (refused) return refused;
        return { dblclicked: true, address: addr, surface: surface.label };
      }
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const fire = (type: string) =>
        el.dispatchEvent(
          new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, composed: true, button: 0 }),
        );
      // React onDoubleClick listens for the native dblclick — two clicks do not produce it, so dispatch
      // it explicitly.
      fire("mousedown"); fire("mouseup"); fire("click");
      fire("mousedown"); fire("mouseup"); fire("click");
      fire("dblclick");
      return { dblclicked: true, address: addr };
    },
  });

  register("ui.input.fill", {
    description: key("cmd.ui.input.fill.desc"),
    triggers: { ko: "입력 주입 값입력 텍스트입력 폼입력 E2E" },
    params: {
      address: { type: "string", description: key("cmd.ui.input.fill.param.address"), required: true },
      value: { type: "string", description: key("cmd.ui.input.fill.param.value"), required: true },
    },
    returns: "{ filled, address }",
    message: () => tmsg("msg.ui.input.fill"),
    errors: ["NOT_EXPOSED", "AMBIGUOUS", "INVALID_PARAMS", "OTHER_REALM", "PROJECTION_UNDECLARED"],
    danger: "inject",
    examples: [
      'ui.input.fill \'{"address":"win/main/content/view/x/node/url-input","value":"/path/clip.mp4"}\'',
    ],
    handler: async (p) => {
      const addr = p.address as string;
      const found = resolveExposed(addr);
      if (!("el" in found)) return found;
      // Sending an event to a projected node does nothing — do not answer success.
      if (projectedRealmNode(found.el)) {
        // Awaits only for a projection — awaiting for ordinary host nodes too would change the order
        // that follows.
        const routed = await inProjectedRealm(found.el, addr, { kind: "fill", value: p.value as string });
        if (routed) return routed;
      }
      const el = found.el;
      // contenteditable node — an inline editing surface (commit-on-blur contract) is filled by the same
      // command. Replace textContent, then trigger the commit with input plus focusout (React onBlur
      // listens for focusout).
      if (el.isContentEditable) {
        el.focus();
        el.textContent = p.value as string;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
        el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        return { filled: true, contentEditable: true, address: addr };
      }
      if (
        !(el instanceof HTMLInputElement) &&
        !(el instanceof HTMLTextAreaElement)
      )
        return { ok: false as const, code: "INVALID_PARAMS", message: tmsg("msg.ui.input.fill.notAnInput", { address: addr }) };
      // A React controlled input overwrites a direct .value assignment — use the prototype's native
      // setter so onChange fires.
      const proto =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, p.value as string);
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return { filled: true, address: addr };
    },
  });

  register("ui.input.drag", {
    description: key("cmd.ui.input.drag.desc"),
    triggers: { ko: "드래그 주입 드롭 탭이동 분할 합치기 리사이즈 디바이더 E2E 포인터드래그" },
    params: {
      from: { type: "string", description: key("cmd.ui.input.drag.param.from"), required: true },
      to: { type: "string", description: key("cmd.ui.input.drag.param.to"), required: false },
      zone: {
        type: "string",
        description: key("cmd.ui.input.drag.param.zone"),
        enum: ["center", "left", "right", "top", "bottom"],
      },
      x: { type: "number", description: key("cmd.ui.input.drag.param.x"), required: false },
      y: { type: "number", description: key("cmd.ui.input.drag.param.y"), required: false },
      button: { type: "string", description: key("cmd.ui.input.drag.param.button"), enum: ["left", "right"], required: false },
      dx: { type: "number", description: key("cmd.ui.input.drag.param.dx"), required: false },
      dy: { type: "number", description: key("cmd.ui.input.drag.param.dy"), required: false },
      steps: {
        type: "number",
        description: key("cmd.ui.input.drag.param.steps"),
        default: 2,
      },
      durationMs: {
        type: "number",
        description: key("cmd.ui.input.drag.param.durationMs"),
        default: 0,
      },
      recordDir: {
        type: "string",
        description: key("cmd.ui.input.drag.param.recordDir"),
        required: false,
      },
      recordFrames: {
        type: "number",
        description: key("cmd.ui.input.drag.param.recordFrames"),
        default: 120,
      },
      recordIntervalMs: {
        type: "number",
        description: key("cmd.ui.input.drag.param.recordIntervalMs"),
        default: 33,
      },
      recordLeadMs: {
        type: "number",
        description: key("cmd.ui.input.drag.param.recordLeadMs"),
        default: 0,
      },
      recordMaxBytes: {
        type: "number",
        description: key("cmd.ui.input.drag.param.recordMaxBytes"),
        required: false,
      },
    },
    returns: "{ dragged, click?, from, to?, zone?, dx?, dy?, steps, durationMs, surface?, recording:{status:'not-requested'|'complete'|'failed',dir?,requestedFrames?,frames?,mode:'realtime',reason?} }",
    message: (d) => (d.dragged ? tmsg("msg.ui.input.drag.dragged") : tmsg("msg.ui.input.drag.tap")),
    errors: ["NOT_EXPOSED", "AMBIGUOUS", "INVALID_PARAMS", "OTHER_REALM", "SURFACE_INPUT_UNAVAILABLE", "PROJECTION_UNDECLARED"],
    danger: "inject",
    examples: [
      'ui.input.drag \'{"from":"win/main/chrome/tab/left/a.x","to":"win/main/chrome/tab/left/b.y","zone":"center"}\'',
      'ui.input.drag \'{"from":"win/main/chrome/gutter/pan-g2h3j4/right","dx":120}\'',
    ],
    handler: async (p) => {
      const steps = p.steps === undefined ? 2 : Number(p.steps);
      const durationMs = p.durationMs === undefined ? 0 : Number(p.durationMs);
      if (!Number.isInteger(steps) || steps < 1 || steps > 120) {
        return { ok: false as const, code: "INVALID_PARAMS", message: tmsg("msg.ui.input.drag.stepsInvalid") };
      }
      if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 10_000) {
        return { ok: false as const, code: "INVALID_PARAMS", message: tmsg("msg.ui.input.drag.durationInvalid") };
      }
      const recordDir = p.recordDir as string | undefined;
      const recordFrames = p.recordFrames === undefined ? 120 : Number(p.recordFrames);
      const recordIntervalMs = p.recordIntervalMs === undefined ? 33 : Number(p.recordIntervalMs);
      const recordLeadMs = p.recordLeadMs === undefined ? 0 : Number(p.recordLeadMs);
      const recordMaxBytes = p.recordMaxBytes;
      if (
        recordDir &&
        (!Number.isInteger(recordFrames) || recordFrames < 1 || recordFrames > 600 ||
          !Number.isFinite(recordIntervalMs) || recordIntervalMs < 0 ||
          !Number.isFinite(recordLeadMs) || recordLeadMs < 0 || recordLeadMs > 2_000)
      ) {
        return { ok: false as const, code: "INVALID_PARAMS", message: tmsg("msg.ui.record.argsRange") };
      }
      if (
        recordMaxBytes !== undefined &&
        (!recordDir || !validWindowRecordMaxBytes(recordMaxBytes))
      ) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS",
          message: tmsg("msg.ui.record.maxBytesInvalid"),
        };
      }
      const fromR = resolveExposed(p.from as string);
      if (!("el" in fromR)) return fromR;
      // Whether the drag happens on another surface — inside a content view, or inside the realm a
      // projection shows. A move/up fired at the host window is not inside it.
      const dragSurface = gestureSurface(fromR.el, p.from as string);
      if (dragSurface && "ok" in dragSurface) return dragSurface;
      let toSurfacePt: { x: number; y: number } | null = null;
      const fr = fromR.el.getBoundingClientRect();
      const fromPt = { x: fr.left + fr.width / 2, y: fr.top + fr.height / 2 };
      const byDelta = p.dx != null || p.dy != null;
      let toPt: { x: number; y: number };
      if (byDelta) {
        // Mode 2 — pixel delta (resize handle/divider). Grabs the center of from and drags by dx/dy.
        toPt = { x: fromPt.x + (Number(p.dx) || 0), y: fromPt.y + (Number(p.dy) || 0) };
      } else {
        // Mode 1 — drop on a target (tab merge/split).
        const toR = resolveExposed(p.to as string);
        if (!("el" in toR)) return toR;
        if (dragSurface) {
          // A drag is an event inside one surface — with the two ends on different surfaces there is no
          // path between them.
          const toSurface = gestureSurface(toR.el, p.to as string);
          if (toSurface && "ok" in toSurface) return toSurface;
          if (toSurface === null || toSurface.label !== dragSurface.label) {
            return {
              ok: false as const,
              code: "INVALID_PARAMS",
              message: tmsg("msg.ui.input.drag.crossSurface", {
                from: dragSurface.label,
                to: toSurface?.label ?? "host",
              }),
            };
          }
          toSurfacePt = gesturePoint(toSurface, {});
        }
        const tr = toR.el.getBoundingClientRect();
        const zone = (p.zone as string) ?? "center";
        const zx = zone === "left" ? 0.08 : zone === "right" ? 0.92 : 0.5;
        const zy = zone === "top" ? 0.12 : zone === "bottom" ? 0.88 : 0.5;
        toPt = { x: tr.left + tr.width * zx, y: tr.top + tr.height * zy };
      }
      // The injected sequence must be physically consistent: buttons=1 while moving with the button
      // held, 0 after release. Otherwise the core's pointer order recovery reads it as a phantom hold,
      // fires a synthetic mouseup, and closes the gesture at the first move (measured 2026-07-29: gutter
      // drag died, and the observation surface caught that mouseup at the same moment and coordinate as
      // the first move). That protection is right — the inconsistency was on the injection side. When
      // two contracts do not know each other, both stay right and the feature dies.
      const fire = (type: string, x: number, y: number, target: EventTarget) =>
        target.dispatchEvent(
          new MouseEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            composed: true,
            button: 0,
            buttons: type === "mouseup" ? 0 : 1,
          }),
        );
      const dist = Math.hypot(toPt.x - fromPt.x, toPt.y - fromPt.y);
      const recording = recordDir
        ? startWindowRecording({
            dir: recordDir,
            frames: recordFrames,
            intervalMs: recordIntervalMs,
            ...(recordMaxBytes === undefined ? {} : { maxBytes: recordMaxBytes }),
          }, recordWindowFrames)
        : null;
      const recordingReady = await (recording?.ready ?? Promise.resolve(false));
      if (recordingReady && recordLeadMs > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, recordLeadMs));
      }
      if (dragSurface) {
        if (!hasContentViewHost()) return noGesturePath(p.from as string);
        const start = gesturePoint(dragSurface, p);
        const end = byDelta
          ? { x: start.x + (Number(p.dx) || 0), y: start.y + (Number(p.dy) || 0) }
          : toSurfacePt ?? start;
        const button = p.button === "right" ? "right" as const : "left" as const;
        // No move is placed before the grab. The press itself creates hover at that spot (measured
        // 2026-08-08: one click emitted mouseover, mouseenter, and pointerover), and on an engine that
        // cannot receive moves that one leading step kills the whole drag.
        const seq: SurfacePointerInput[] = [{ ...start, kind: "down", button, clickCount: 1 }];
        if (dist >= 5) {
          for (let step = 1; step <= steps; step += 1) {
            const progress = step / steps;
            seq.push({
              x: Math.round(start.x + (end.x - start.x) * progress),
              y: Math.round(start.y + (end.y - start.y) * progress),
              kind: "drag", button, clickCount: 1,
            });
          }
        }
        seq.push({ ...(dist >= 5 ? end : start), kind: "up", button, clickCount: 1 });
        // One gesture, one call — letting the caller stitch the steps puts the interval in the hands of
        // the CLI round trip.
        for (const [index, step] of seq.entries()) {
          const refused = await playGesture(dragSurface.label, [step]);
          if (refused) return refused;
          if (durationMs > 0 && step.kind === "drag" && index < seq.length - 2) {
            await new Promise((resolve) => window.setTimeout(resolve, durationMs / steps));
          }
        }
        const surfaceRecording = recording
          ? await recording.report
          : { status: "not-requested" as const, mode: "realtime" as const };
        return {
          dragged: dist >= 5, click: dist < 5, from: p.from,
          ...(byDelta ? { dx: p.dx ?? 0, dy: p.dy ?? 0 } : { to: p.to, zone: p.zone ?? "center" }),
          steps, durationMs, surface: dragSurface.label, recording: surfaceRecording,
        };
      }
      // mousedown goes to the grabbed element (gutter/tab), move/up to the window — a gutter resize
      // registers window-level mousemove/mouseup listeners on that handle, so they are received only
      // when sent to the window.
      fire("mousedown", fromPt.x, fromPt.y, fromR.el);
      if (dist >= 5) {
        for (let step = 1; step <= steps; step += 1) {
          const progress = step / steps;
          fire(
            "mousemove",
            fromPt.x + (toPt.x - fromPt.x) * progress,
            fromPt.y + (toPt.y - fromPt.y) * progress,
            window,
          );
          if (durationMs > 0 && step < steps) {
            await new Promise((resolve) =>
              window.setTimeout(resolve, durationMs / steps),
            );
          }
        }
      }
      fire("mouseup", toPt.x, toPt.y, window);
      const recordingResult = recording
        ? await recording.report
        : { status: "not-requested" as const, mode: "realtime" as const };
      return byDelta
        ? { dragged: dist >= 5, from: p.from, dx: p.dx ?? 0, dy: p.dy ?? 0, steps, durationMs, recording: recordingResult }
        : { dragged: dist >= 5, click: dist < 5, from: p.from, to: p.to, zone: p.zone ?? "center", steps, durationMs, recording: recordingResult };
    },
  });

  register("ui.input.dnd", {
    description: key("cmd.ui.input.dnd.desc"),
    triggers: { ko: "드래그앤드롭 주입 dnd 파일드롭 재정렬 드롭존 E2E" },
    params: {
      from: { type: "string", description: key("cmd.ui.input.dnd.param.from"), required: false },
      to: { type: "string", description: key("cmd.ui.input.dnd.param.to"), required: true },
      position: {
        type: "string",
        description: key("cmd.ui.input.dnd.param.position"),
        enum: ["center", "before", "after"],
      },
      files: {
        type: "json",
        description: key("cmd.ui.input.dnd.param.files"),
        required: false,
      },
    },
    returns: "{ dropped, from?, to, position }",
    message: () => tmsg("msg.ui.input.dnd"),
    errors: ["NOT_EXPOSED", "AMBIGUOUS", "INVALID_PARAMS"],
    danger: "inject",
    examples: [
      'ui.input.dnd \'{"from":".../node/section/s2","to":".../node/section/s5","position":"after"}\'',
      'ui.input.dnd \'{"to":".../node/img/s2/hero","files":[{"name":"a.png","type":"image/png","base64":"…"}]}\'',
    ],
    handler: async (p) => {
      const toR = resolveExposed(p.to as string);
      if (!("el" in toR)) return toR;
      const toEl = toR.el;
      let fromEl: HTMLElement | null = null;
      if (p.from != null) {
        const fromR = resolveExposed(p.from as string);
        if (!("el" in fromR)) return fromR;
        fromEl = fromR.el;
      }
      const dt = new DataTransfer();
      if (Array.isArray(p.files)) {
        for (const f of p.files as Array<{ name?: unknown; type?: unknown; base64?: unknown }>) {
          const raw = atob(String(f.base64 ?? ""));
          const bytes = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
          dt.items.add(new File([bytes], String(f.name ?? "file"), { type: String(f.type ?? "") }));
        }
      }
      const frame = () => new Promise((r) => setTimeout(r, 50));
      const fire = (type: string, target: EventTarget, x: number, y: number) => {
        const ev = new DragEvent(type, {
          // composed — a plugin view is inside Shadow DOM. It must cross the boundary like a native drag
          // event for the document-level dragend listener (commit/revert decision) to receive it.
          clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true, view: window,
        });
        // WebKit can ignore dataTransfer from the constructor init — pin it on the instance.
        if (!ev.dataTransfer) Object.defineProperty(ev, "dataTransfer", { value: dt });
        target.dispatchEvent(ev);
      };
      const tr = toEl.getBoundingClientRect();
      const position = (p.position as string) ?? "center";
      const ty = position === "before" ? 0.2 : position === "after" ? 0.8 : 0.5;
      const toPt = { x: tr.left + tr.width / 2, y: tr.top + tr.height * ty };
      if (fromEl) {
        const fr = fromEl.getBoundingClientRect();
        fire("dragstart", fromEl, fr.left + fr.width / 2, fr.top + fr.height / 2);
        await frame(); // wait for the dragstart state to render (drop zones and the like)
      }
      fire("dragenter", toEl, toPt.x, toPt.y);
      fire("dragover", toEl, toPt.x, toPt.y);
      await frame();
      // Prevents dragend's failure verdict (dropEffect==="none") — WebKit ignores a setter outside a
      // drag session, so pin it as an own property (marks the drop as successful).
      try { Object.defineProperty(dt, "dropEffect", { value: "move", configurable: true }); } catch { dt.dropEffect = "move"; }
      fire("drop", toEl, toPt.x, toPt.y);
      await frame();
      fire("dragend", fromEl ?? toEl, toPt.x, toPt.y);
      return { dropped: true, from: p.from, to: p.to, position };
    },
  });

  register("ui.hit", {
    description: key("cmd.ui.hit.desc"),
    params: {
      x: { type: "number", description: key("cmd.ui.hit.param.x"), required: true },
      y: { type: "number", description: key("cmd.ui.hit.param.y"), required: true },
    },
    returns: "{ tag, className, dataset, owners, host, painters, rect } | { tag: null }",
    message: (d) => (d.tag ? tmsg("msg.ui.hit.found", { tag: String(d.tag) }) : tmsg("msg.ui.hit.none")),
    examples: ['ui.hit \'{"x":200,"y":140}\''],
    handler: (p) => {
      const el = deepElementFromPoint(Number(p.x), Number(p.y));
      if (!(el instanceof Element)) return { tag: null };
      const r = el.getBoundingClientRect();
      // An SVG className is an SVGAnimatedString — unified through getAttribute. Ancestor chain data is
      // useful too, so the nearest HTML ancestor holding [data-node]/[class] is reported alongside
      // through closest. The field name is dataset — data is a reserved envelope key and normalization
      // would swallow the payload (aligned with ui.measure).
      const host = el.closest<HTMLElement>("[data-node], button, a, [class]");
      // Paint diagnosis chain — names what paints over a hole (a transparent slot): from the ancestor
      // chain at the hit point, only elements whose background is not transparent are reported with
      // their background color (layer rule §NATIVE-SURFACES — the "the hole is closed" diagnosis is read
      // from this chain). Listing the whole chain is noise, so only painters are kept.
      const painters: { tag: string; className: string; bg: string; node?: string }[] = [];
      for (let n: Element | null = el; n instanceof Element; n = n.parentElement ?? ((n.getRootNode() as ShadowRoot).host ?? null)) {
        if (!(n instanceof HTMLElement)) continue;
        const cs = getComputedStyle(n);
        const bg = cs.backgroundColor;
        if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
          painters.push({
            tag: n.tagName.toLowerCase(),
            className: typeof n.className === "string" ? n.className.slice(0, 60) : "",
            bg,
            ...(n.dataset.node ? { node: n.dataset.node } : {}),
          });
        }
        if (painters.length >= 6) break;
      }
      return {
        tag: el.tagName.toLowerCase(),
        className: el.getAttribute("class") ?? "",
        dataset: el instanceof HTMLElement ? { ...el.dataset } : {},
        // The declared-owner chain at this point — from the top (deepest) down. The single input for
        // deciding layer order.
        owners: declaredOwnerChain(el),
        host: host
          ? { tag: host.tagName.toLowerCase(), className: host.className, dataset: { ...host.dataset } }
          : null,
        painters,
        rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
      };
    },
  });

}
