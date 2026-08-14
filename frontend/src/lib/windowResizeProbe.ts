// Window resize observation envelope — one axis is called by exactly one name.
//
// A resize is where two facts meet: the **request** (which size was ordered) and the
// **observation** (what it actually became). The two must never derive from the same value.
// Copy the requested size into the observation slot and the observation always succeeds and the
// judgement always passes. So the observer is **not given** the requested size (ResizeProbeRequest
// has no size). The core fills the request side from its own request, and the core measures window
// geometry directly from the neutral window surface (FrameworkWindowHandle).
//
// The remaining observation side — event generation, transaction generation, visible views, the
// frames of the three planes (slot/renderer/surface), presentation continuity — is measured from
// different objects per framework, so each adapter fills it. An adapter that breaks this contract
// does not pass silently; the envelope records the name of the violated slot.
import { currentWindow } from "../framework";
import { moduleState } from "./moduleState";

export interface PhysicalWindowSize {
  w: number;
  h: number;
}

/** Physical pixel rect. Logical (css-px) and physical (device-px) are different axes; never mix them. */
export interface ResizeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Intent of one adversarial resize step. The caller declares it and the observation compares
 * against it — derived back from observed geometry, the comparison is against itself and filters
 * nothing.
 */
export type ResizeTransactionPhase = "shrink" | "wide" | "tall" | "restore";

export const RESIZE_TRANSACTION_PHASES = [
  "shrink", "wide", "tall", "restore",
] as const satisfies readonly ResizeTransactionPhase[];

export type ResizeSequenceStep = PhysicalWindowSize & { phase?: ResizeTransactionPhase };

/** The request a finite resize transaction hands to the observation side. baseline is the slot where no size has been requested yet. */
export type ResizeObservationRequest =
  | { readonly kind: "baseline" }
  | {
      readonly kind: "step";
      readonly step: number;
      readonly size: PhysicalWindowSize;
      readonly phase?: ResizeTransactionPhase;
    };

/** What the observer receives. No requested size — the copy path itself does not exist. */
export type ResizeProbeRequest =
  | { readonly kind: "baseline" }
  | { readonly kind: "step"; readonly step: number };

export interface ResizeCompositionParticipant {
  /** Participant identity this plane exposes. If it changes during a transaction, that surface was replaced. */
  id: string;
  viewId: string;
  topologyPath: string;
  visible: boolean;
  logicalFrame: ResizeRect;
  physicalFrame: ResizeRect;
}

export interface ResizePresentation {
  viewId: string;
  surfaceId: string;
  surfaceGeneration: number;
  /** Number of frames this surface actually presented. It must grow each transaction to be continuous. */
  revision: number;
  live: boolean;
  visible: boolean;
  presented: boolean;
}

export interface ResizeContinuityCounters {
  replacements: number;
  gaps: number;
  disappearances: number;
  unpresented: number;
}

/** Geometry, generation, and continuity facts the adapter measures. windowGeometry is not here — the core measures it from the neutral window surface. */
export interface ResizeCompositionFacts {
  eventGeneration: number;
  transactionGeneration: number;
  visibleViewIds: string[];
  slots: ResizeCompositionParticipant[];
  renderers: ResizeCompositionParticipant[];
  surfaces: ResizeCompositionParticipant[];
  presentations: ResizePresentation[];
  eventGenerationBefore: number;
  eventGenerationAfter: number;
  continuity: {
    countersBefore: ResizeContinuityCounters;
    countersAfter: ResizeContinuityCounters;
  };
}

/**
 * The composition verdict the observation side produced **on its own** for this step.
 *
 * The core counts only three axes — who answered (kind), what the answer was (verdict), and why
 * (issues). The planes that back that verdict are measured from different objects per framework
 * (direct AppKit surface, PaneSurfaceHost, in-document guest), so if the core counted the list the
 * core would need each framework's objects encoded in it. So the adapter puts the planes into the
 * same record under its own name, and the core forwards them unchanged.
 *
 * An observation side that declares no verdict is not green. Unqueried and passed are not the same
 * fact, so an empty declaration is recorded as a violation under the `composition.*` slot name.
 */
