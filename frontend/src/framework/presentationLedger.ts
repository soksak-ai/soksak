// Display frame ledger — **which view was shown at which display epoch, in which rect.**
//
// This axis is not the framework's. The judgement has one question — "what was on screen at that
// moment" — and only the object that produces the answer differs per framework: on one framework the
// OS display callback (display link) delivers its layer frame, on another the document's own frame
// callback delivers the rect of a DOM child. **Both are events the compositor itself actually
// emitted** — neither is a timer nor a poll.
//
// So what stands in the core is one name and one shape. The name contains no framework, and the
// shape does not depend on which adapter filled it. With nothing installed this command **does not
// exist** — answering with an empty ledger makes the caller read 0 frames as "there was no
// display", which is claiming to have measured what was never measured.
import { moduleState } from "../lib/moduleState";
import { register } from "../commands/registry";
import {
  PRESENTATION_CLOCK,
  PRESENTATION_CLOCK_OWNER,
  presentationNowUnixMs,
} from "../lib/presentationClock";
import {
  auditPresentationReceipt,
  type PresentationLedgerAudit,
} from "./presentationLedgerAudit";

export interface PresentationRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The display ownership triple of one view — **the caller declares it and the adapter only compares.**
 *
 * If the adapter recovers the view from a label convention or a DOM path, that convention becomes
 * the contract, and the day it changes the ledger answers with the wrong owner's frame as that
 * view's.
 */
export interface PresentationOwner {
  /** Public view identity. */
  viewId: string;
  /** The entity that places this surface — a different identity from the surface itself. */
  hostId: string;
  /** The surface's own identity. */
  surfaceId: string;
}

/** Every owner a display ledger can be armed over right now — read before the caller declares a binding. */
export interface PresentationOwnerInventoryEntry extends PresentationOwner {
  window: string;
  /** Workspace placement pane. null when not attached to any pane yet. */
  logicalPaneId: string | null;
  /** Identity of the renderer that draws this view's chrome. */
  rendererId: string;
}

/** The facts of one surface read at one display epoch. */
export interface PresentationSurfaceFrame {
  viewId: string;
  surfaceId: string;
  /** Generation of this surface entity. Increments when the entity is replaced — the axis that
   *  distinguishes different objects under the same name. */
  generation: number;
  live: boolean;
  visible: boolean;
  painted: boolean;
  /** The rect the public slot declared. */
  domFrame: PresentationRect;
  /** The rect the surface was actually placed at. */
  surfaceFrame: PresentationRect;
}

/** One display event the compositor actually emitted. Interpolation, timers, and estimates cannot enter this list. */
export interface PresentationDisplayEvent {
  sequence: number;
  /** Observation generation that produced this ledger. It does not change within one trace. */
  sourceGeneration: number;
  presentationRevision: number;
  /** The epoch at which this frame was actually displayed. */
  displayTimestampUnixMs: number;
  /** The next display epoch — displayTimestamp + the display interval. */
  targetTimestampUnixMs: number;
  /** The epoch at which our callback observed that event. A different fact from the display epoch. */
  callbackObservedAtUnixMs: number;
  /** Display interval of this display. Unmeasurable, the ledger does not open — 0 is not an answer. */
  refreshIntervalMs: number;
  presentedAtUnixMs: number;
  surfaces: PresentationSurfaceFrame[];
}

/**
 * Violations the ledger counts itself. Display over that span is intact only when all are 0.
 *
 * - replacements: frames whose surface identity (surfaceId, generation) differs from the baseline
 * - disappearances: frames containing a surface that is not live or not visible
 * - unpresented: frames containing a surface that has painted nothing yet
 * - droppedEvents: display events not recorded in the ledger due to capacity or going backwards
 */
export interface PresentationViolations {
  replacements: number;
  disappearances: number;
  unpresented: number;
  droppedEvents: number;
}

/** Quality of the observation itself — not the display, but how much of it we missed. */
export interface PresentationObservation {
  callbackIntervalsSkipped: number;
  maxCallbackLatencyMs: number;
}

export interface PresentationTraceArmed {
  traceId: string;
  /**
   * Name of the clock that produced this ledger's `...UnixMs` stamps.
   *
   * The same suffix or the same clock name does not imply the same origin. To compare this
   * ledger's stamps with another producer's stamps on one axis, both clock and clockOwner must match.
   */
  clock: string;
  clockOwner: string;
  ownerViewIds: string[];
  armedAtUnixMs: number;
  baselineFrameSequence: number;
  sourceGeneration: number;
}

