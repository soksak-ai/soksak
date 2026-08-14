import { moduleState } from "./moduleState";
import type { Arrangement } from "./railArrangement";
import type { PreparedLayoutTransition } from "./layoutTransitionHost";

export interface LayoutTransitionIntent<L extends { id: string }> {
  ownerKey: string;
  revision: number;
  from: Arrangement<L>;
  to: Arrangement<L>;
}

export interface LayoutTransitionIntentHost<L extends { id: string }> {
  /** Called before the state publish. React render does not restart this preparation; it only claims it. */
  prepare(intent: LayoutTransitionIntent<L>, signal: AbortSignal): Promise<PreparedLayoutTransition>;
}

export class LayoutTransitionIntentSuperseded extends Error {
  constructor(ownerKey: string, revision: number) {
    super(`layout transition intent was superseded by a newer revision: ${ownerKey}/${revision}`);
    this.name = "LayoutTransitionIntentSuperseded";
  }
}

type AnyLeaf = { id: string };
type AnyIntent = LayoutTransitionIntent<AnyLeaf>;
type HostEntry = {
  generation: number;
  prepare: (intent: AnyIntent, signal: AbortSignal) => Promise<PreparedLayoutTransition>;
};
type Deferred = {
  promise: Promise<PreparedLayoutTransition>;
  resolve: (prepared: PreparedLayoutTransition) => void;
  reject: (error: unknown) => void;
};
type IntentEntry = {
  generation: number;
  revision: number;
  intent: AnyIntent;
  deferred: Deferred;
  claimed: boolean;
  started: boolean;
  prepared: boolean;
  superseded: boolean;
  abort: AbortController;
};
type OwnerQueue = {
  active: IntentEntry | null;
  queued: IntentEntry | null;
};
type IntentEventPhase =
  | "published"
  | "started"
  | "claimed"
  | "prepared"
  | "abort-requested"
  | "failed"
  | "finished"
  | "promoted";
type IntentEvent = {
  sequence: number;
  ownerKey: string;
  revision: number;
  generation: number;
  phase: IntentEventPhase;
  reason?: string;
  transactionId?: string;
  failure?: string;
};

export type LayoutTransitionIntentTerminal = {
  reason: string;
  transactionId?: string;
  failure?: string;
};

const MAX_EVENTS = 64;

const state = moduleState("lib/layoutTransitionIntent#state", () => ({
  nextGeneration: 1,
  hosts: new Map<string, HostEntry>(),
  queues: new Map<string, OwnerQueue>(),
  eventSequence: 0,
  events: [] as IntentEvent[],
}));

function record(
  ownerKey: string,
  entry: IntentEntry,
  phase: IntentEventPhase,
  terminal?: LayoutTransitionIntentTerminal,
): void {
  state.events.push({
    sequence: ++state.eventSequence,
    ownerKey,
    revision: entry.revision,
    generation: entry.generation,
    phase,
    ...(terminal?.reason ? { reason: terminal.reason } : {}),
    ...(terminal?.transactionId ? { transactionId: terminal.transactionId } : {}),
    ...(terminal?.failure ? { failure: terminal.failure } : {}),
  });
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
}