export interface ResizeCompositionDeclaration {
  /** Name of the observation side that produced this verdict. This declaration, not a branch on
   *  framework name, determines which plane it is. */
  kind: string;
  verdict: "green" | "red";
  /** Reasons for red. A green declaration holding reasons contradicts itself. */
  issues: readonly string[];
}

/** The observation side the adapter answers with — measured facts and that adapter's composition verdict in one record. */
export interface ResizeCompositionObservation extends ResizeCompositionFacts {
  composition: ResizeCompositionDeclaration;
}

export interface ResizeObservationSnapshot {
  windowGeometry: ResizeRect;
  eventGeneration: number;
  transactionGeneration: number;
  visibleViewIds: string[];
  slots: ResizeCompositionParticipant[];
  renderers: ResizeCompositionParticipant[];
  surfaces: ResizeCompositionParticipant[];
  presentations: ResizePresentation[];
}

/**
 * The observation record of one step. The composition verdict from the observation side
 * (kind, verdict, issues) is stored **directly in this record** — wrap it in one more layer and the
 * reader must handle that layer, and if the layer name changes on only one side the verdict
 * silently becomes "no declaration".
 */
export interface ResizeObservation extends ResizeCompositionDeclaration {
  phase: ResizeTransactionPhase | null;
  requestedWindowGeometry: ResizeRect | null;
  eventGenerationBefore: number;
  eventGenerationAfter: number;
  transactionGeneration: number;
  continuity: ResizeCompositionFacts["continuity"];
  snapshot: ResizeObservationSnapshot;
  /** Only an empty array means "per contract". A violated slot is listed by its slot name. */
  contractViolations: string[];
}

type AssertNever<T extends never> = T;

export const RESIZE_SNAPSHOT_KEYS = [
  "windowGeometry",
  "eventGeneration",
  "transactionGeneration",
  "visibleViewIds",
  "slots",
  "renderers",
  "surfaces",
  "presentations",
] as const satisfies readonly (keyof ResizeObservationSnapshot)[];
export type _SnapshotKeysComplete = AssertNever<
  Exclude<keyof ResizeObservationSnapshot, (typeof RESIZE_SNAPSHOT_KEYS)[number]>
>;

export const RESIZE_PARTICIPANT_KEYS = [
  "id", "viewId", "topologyPath", "visible", "logicalFrame", "physicalFrame",
] as const satisfies readonly (keyof ResizeCompositionParticipant)[];
export type _ParticipantKeysComplete = AssertNever<
  Exclude<keyof ResizeCompositionParticipant, (typeof RESIZE_PARTICIPANT_KEYS)[number]>
>;

export const RESIZE_PRESENTATION_KEYS = [
  "viewId", "surfaceId", "surfaceGeneration", "revision", "live", "visible", "presented",
] as const satisfies readonly (keyof ResizePresentation)[];
export type _PresentationKeysComplete = AssertNever<
  Exclude<keyof ResizePresentation, (typeof RESIZE_PRESENTATION_KEYS)[number]>
>;

export const RESIZE_COUNTER_KEYS = [
  "replacements", "gaps", "disappearances", "unpresented",
] as const satisfies readonly (keyof ResizeContinuityCounters)[];
export type _CounterKeysComplete = AssertNever<
  Exclude<keyof ResizeContinuityCounters, (typeof RESIZE_COUNTER_KEYS)[number]>
>;

/**
 * The names the judging side reads the observation side's verdict under. These three names are the
 * only path between the core and the gate, so a change on one side silently turns the verdict red
 * as "no declaration" — hence the names are held as a constant.
 */
export const RESIZE_COMPOSITION_DECLARATION_KEYS = [
  "kind", "verdict", "issues",
] as const satisfies readonly (keyof ResizeCompositionDeclaration)[];
export type _DeclarationKeysComplete = AssertNever<
  Exclude<keyof ResizeCompositionDeclaration, (typeof RESIZE_COMPOSITION_DECLARATION_KEYS)[number]>
>;

export const RESIZE_OBSERVATION_KEYS = [
  "phase",
  "requestedWindowGeometry",
  "eventGenerationBefore",
  "eventGenerationAfter",
  "transactionGeneration",
  "continuity",
  "snapshot",
  "contractViolations",
  ...RESIZE_COMPOSITION_DECLARATION_KEYS,
] as const satisfies readonly (keyof ResizeObservation)[];
export type _ObservationKeysComplete = AssertNever<
  Exclude<keyof ResizeObservation, (typeof RESIZE_OBSERVATION_KEYS)[number]>