/** The next real display event of one trace. Producer identity and the core resolve ACK are different axes. */
export interface PresentationCheckpoint {
  traceId: string;
  trigger: PresentationCheckpointTrigger;
  frameSequence: number;
  sourceGeneration: number;
  presentationRevision: number;
  clock: string;
  clockOwner: string;
  presentedAtUnixMs: number;
}

export interface PresentationResolutionAcknowledgement {
  traceId: string;
  clock: string;
  owner: string;
  atUnixMs: number;
}

export interface ResolvedPresentationCheckpoint extends PresentationCheckpoint {
  resolutionAcknowledgement: PresentationResolutionAcknowledgement;
}

export type PresentationCheckpointTrigger = "next-display" | "next-surface-change";

export interface PresentationCheckpointBaselineSurface {
  viewId: string;
  surfaceId: string;
  generation: number;
  domFrame: PresentationRect;
  surfaceFrame: PresentationRect;
}

/** Consumption token for the display event prepare registered with the producer up front. */
export interface PresentationCheckpointRegistration {
  traceId: string;
  checkpointId: string;
  trigger: PresentationCheckpointTrigger;
  registeredAfterFrameSequence: number;
  registeredAfterPresentationRevision: number;
  sourceGeneration: number;
  baselineSurfaces: PresentationCheckpointBaselineSurface[];
}

export interface PresentationTraceReceipt {
  traceId: string;
  /** Name of the clock that produced this ledger's `...UnixMs` stamps. Same as `PresentationTraceArmed.clock`. */
  clock: string;
  clockOwner: string;
  closed: boolean;
  ownerViewIds: string[];
  armedAtUnixMs: number;
  baselineFrameSequence: number;
  presentationEvents: PresentationDisplayEvent[];
  violations: PresentationViolations;
  observation: PresentationObservation;
}

/**
 * The collected ledger plus **whether that ledger is consistent with its own events.**
 *
 * Only the producer has the violation counts. So if one adapter never counts an axis at all, that
 * axis answers 0 forever, and that 0 is indistinguishable from "it never happened". The audit
 * ignores which adapter answered and reads only the receipt itself — hence the audit is placed here.
 */
export interface PresentationTraceAuditedReceipt extends PresentationTraceReceipt {
  selfAudit: PresentationLedgerAudit;
}

export interface PresentationLedgerArmInput {
  traceId: string;
  owners: readonly PresentationOwner[];
  /** Finite capacity. Overflowing events are not discarded silently; they are counted in droppedEvents. */
  maxEvents?: number;
}

/**
 * The implementation a framework fills in. It exposes only owners, arm, the next real display
 * checkpoint, and ledger collection.
 *
 * arm completes **after the first real display event**. Returning immediately on arm lets the next
 * stimulus land before the first frame, which makes the baseline a post-stimulus frame.
 */
export interface PresentationLedgerHost {
  owners(): Promise<PresentationOwnerInventoryEntry[]>;
  arm(input: PresentationLedgerArmInput): Promise<PresentationTraceArmed>;
  prepareCheckpoint(input: {
    traceId: string;
    trigger: PresentationCheckpointTrigger;
  }): Promise<PresentationCheckpointRegistration>;
  readCheckpoint(input: {
    traceId: string;
    checkpointId: string;
  }): Promise<PresentationCheckpoint>;
  close(input: { traceId: string }): Promise<PresentationTraceReceipt>;
}

export const PRESENTATION_LEDGER_MIN_EVENTS = 2;
export const PRESENTATION_LEDGER_MAX_EVENTS = 4096;
export const PRESENTATION_LEDGER_DEFAULT_EVENTS = 256;

export function parsePresentationCheckpointTrigger(value: unknown): PresentationCheckpointTrigger {
  if (value === "next-display" || value === "next-surface-change") return value;
  throw new Error(tmsg("framework.presentation.badTrigger", { value: String(value) }));
}

const registered = moduleState("framework/presentationLedger#registered", () => ({
  host: null as PresentationLedgerHost | null,
  commandsInstalled: false,
  pendingCheckpointReads: new Map<string, {
    traceId: string;
    result: Promise<
      | { ok: true; checkpoint: ResolvedPresentationCheckpoint }
      | { ok: false; error: unknown }
    >;
  }>(),
}));

const MAX_PENDING_CHECKPOINT_READS = 64;
const checkpointReadKey = (traceId: string, checkpointId: string) =>
  `${traceId}\u0000${checkpointId}`;

function clearPendingCheckpointReads(traceId: string): void {
  for (const [key, pending] of registered.pendingCheckpointReads) {
    if (pending.traceId === traceId) registered.pendingCheckpointReads.delete(key);
  }
}

/**
 * Fixes the owner binding the caller declared into the contract shape.
 *
 * If two adapters each reject on their own, the same bad call dies for a different reason per
 * framework — rejection is by name, and that name comes from one place.
 */
