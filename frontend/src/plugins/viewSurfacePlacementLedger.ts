import { moduleState } from "../lib/moduleState";
import type { PluginViewSurfacePlacement } from "./viewPresentationHost";

type Identity = Readonly<{ viewId: string; containerGeneration: number }>;
type Failure = Readonly<{ code: string; message: string }>;

type Current = Identity & Readonly<{
  declarationSequence: number;
  stage: "declared" | "host-applied" | "presentation-prepared" | "batch-committed" | "failed";
  pane: string | null;
  placement: PluginViewSurfacePlacement;
  desiredVisible: boolean;
  labels: readonly string[];
  failure: Failure | null;
}>;

type Event = Omit<Current, "placement" | "stage"> & Readonly<{
  sequence: number;
  stage: Current["stage"] | "stale-failed" | "disposed";
  placement: PluginViewSurfacePlacement | null;
}>;

const MAX_EVENTS = 64;

/** Bounded public chain from the layout topology declaration to the authoritative native batch. */
export class PluginViewSurfacePlacementLedger {
  #sequence = 0;
  #current = new Map<string, Current>();
  #events: Event[] = [];

  declare(input: Identity & Readonly<{ placement: PluginViewSurfacePlacement }>) {
    const sequence = ++this.#sequence;
    const current: Current = {
      ...input,
      placement: structuredClone(input.placement),
      declarationSequence: sequence,
      stage: "declared",
      pane: null,
      desiredVisible: input.placement.desiredVisible,
      labels: [],
      failure: null,
    };
    this.#current.set(input.viewId, current);
    this.#record({ ...current, sequence });
    return { sequence };
  }

  hostApplied(input: Identity & Readonly<{
    declarationSequence: number;
    placement: PluginViewSurfacePlacement;
  }>): void {
    this.#requireStage(input, "declared");
    this.#advance(input, "host-applied", null, [], null);
  }

  presentationPrepared(input: Identity & Readonly<{
    declarationSequence: number;
    pane: string;
    placement: PluginViewSurfacePlacement;
  }>): void {
    this.#requireStage(input, "host-applied");
    this.#advance(input, "presentation-prepared", input.pane, [], null);
  }

  batchCommitted(input: Identity & Readonly<{
    declarationSequence: number;
    pane: string;
    desiredVisible: boolean;
    labels: readonly string[];
  }>): void {
    const current = this.#exact(input);
    if (current.stage !== "presentation-prepared"
        || current.desiredVisible !== input.desiredVisible || input.labels.length === 0) {
      throw new Error(`surface placement batch identity mismatch: ${input.viewId}`);
    }
    this.#advance({ ...input, placement: current.placement }, "batch-committed", input.pane,
      input.labels, null);
  }

  failed(input: Identity & Readonly<{
    declarationSequence: number;
    pane: string | null;
    placement: PluginViewSurfacePlacement;
    code: string;
    message: string;
  }>): void {
    const current = this.#current.get(input.viewId);
    if (!current || current.containerGeneration !== input.containerGeneration
        || current.declarationSequence !== input.declarationSequence) {
      const stale: Current = {
        ...input,
        placement: structuredClone(input.placement),
        stage: "failed",
        desiredVisible: input.placement.desiredVisible,
        labels: [],
        failure: { code: input.code, message: input.message },
      };
      this.#record({ ...stale, sequence: ++this.#sequence, stage: "stale-failed" });
      return;
    }
    this.#advance({ ...input, placement: current.placement }, "failed", input.pane, [], {
      code: input.code, message: input.message,
    });
  }

  dispose(input: Identity & Readonly<{ declarationSequence: number }>): void {
    const current = this.#current.get(input.viewId);
    if (!current || current.containerGeneration !== input.containerGeneration
        || current.declarationSequence !== input.declarationSequence) return;
    this.#current.delete(input.viewId);
    this.#record({ ...current, sequence: ++this.#sequence, stage: "disposed" });
  }

  status() {
    return {
      current: structuredClone([...this.#current.values()]),
      events: structuredClone(this.#events),
      maxEvents: MAX_EVENTS,
    };
  }

  #exact(input: Identity & Readonly<{ declarationSequence: number }>): Current {
    const current = this.#current.get(input.viewId);
    if (!current || current.containerGeneration !== input.containerGeneration
        || current.declarationSequence !== input.declarationSequence) {
      throw new Error(`surface placement declaration identity mismatch: ${input.viewId}`);
    }
    return current;
  }

  #requireStage(
    input: Identity & Readonly<{ declarationSequence: number }>,
    stage: Current["stage"],
  ): void {
    if (this.#exact(input).stage !== stage) {
      throw new Error(`surface placement stage mismatch: ${input.viewId} ${stage}`);
    }
  }

  #advance(
    input: Identity & Readonly<{
      declarationSequence: number;
      placement: PluginViewSurfacePlacement;
    }>,
    stage: Current["stage"],
    pane: string | null,
    labels: readonly string[],
    failure: Failure | null,
  ): void {
    const previous = this.#exact(input);
    const current: Current = {
      ...previous,
      placement: structuredClone(input.placement),
      stage,
      pane,
      desiredVisible: input.placement.desiredVisible,
      labels: [...labels],
      failure: failure ? { ...failure } : null,
    };
    this.#current.set(input.viewId, current);
    this.#record({ ...current, sequence: ++this.#sequence });
  }

  #record(event: Event): void {
    this.#events.push(structuredClone(event));
    if (this.#events.length > MAX_EVENTS) this.#events.splice(0, this.#events.length - MAX_EVENTS);
  }
}

export const pluginViewSurfacePlacementLedger = moduleState(
  "plugins/viewSurfacePlacementLedger#ledger",
  () => new PluginViewSurfacePlacementLedger(),
);