>;

const RESIZE_RECT_KEYS = ["x", "y", "w", "h"] as const satisfies readonly (keyof ResizeRect)[];

/**
 * The topology address the three planes of one view share. If the three planes name different
 * addresses they were never the three planes of the same view — so this derivation is not
 * rewritten per framework.
 */
export function resizeTopologyPath(windowLabel: string, viewId: string): string {
  return `window/${encodeURIComponent(windowLabel)}/view/${encodeURIComponent(viewId)}`;
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function checkRect(value: unknown, path: string, violations: string[], integer = false): void {
  if (!isRecord(value)) {
    violations.push(`${path}=rect/${displayValue(value)}`);
    return;
  }
  for (const key of RESIZE_RECT_KEYS) {
    const number = value[key];
    const positive = key === "w" || key === "h";
    if (typeof number !== "number"
      || !Number.isFinite(number)
      || (integer && !Number.isInteger(number))
      || (positive && number <= 0)) {
      violations.push(
        `${path}.${key}=${integer ? "integer" : "finite"}${positive ? ">0" : ""}`
          + `/${displayValue(number)}`,
      );
    }
  }
}

function checkGeneration(value: unknown, path: string, violations: string[]): boolean {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    violations.push(`${path}=integer>=0/${displayValue(value)}`);
    return false;
  }
  return true;
}

function checkParticipants(value: unknown, path: string, violations: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    violations.push(`${path}=non-empty-array/${displayValue(value)}`);
    return;
  }
  const ids = new Set<unknown>();
  const viewIds = new Set<unknown>();
  value.forEach((participant, index) => {
    const at = `${path}[${index}]`;
    if (!isRecord(participant)) {
      violations.push(`${at}=record/${displayValue(participant)}`);
      return;
    }
    const extra = Object.keys(participant)
      .filter((key) => !(RESIZE_PARTICIPANT_KEYS as readonly string[]).includes(key));
    if (extra.length > 0) violations.push(`${at}=exact-keys/${displayValue(extra)}`);
    if (typeof participant.id !== "string" || participant.id.length === 0 || ids.has(participant.id)) {
      violations.push(`${at}.id=unique-non-empty/${displayValue(participant.id)}`);
    } else ids.add(participant.id);
    if (typeof participant.viewId !== "string"
      || participant.viewId.length === 0
      || viewIds.has(participant.viewId)) {
      violations.push(`${at}.viewId=unique-non-empty/${displayValue(participant.viewId)}`);
    } else viewIds.add(participant.viewId);
    if (typeof participant.topologyPath !== "string" || participant.topologyPath.length === 0) {
      violations.push(`${at}.topologyPath=non-empty/${displayValue(participant.topologyPath)}`);
    }
    if (participant.visible !== true) {
      violations.push(`${at}.visible=true/${displayValue(participant.visible)}`);
    }
    checkRect(participant.logicalFrame, `${at}.logicalFrame`, violations);
    checkRect(participant.physicalFrame, `${at}.physicalFrame`, violations, true);
  });
}

function checkPresentations(value: unknown, path: string, violations: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    violations.push(`${path}=non-empty-array/${displayValue(value)}`);
    return;
  }
  const viewIds = new Set<unknown>();
  value.forEach((presentation, index) => {
    const at = `${path}[${index}]`;
    if (!isRecord(presentation)) {
      violations.push(`${at}=record/${displayValue(presentation)}`);
      return;
    }
    const extra = Object.keys(presentation)
      .filter((key) => !(RESIZE_PRESENTATION_KEYS as readonly string[]).includes(key));
    if (extra.length > 0) violations.push(`${at}=exact-keys/${displayValue(extra)}`);
    if (typeof presentation.viewId !== "string"
      || presentation.viewId.length === 0
      || viewIds.has(presentation.viewId)) {
      violations.push(`${at}.viewId=unique-non-empty/${displayValue(presentation.viewId)}`);
    } else viewIds.add(presentation.viewId);
    if (typeof presentation.surfaceId !== "string" || presentation.surfaceId.length === 0) {
      violations.push(`${at}.surfaceId=non-empty/${displayValue(presentation.surfaceId)}`);
    }
    for (const key of ["surfaceGeneration", "revision"] as const) {
      const number = presentation[key];
      if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
        violations.push(`${at}.${key}=integer>=1/${displayValue(number)}`);
      }
    }
    for (const key of ["live", "visible", "presented"] as const) {
      if (presentation[key] !== true) {
        violations.push(`${at}.${key}=true/${displayValue(presentation[key])}`);
      }
    }
  });
}