export function parsePresentationOwners(value: unknown): PresentationOwner[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(tmsg("framework.presentation.ownersEmpty"));
  }
  const owners: PresentationOwner[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const owner = raw as Partial<PresentationOwner> | null;
    const viewId = typeof owner?.viewId === "string" ? owner.viewId.trim() : "";
    const hostId = typeof owner?.hostId === "string" ? owner.hostId.trim() : "";
    const surfaceId = typeof owner?.surfaceId === "string" ? owner.surfaceId.trim() : "";
    if (!viewId || !hostId || !surfaceId) {
      throw new Error(tmsg("framework.presentation.ownerIdentityEmpty"));
    }
    if (seen.has(viewId)) throw new Error(tmsg("framework.presentation.ownerViewIdDuplicate", { viewId }));
    seen.add(viewId);
    owners.push({ viewId, hostId, surfaceId });
  }
  return owners;
}

/** Finite capacity — out of range is rejected by name. Clamping silently shortens the ledger without warning. */
export function parsePresentationMaxEvents(value: unknown): number {
  if (value === undefined || value === null) return PRESENTATION_LEDGER_DEFAULT_EVENTS;
  const maxEvents = Number(value);
  if (!Number.isInteger(maxEvents)
      || maxEvents < PRESENTATION_LEDGER_MIN_EVENTS
      || maxEvents > PRESENTATION_LEDGER_MAX_EVENTS) {
    throw new Error(
      tmsg("framework.presentation.maxEventsRange", {
        min: PRESENTATION_LEDGER_MIN_EVENTS,
        max: PRESENTATION_LEDGER_MAX_EVENTS,
        value: String(value),
      }),
    );
  }
  return maxEvents;
}

function host(): PresentationLedgerHost {
  if (!registered.host) {
    throw new Error(
      tmsg("framework.presentation.hostMissing"),
    );
  }
  return registered.host;
}