function deferred(): Deferred {
  let resolve!: Deferred["resolve"];
  let reject!: Deferred["reject"];
  const promise = new Promise<PreparedLayoutTransition>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function entryOf(host: HostEntry, intent: AnyIntent): IntentEntry {
  return {
    generation: host.generation,
    revision: intent.revision,
    intent,
    deferred: deferred(),
    claimed: false,
    started: false,
    prepared: false,
    superseded: false,
    abort: new AbortController(),
  };
}

function start(ownerKey: string, entry: IntentEntry): void {
  const host = state.hosts.get(ownerKey);
  if (!host || host.generation !== entry.generation) {
    entry.deferred.reject(new LayoutTransitionIntentSuperseded(ownerKey, entry.revision));
    return;
  }
  entry.started = true;
  record(ownerKey, entry, "started");
  let prepared: Promise<PreparedLayoutTransition>;
  try {
    prepared = host.prepare(entry.intent, entry.abort.signal);
  } catch (error) {
    prepared = Promise.reject(error);
  }
  void prepared.then(
    (value) => {
      entry.prepared = true;
      record(ownerKey, entry, "prepared");
      entry.deferred.resolve(value);
    },
    (error) => {
      record(ownerKey, entry, "failed");
      entry.deferred.reject(error);
    },
  );
}

function promote(ownerKey: string, queue: OwnerQueue): void {
  queue.active = queue.queued;
  queue.queued = null;
  if (!queue.active) {
    state.queues.delete(ownerKey);
    return;
  }
  record(ownerKey, queue.active, "promoted");
  start(ownerKey, queue.active);
}

function cancelWhenPrepared(entry: IntentEntry | null): void {
  if (!entry) return;
  void entry.deferred.promise.then(
    (prepared) => prepared.cancel(),
    () => {},
  );
}

function discardOwner(ownerKey: string, generation: number): void {
  const queue = state.queues.get(ownerKey);
  if (!queue) return;
  for (const entry of [queue.active, queue.queued]) {
    if (!entry || entry.generation !== generation) continue;
    entry.abort.abort(new LayoutTransitionIntentSuperseded(ownerKey, entry.revision));
    if (entry.started) cancelWhenPrepared(entry);
    else entry.deferred.reject(new LayoutTransitionIntentSuperseded(ownerKey, entry.revision));
  }
  state.queues.delete(ownerKey);
}

/** ProjectPlane registers the imperative pre-paint adapter owner of its own project. */
export function registerLayoutTransitionIntentHost<L extends { id: string }>(
  ownerKey: string,
  host: LayoutTransitionIntentHost<L>,
): () => void {
  if (!ownerKey) throw new Error("layout transition intent ownerKey is empty");
  const previous = state.hosts.get(ownerKey);
  if (previous) {
    state.hosts.delete(ownerKey);
    discardOwner(ownerKey, previous.generation);
  }
  const generation = state.nextGeneration++;
  state.hosts.set(ownerKey, {
    generation,
    prepare: host.prepare as HostEntry["prepare"],
  });
  return () => {
    if (state.hosts.get(ownerKey)?.generation !== generation) return;
    state.hosts.delete(ownerKey);
    discardOwner(ownerKey, generation);
  };
}

/**
 * Called by the store mutation owner before publishing a new project. With no active transaction, the
 * registered host's prepare starts on this call stack. With one active, only the latest intent starts after the terminal ACK.
 */
export function publishLayoutTransitionIntent<L extends { id: string }>(
  intent: LayoutTransitionIntent<L>,
): boolean {
  if (!intent.ownerKey || !Number.isInteger(intent.revision) || intent.revision <= 0) {
    throw new Error("layout transition intent identity is invalid");
  }
  const host = state.hosts.get(intent.ownerKey);
  if (!host) return false;
  const next = entryOf(host, intent as AnyIntent);
  record(intent.ownerKey, next, "published");
  let queue = state.queues.get(intent.ownerKey);
  if (!queue) {
    queue = { active: next, queued: null };
    state.queues.set(intent.ownerKey, queue);
    start(intent.ownerKey, next);
    return true;
  }
  if (queue.queued) {
    record(intent.ownerKey, queue.queued, "finished", { reason: "queued-superseded" });
    queue.queued.deferred.reject(
      new LayoutTransitionIntentSuperseded(intent.ownerKey, queue.queued.revision),
    );
  }
  queue.queued = next;
  if (queue.active && !queue.active.prepared && !queue.active.superseded) {
    queue.active.superseded = true;
    const activeRevision = queue.active.revision;
    record(intent.ownerKey, queue.active, "abort-requested");
    queue.active.abort.abort(new LayoutTransitionIntentSuperseded(intent.ownerKey, activeRevision));
    void queue.active.deferred.promise.then(
      (prepared) => prepared.cancel(),
      () => {},
    ).finally(() => {
      finishLayoutTransitionIntent(intent.ownerKey, activeRevision, { reason: "superseded-abort" });
    });
  }
  return true;
}

/** The React layout consumer takes the transaction of the same revision exactly once. */
export function claimLayoutTransitionIntent(
  ownerKey: string,
  revision: number,
): Promise<PreparedLayoutTransition> | null {
  const queue = state.queues.get(ownerKey);
  const host = state.hosts.get(ownerKey);
  if (!queue || !host) return null;
  const entry = [queue.active, queue.queued].find((candidate) => (
    candidate
    && candidate.generation === host.generation
    && candidate.revision === revision
    && !candidate.claimed
    && !candidate.superseded
  ));
  if (!entry) return null;
  entry.claimed = true;
  record(ownerKey, entry, "claimed");
  return entry.deferred.promise;
}

/** ACKs the exact active revision whose adapter commit/cancel and visual transition are closed. */
export function finishLayoutTransitionIntent(
  ownerKey: string,
  revision: number,
  terminal: LayoutTransitionIntentTerminal,
): boolean {
  const queue = state.queues.get(ownerKey);
  if (!queue?.active || queue.active.revision !== revision) return false;
  record(ownerKey, queue.active, "finished", terminal);
  queue.active = null;
  promote(ownerKey, queue);
  return true;
}

/** Bounded producer-owned intent queue ledger read by `ui.layout.status`. */
export function layoutTransitionIntentFacts() {
  const fact = (entry: IntentEntry | null) => entry ? {
    revision: entry.revision,
    generation: entry.generation,
    claimed: entry.claimed,
    started: entry.started,
    prepared: entry.prepared,
    superseded: entry.superseded,
    aborted: entry.abort.signal.aborted,
  } : null;
  return {
    owners: [...state.queues.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([ownerKey, queue]) => ({
        ownerKey,
        active: fact(queue.active),
        queued: fact(queue.queued),
      })),
    events: state.events.map((event) => ({ ...event })),
    maxEvents: MAX_EVENTS,
  };
}

export function __resetLayoutTransitionIntentForTest(): void {
  for (const [ownerKey, host] of state.hosts) discardOwner(ownerKey, host.generation);
  state.hosts.clear();
  state.queues.clear();
  state.nextGeneration = 1;
  state.eventSequence = 0;
  state.events = [];
}