function checkCounters(value: unknown, path: string, violations: string[]): void {
  if (!isRecord(value)) {
    violations.push(`${path}=record/${displayValue(value)}`);
    return;
  }
  for (const key of RESIZE_COUNTER_KEYS) {
    const number = value[key];
    if (typeof number !== "number" || !Number.isInteger(number) || number < 0) {
      violations.push(`${path}.${key}=integer>=0/${displayValue(number)}`);
    }
  }
}

/**
 * Compares the observation side's composition verdict against the contract. The **content** of the
 * verdict is not recomputed here — the adapter measured those facts, and if the core built the same
 * verdict again one of the two would be a lie. The core checks only that the declaration is
 * well-formed: is there a name, is the verdict one of the two values, are the reasons an array of
 * names, and does green hold no reasons.
 */
function checkComposition(value: unknown, path: string, violations: string[]): void {
  if (!isRecord(value)) {
    violations.push(`${path}=record/${displayValue(value)}`);
    return;
  }
  if (typeof value.kind !== "string" || value.kind.trim().length === 0) {
    violations.push(`${path}.kind=non-empty/${displayValue(value.kind)}`);
  }
  if (value.verdict !== "green" && value.verdict !== "red") {
    violations.push(`${path}.verdict=green|red/${displayValue(value.verdict)}`);
  }
  const issues = value.issues;
  if (!Array.isArray(issues)
    || issues.some((issue) => typeof issue !== "string" || issue.trim().length === 0)) {
    violations.push(`${path}.issues=non-empty-strings/${displayValue(issues)}`);
    return;
  }
  // A declaration that answers green while holding reasons contradicts itself. Passing that
  // contradiction lets an adapter record violations and still declare a pass.
  if (value.verdict === "green" && issues.length > 0) {
    violations.push(`${path}.issues=0/${displayValue(issues)}`);
  }
}

/**
 * Compares the observation side the adapter answered with against the contract. The return value is
 * **the names of the violated slots**, and only an empty array means the contract was kept. When
 * the same axis is called by a different name (transaction vs generation), the fact that the axis
 * is empty is reported under the axis name.
 */
export function resizeCompositionViolations(
  value: unknown,
  { transaction = true }: { transaction?: boolean } = {},
): string[] {
  const violations: string[] = [];
  if (!isRecord(value)) {
    violations.push(`observation=record/${displayValue(value)}`);
    return violations;
  }
  checkGeneration(value.eventGeneration, "eventGeneration", violations);
  checkGeneration(value.transactionGeneration, "transactionGeneration", violations);
  const beforeValid = checkGeneration(
    value.eventGenerationBefore,
    "eventGenerationBefore",
    violations,
  );
  const afterValid = checkGeneration(
    value.eventGenerationAfter,
    "eventGenerationAfter",
    violations,
  );
  // A step that observed a transaction must have had at least one window event pass through.
  // baseline is the slot where no transaction had happened yet, so staying at the same generation
  // is the fact there — judging both by one standard makes one of the two a lie.
  if (beforeValid && afterValid) {
    const before = value.eventGenerationBefore as number;
    const after = value.eventGenerationAfter as number;
    if (transaction ? !(after > before) : after < before) {
      violations.push(
        `eventGenerationAfter=${transaction ? ">" : ">="}eventGenerationBefore`
          + `/${displayValue(before)}/${displayValue(after)}`,
      );
    }
  }
  const visibleViewIds = value.visibleViewIds;
  if (!Array.isArray(visibleViewIds)
    || visibleViewIds.length === 0
    || visibleViewIds.some((viewId) => typeof viewId !== "string" || viewId.length === 0)
    || new Set(visibleViewIds).size !== visibleViewIds.length) {
    violations.push(`visibleViewIds=unique-non-empty-strings/${displayValue(visibleViewIds)}`);
  }
  checkParticipants(value.slots, "slots", violations);
  checkParticipants(value.renderers, "renderers", violations);
  checkParticipants(value.surfaces, "surfaces", violations);
  checkPresentations(value.presentations, "presentations", violations);
  if (!isRecord(value.continuity)) {
    violations.push(`continuity=record/${displayValue(value.continuity)}`);
  } else {
    checkCounters(value.continuity.countersBefore, "continuity.countersBefore", violations);
    checkCounters(value.continuity.countersAfter, "continuity.countersAfter", violations);
  }
  checkComposition(value.composition, "composition", violations);
  return violations;
}