function installCommands(): void {
  if (registered.commandsInstalled) return;
  registered.commandsInstalled = true;
  register("view.presentation.owners", {
    description:
      "List every view whose surface can carry a presentation trace right now, with its window, workspace pane, chrome renderer, placing host, and surface identity. Read this before arming a trace: the caller declares the owner binding, and no adapter recovers a view identity from a label convention or DOM path.",
    params: {},
    returns: "{ count, owners:[{viewId,window,logicalPaneId,rendererId,hostId,surfaceId}] }",
    message: (data) => tmsg("msg.view.presentation.owners", { n: String(data.count) }),
    handler: async () => {
      const owners = await host().owners();
      return { count: owners.length, owners };
    },
  });
  register("view.presentation.trace.arm", {
    description:
      "Arm one finite presentation trace over declared view surfaces and return only after the first real display event. Every recorded frame comes from the compositor's own display callback — never a timer, poll, or interpolation. The receipt names the clock its `...UnixMs` stamps came from; never compare them against another producer's stamps unless both name the same clock.",
    params: {
      traceId: { type: "string", description: "caller-owned finite trace identity", required: true },
      owners: {
        type: "json",
        description: "array of {viewId,hostId,surfaceId} owner bindings",
        required: true,
      },
      maxEvents: {
        type: "number",
        description: `finite event capacity (${PRESENTATION_LEDGER_MIN_EVENTS}..${PRESENTATION_LEDGER_MAX_EVENTS}, default ${PRESENTATION_LEDGER_DEFAULT_EVENTS})`,
      },
    },
    returns:
      "{ traceId,clock,ownerViewIds,armedAtUnixMs,baselineFrameSequence,sourceGeneration }",
    message: (data) => tmsg("msg.view.presentation.arm", { traceId: String(data.traceId) }),
    handler: async (params): Promise<PresentationTraceArmed> => {
      return host().arm({
        traceId: String(params.traceId ?? ""),
        owners: parsePresentationOwners(params.owners),
        maxEvents: parsePresentationMaxEvents(params.maxEvents),
      });
    },
  });
  register("view.presentation.trace.checkpoint.prepare", {
    description:
      "Register a one-shot for the next real display event before stimulus and return its producer-owned token immediately. The completed token has no elapsed-time lease; explicit read or trace close owns cleanup.",
    params: {
      traceId: { type: "string", description: "armed trace identity", required: true },
      trigger: {
        type: "string",
        description:
          "next-display, or next-surface-change which ignores unchanged callbacks and resolves on the first exact same-identity rect change",
        enum: ["next-display", "next-surface-change"],
        required: true,
      },
    },
    returns:
      "{ traceId,checkpointId,trigger,registeredAfterFrameSequence,registeredAfterPresentationRevision,sourceGeneration,baselineSurfaces }",
    message: (data) => tmsg("msg.view.presentation.checkpointPrepare", { traceId: String(data.traceId) }),
    handler: async (params): Promise<PresentationCheckpointRegistration> => {
      if (registered.pendingCheckpointReads.size >= MAX_PENDING_CHECKPOINT_READS) {
        throw new Error(tmsg("framework.presentation.checkpointReadCapacity", { max: MAX_PENDING_CHECKPOINT_READS }));
      }
      const implementation = host();
      const registration = await implementation.prepareCheckpoint({
        traceId: String(params.traceId ?? ""),
        trigger: parsePresentationCheckpointTrigger(params.trigger),
      });
      const key = checkpointReadKey(registration.traceId, registration.checkpointId);
      if (registered.pendingCheckpointReads.has(key)) {
        throw new Error(tmsg("framework.presentation.checkpointReadPrepared", { checkpointId: registration.checkpointId }));
      }
      // Producer read starts at registration, not when the harness later asks for the artifact.
      // The core acknowledgement is stamped in the resolution microtask, before unrelated command
      // scheduling can enter the measured latency.
      const result = implementation.readCheckpoint({
        traceId: registration.traceId,
        checkpointId: registration.checkpointId,
      }).then((checkpoint) => ({
        ok: true as const,
        checkpoint: {
          ...checkpoint,
          resolutionAcknowledgement: {
            traceId: checkpoint.traceId,
            clock: PRESENTATION_CLOCK,
            owner: PRESENTATION_CLOCK_OWNER,
            atUnixMs: presentationNowUnixMs(),
          },
        },
      }), (error: unknown) => ({ ok: false as const, error }));
      registered.pendingCheckpointReads.set(key, { traceId: registration.traceId, result });
      return registration;
    },
  });
  register("view.presentation.trace.checkpoint.read", {
    description:
      "Consume exactly one prepared next-display token. If its event has not arrived, wait with a finite observer deadline; timeout removes only this token and never closes the trace.",
    params: {
      traceId: { type: "string", description: "armed trace identity", required: true },
      checkpointId: { type: "string", description: "token returned by checkpoint.prepare", required: true },
    },
    returns:
      "{ traceId,trigger,frameSequence,sourceGeneration,presentationRevision,clock,clockOwner,presentedAtUnixMs,resolutionAcknowledgement:{traceId,clock,owner,atUnixMs} }",
    message: (data) => tmsg("msg.view.presentation.checkpointRead", { traceId: String(data.traceId) }),
    handler: async (params): Promise<ResolvedPresentationCheckpoint> => {
      const traceId = String(params.traceId ?? "");
      const checkpointId = String(params.checkpointId ?? "");
      const key = checkpointReadKey(traceId, checkpointId);
      const pending = registered.pendingCheckpointReads.get(key);
      if (!pending) throw new Error(tmsg("framework.presentation.checkpointReadMissing", { checkpointId }));
      registered.pendingCheckpointReads.delete(key);
      const result = await pending.result;
      if (!result.ok) throw result.error;
      return result.checkpoint;
    },
  });
  register("view.presentation.trace.close", {
    description:
      "Close one armed presentation trace, stop its display observation, and return the immutable display-event ledger with its own violation and observation counts.",
    params: {
      traceId: { type: "string", description: "trace identity returned by arm", required: true },
    },
    returns:
      "{ traceId,clock,closed,ownerViewIds,armedAtUnixMs,baselineFrameSequence,presentationEvents,violations,observation,selfAudit }",
    message: (data) => tmsg("msg.view.presentation.close", { traceId: String(data.traceId) }),
    handler: async (params): Promise<PresentationTraceAuditedReceipt> => {
      const traceId = String(params.traceId ?? "");
      let receipt: PresentationTraceReceipt;
      try {
        receipt = await host().close({ traceId });
      } finally {
        clearPendingCheckpointReads(traceId);
      }
      // No audit call, no audit. Put it in the receipt so the fact ships without a separate request.
      return { ...receipt, selfAudit: auditPresentationReceipt(receipt) };
    },
  });
}

/** A framework installs its own implementation. The command surface exists only from that moment. */
export function registerPresentationLedgerHost(implementation: PresentationLedgerHost): void {
  registered.pendingCheckpointReads.clear();
  registered.host = implementation;
  installCommands();
}

/** Whether one is installed — where the audit separates "absent" from "empty". */
export function hasPresentationLedgerHost(): boolean {
  return registered.host !== null;
}

export function __resetPresentationLedgerForTest(): void {
  registered.host = null;
  registered.commandsInstalled = false;
  registered.pendingCheckpointReads.clear();
}