/**
 * Joins the request side (core) and the observation side (adapter) into one envelope.
 *
 * requestedWindowGeometry is the requested size placed on the **observed window origin**, and
 * snapshot.windowGeometry is measured independently of that request. If they differ, that
 * difference is the result — fill one from the other here and resize succeeds forever.
 */
export function composeResizeObservation({
  request,
  windowGeometry,
  observed,
}: {
  request: ResizeObservationRequest;
  windowGeometry: ResizeRect;
  observed: ResizeCompositionObservation;
}): ResizeObservation {
  const violations = resizeCompositionViolations(observed, { transaction: request.kind === "step" });
  checkRect(windowGeometry, "snapshot.windowGeometry", violations);
  if (request.kind === "step" && request.phase !== undefined
    && !(RESIZE_TRANSACTION_PHASES as readonly string[]).includes(request.phase)) {
    violations.push(`phase=known/${displayValue(request.phase)}`);
  }
  const source = observed as Partial<ResizeCompositionObservation>;
  // Spread the declaration first, then place the core's request side on top. If the adapter emitted
  // none, this slot stays empty, and that emptiness is reported both by the violation just recorded
  // by name and by the judging side's "no declaration" — an empty slot is never filled with green.
  const declaration = source.composition;
  return {
    ...(isRecord(declaration) ? declaration : {}),
    phase: request.kind === "step" ? request.phase ?? null : null,
    requestedWindowGeometry: request.kind === "step"
      ? { x: windowGeometry.x, y: windowGeometry.y, w: request.size.w, h: request.size.h }
      : null,
    eventGenerationBefore: source.eventGenerationBefore as number,
    eventGenerationAfter: source.eventGenerationAfter as number,
    transactionGeneration: source.transactionGeneration as number,
    continuity: source.continuity as ResizeCompositionObservation["continuity"],
    snapshot: {
      windowGeometry,
      eventGeneration: source.eventGeneration as number,
      transactionGeneration: source.transactionGeneration as number,
      visibleViewIds: source.visibleViewIds as string[],
      slots: source.slots as ResizeCompositionParticipant[],
      renderers: source.renderers as ResizeCompositionParticipant[],
      surfaces: source.surfaces as ResizeCompositionParticipant[],
      presentations: source.presentations as ResizePresentation[],
    },
    contractViolations: violations,
  } as ResizeObservation;
}

export type WindowResizeProbe = (
  request: ResizeProbeRequest,
) => Promise<ResizeCompositionObservation> | ResizeCompositionObservation;

const state = moduleState("lib/windowResizeProbe", () => ({ probe: null as WindowResizeProbe | null }));

/** Connects the numeric facts the active framework must expose right after a window resize. */
export function registerWindowResizeProbe(probe: WindowResizeProbe | null): void {
  state.probe = probe;
}

/** Physical window geometry — queried from the neutral window surface, not by framework name. */
async function observedWindowGeometry(): Promise<ResizeRect> {
  const win = currentWindow();
  const [position, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
  return { x: position.x, y: position.y, w: size.width, h: size.height };
}

/** A framework with no probe answers that it did not observe — no empty facts are invented. */
export async function sampleWindowResizeProbe(
  request: ResizeObservationRequest,
): Promise<ResizeObservation | null> {
  const probe = state.probe;
  if (!probe) return null;
  const observed = await probe(
    request.kind === "step" ? { kind: "step", step: request.step } : { kind: "baseline" },
  );
  return composeResizeObservation({
    request,
    windowGeometry: await observedWindowGeometry(),
    observed,
  });
}
