import { moduleState } from "./moduleState";
import type { LayoutPresentationStart } from "./layoutPresentationCoordinator";
import { validateLayoutPresentationStart } from "./layoutPresentationCoordinator";
import type {
  LayoutMove,
  LayoutChange,
  LayoutPanePresentationTarget,
  LayoutProjectionCommitReceipt,
  LayoutProjectionFailureReceipt,
  LayoutPreparationReceipt,
  LayoutTransitionMode,
  PreparedLayoutTransition,
} from "./layoutTransitionHost";
import { LayoutProjectionCommitFailure } from "./layoutTransitionHost";
import {
  LayoutPresentationCandidateFailure,
  type LayoutPresentationCandidateAttempt,
  type LayoutPresentationCandidateTerminalStatus,
} from "./layoutPresentationCandidateCoordinator";
import { PRESENTATION_CLOCK, presentationNowUnixMs } from "./presentationClock";

export type LayoutPresentationFailureReceipt = Readonly<{
  transactionId: string;
  terminalStatus: LayoutPresentationCandidateTerminalStatus;
  candidateAttempts: readonly LayoutPresentationCandidateAttempt[];
}>;

type LayoutTransitionJournalEntryBase = {
  transactionId: string;
  /**
   * Name of the clock that produced this transaction's `...UnixMs` timestamps.
   *
   * The window this transaction declares is the reference for judging samples in the presentation
   * ledger. The same suffix does not imply the same clock, so two timestamps compare on one axis
   * only when the window and the observation report the same name.
   */
  clock: string;
  /** Observation transaction id declared by the stimulus that opened this transaction. Absent when
   *  no stimulus declared one. */
  causeTraceId?: string;
  sequence: number;
  /**
   * The frame a recording was on when this record opened, or absent when nothing was recording.
   *
   * `window.record` numbers the files it writes and that number is the clock every journal is meant
   * to share, so a record can be lined up with the picture of the moment it describes. Until this
   * carried it the numbers and the pictures stood side by side with nothing joining them.
   *
   * Absent, not zero: no recording is a different fact from the first frame of one.
   */
  recordingFrame?: number;
  phase: "preparing" | "prepared" | "committed" | "cancelled" | "failed";
  openedAtUnixMs: number;
  preparedAtUnixMs?: number;
  preparation?: LayoutPreparationReceipt;
  domCommittedAtUnixMs?: number;
  /**
   * When this transaction stopped waiting on any stage/start/commit ACK. The presentation epoch a
   * producer reported can be later than this. Reserving that future epoch for every participant is
   * the transaction's result.
   */
  closedAtUnixMs?: number;
  failure?: string;
  stagedTargetsStatus: "pending" | "declared";
  stagedTargets: string[] | null;
  presentationFailure?: LayoutPresentationFailureReceipt;
  projectionFailure?: LayoutProjectionFailureReceipt;
  moves: LayoutMove[];
  panePresentationTargets: LayoutPanePresentationTarget[];
  paneSettlementParticipants: LayoutPanePresentationTarget[];
  settlement: null | {
    ownerKey: string;
    revision: number;
    status: "pending" | "settled" | "failed" | "cancelled";
  };
};

/** Public discriminated union: presentation evidence owned by one mode is not read as another
 *  mode's gap. */
export type LayoutTransitionJournalEntry = LayoutTransitionJournalEntryBase & (
  | { mode: null; presentationStart?: never; projectionCommit?: never }
  | { mode: "glide"; presentationStart?: LayoutPresentationStart; projectionCommit?: never }
  | { mode: "snap"; presentationStart?: never; projectionCommit?: LayoutProjectionCommitReceipt }
);

type MutableLayoutTransitionJournalEntry = LayoutTransitionJournalEntryBase & {
  mode: LayoutTransitionMode | null;
  presentationStart?: LayoutPresentationStart;
  projectionCommit?: LayoutProjectionCommitReceipt;
};

export type LayoutTransitionJournalEvent =
  | Readonly<{
    type: "preparing";
    transactionId: string;
    sequence: number;
    causeTraceId?: string;
  }>
  | Readonly<{
    type: "prepared";
    transactionId: string;
    sequence: number;
    mode: LayoutTransitionMode;
    causeTraceId?: string;
  }>
  | Readonly<{
    type: "dom-committed";
    transactionId: string;
    sequence: number;
    domCommittedAtUnixMs: number;
  }>
  | Readonly<{
    type: "terminal";
    transactionId: string;
    sequence: number;
    phase: "committed" | "cancelled" | "failed";
    closedAtUnixMs: number;
  }>;

export type LayoutTransactionWaitReceipt = Readonly<{
  causeStatus: "exact";
  entry: LayoutTransitionJournalEntry;
}>;

const journal = moduleState("lib/layoutTransitionJournal", () => ({
  sequence: 0,
  entries: [] as MutableLayoutTransitionJournalEntry[],
  /** Cause for the next single transaction. The stimulus declares it, the transaction consumes it. */
  pendingCauseTraceId: null as string | null,
}));
const journalListeners = moduleState(
  "lib/layoutTransitionJournal#listeners",
  () => new Set<(event: LayoutTransitionJournalEvent) => void>(),
);
const transactionWaiters = moduleState(
  "lib/layoutTransitionJournal#waiters",
  () => new Set<() => void>(),
);
const MAX_LAYOUT_TRANSACTION_WAITERS = 16;
const MAX_LAYOUT_TRANSACTION_WAIT_TIMEOUT_MS = 30_000;
const MAX_ACTIVE_LAYOUT_TRANSACTIONS = 16;
const MAX_TERMINAL_LAYOUT_TRANSACTION_HISTORY = 64;

function validateProjectionCommit(
  raw: void | LayoutProjectionCommitReceipt,
  transactionId: string,
  stagedTargets: readonly string[],
): LayoutProjectionCommitReceipt {
  if (!raw || raw.transactionId !== transactionId || raw.producer !== "layout-adapter") {
    throw new Error(`layout projection commit identity is invalid: ${transactionId}`);
  }
  if (!Array.isArray(raw.targets) || raw.targets.length !== stagedTargets.length) {
    throw new Error(`layout projection commit targets are incomplete: ${transactionId}`);
  }
  const declared = new Set(stagedTargets);
  const observed = new Set<string>();
  const owners = new Set(["pane-bounds", "direct-bounds", "external-surface"]);
  for (const target of raw.targets) {
    if (!declared.has(target.stagedTarget) || observed.has(target.stagedTarget)) {
      throw new Error(`layout projection commit target identity is invalid: ${transactionId}`);
    }
    observed.add(target.stagedTarget);
    if (!owners.has(target.owner)) {
      throw new Error(`layout projection commit owner is invalid: ${target.stagedTarget}`);
    }
    if (![target.frame.x, target.frame.y, target.frame.w, target.frame.h].every(Number.isFinite)
        || target.frame.w < 0 || target.frame.h < 0) {
      throw new Error(`layout projection commit frame is invalid: ${target.stagedTarget}`);
    }
    if (target.sourceGeneration !== undefined
        && (!Number.isSafeInteger(target.sourceGeneration) || target.sourceGeneration <= 0)) {
      throw new Error(`layout projection commit generation is invalid: ${target.stagedTarget}`);
    }
  }
  return structuredClone(raw);
}

/** Public layout transaction event subscription. Use it for a finite observation that always calls
 *  the returned listener-removal function. */
export function onLayoutTransitionJournal(
  listener: (event: LayoutTransitionJournalEvent) => void,
): () => void {
  journalListeners.add(listener);
  return () => journalListeners.delete(listener);
}

function publishLayoutTransitionJournal(event: LayoutTransitionJournalEvent): void {
  for (const listener of [...journalListeners]) {
    try {
      listener(event);
    } catch (error) {
      // A listener that breaks the layout transaction couples core to the verifier. A failed
      // observation turns RED as a missing sample, and the actual DOM/surface commit proceeds per
      // its own contract.
      console.error("[layout] transaction event observer failed", error);
    }
  }
}

const isTerminalPhase = (
  phase: MutableLayoutTransitionJournalEntry["phase"],
): phase is "committed" | "cancelled" | "failed" => (
  phase === "committed" || phase === "cancelled" || phase === "failed"
);

function trimTerminalHistory(): void {
  let terminalCount = journal.entries.filter((entry) => isTerminalPhase(entry.phase)).length;
  if (terminalCount <= MAX_TERMINAL_LAYOUT_TRANSACTION_HISTORY) return;
  for (let index = 0; index < journal.entries.length
      && terminalCount > MAX_TERMINAL_LAYOUT_TRANSACTION_HISTORY;) {
    if (isTerminalPhase(journal.entries[index]!.phase)) {
      journal.entries.splice(index, 1);
      terminalCount -= 1;
    } else {
      index += 1;
    }
  }
}

function publishTerminalEntry(
  entry: MutableLayoutTransitionJournalEntry & {
    phase: "committed" | "cancelled" | "failed";
    closedAtUnixMs: number;
  },
): void {
  publishLayoutTransitionJournal(Object.freeze({
    type: "terminal",
    transactionId: entry.transactionId,
    sequence: entry.sequence,
    phase: entry.phase,
    closedAtUnixMs: entry.closedAtUnixMs,
  }));
  trimTerminalHistory();
}

/**
 * Waits for the terminal ACK of the exact layout transaction one stimulus opened.
 *
 * The listener is installed first and the journal snapshot is read in the same synchronous
 * boundary, so a transaction closed in between is not lost. The watch owns one event subscription
 * and one finite timeout, and never polls the journal.
 */
export function waitForLayoutTransaction(input: {
  causeTraceId: string;
  afterSequence: number;
  timeoutMs: number;
}): Promise<LayoutTransactionWaitReceipt> {
  if (typeof input?.causeTraceId !== "string") {
    return Promise.reject(new Error("layout transaction causeTraceId must be a string"));
  }
  const causeTraceId = input.causeTraceId.trim();
  if (!causeTraceId) return Promise.reject(new Error("layout transaction causeTraceId is required"));
  if (!Number.isInteger(input.afterSequence) || input.afterSequence < 0) {
    return Promise.reject(new Error("layout transaction afterSequence must be a non-negative integer"));
  }
  if (!Number.isFinite(input.timeoutMs)
      || input.timeoutMs <= 0
      || input.timeoutMs > MAX_LAYOUT_TRANSACTION_WAIT_TIMEOUT_MS) {
    return Promise.reject(new Error(
      `layout transaction timeoutMs must be within 1..${MAX_LAYOUT_TRANSACTION_WAIT_TIMEOUT_MS}`,
    ));
  }
  if (transactionWaiters.size >= MAX_LAYOUT_TRANSACTION_WAITERS) {
    return Promise.reject(new Error(`layout transaction waiter capacity exceeded: ${MAX_LAYOUT_TRANSACTION_WAITERS}`));
  }

  return new Promise<LayoutTransactionWaitReceipt>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe = () => {};
    const release = () => {
      if (settled) return;
      settled = true;
      unsubscribe();
      if (timeout !== null) clearTimeout(timeout);
      transactionWaiters.delete(release);
    };
    const finish = (
      outcome: { receipt: LayoutTransactionWaitReceipt } | { error: Error },
    ) => {
      if (settled) return;
      release();
      if ("receipt" in outcome) resolve(outcome.receipt);
      else reject(outcome.error);
    };
    const evaluate = () => {
      const matches = journal.entries.filter((entry) => (
        entry.sequence > input.afterSequence && entry.causeTraceId === causeTraceId
      ));
      if (matches.length > 1) {
        finish({ error: new Error(`layout transaction ambiguous for cause ${causeTraceId}: ${matches.length}`) });
        return;
      }
      const entry = matches[0];
      if (!entry || !isTerminalPhase(entry.phase)) return;
      finish({
        receipt: {
          causeStatus: "exact",
          entry: structuredClone(entry) as LayoutTransitionJournalEntry,
        },
      });
    };

    unsubscribe = onLayoutTransitionJournal(evaluate);
    transactionWaiters.add(release);
    timeout = setTimeout(() => {
      finish({ error: new Error(`layout transaction timeout for cause ${causeTraceId}`) });
    }, input.timeoutMs);
    evaluate();
  });
}

/**
 * Declares the cause for the next single layout transaction.
 *
 * Slicing the journal by a sequence window assumes "no other transaction happened in between". An
 * assumption is not a receipt, so the stimulus records its own observation transaction id and the
 * single transaction it opens takes it. It is cleared on consumption, so it does not leak into a
 * later transaction opened by someone else.
 */
/**
 * The frame the recording in this window is on, or null when nothing is recording.
 *
 * One value for the window rather than a parameter threaded through every caller: a journal record
 * is opened deep inside a state write, and the command that starts a recording has none of that in
 * scope. The recorder announces each frame after its file is on disk (`onFrame`), and this is where
 * that announcement is kept.
 */
let recordingFrameNow: number | null = null;

/** What the recorder announced last, for a record opened now. */
export function recordingFrame(): number | null {
  return recordingFrameNow;
}

/** Called by a recording as each frame lands, and with null when it ends. */
export function noteRecordingFrame(frame: number | null): void {
  recordingFrameNow = frame;
}

export function declareLayoutCause(traceId: string): void {
  journal.pendingCauseTraceId = traceId;
}

/** Layout transaction facts shared by core and frameworks. A finite journal: 64 terminal, 16 active. */
export function layoutTransitionJournal(): LayoutTransitionJournalEntry[] {
  return structuredClone(journal.entries) as LayoutTransitionJournalEntry[];
}

function validatedSettlementIdentity(receipt: { ownerKey: string; revision: number }): void {
  if (typeof receipt.ownerKey !== "string" || !receipt.ownerKey.trim()) {
    throw new Error("layout transaction settlement ownerKey is required");
  }
  if (!Number.isSafeInteger(receipt.revision) || receipt.revision <= 0) {
    throw new Error(`layout transaction settlement revision is invalid: ${receipt.revision}`);
  }
}

/** Bind a store-owned settlement revision to the exact prepared transaction that consumes it. */
export function bindLayoutTransactionSettlement(
  transactionId: string,
  receipt: { ownerKey: string; revision: number },
): void {
  validatedSettlementIdentity(receipt);
  const entry = journal.entries.find((candidate) => candidate.transactionId === transactionId);
  if (!entry || entry.phase !== "prepared" || entry.settlement) {
    throw new Error(`layout transaction settlement bind is invalid: ${transactionId}`);
  }
  entry.settlement = { ...receipt, ownerKey: receipt.ownerKey.trim(), status: "pending" };
}

/** Test/injection seams can supply an unjournaled prepared transaction; product wrappers cannot. */
export function bindLayoutTransactionSettlementIfPresent(
  transactionId: string,
  receipt: { ownerKey: string; revision: number },
): boolean {
  if (!journal.entries.some((candidate) => candidate.transactionId === transactionId)) return false;
  bindLayoutTransactionSettlement(transactionId, receipt);
  return true;
}

export function finishLayoutTransactionSettlement(
  transactionId: string,
  receipt: {
    ownerKey: string;
    revision: number;
    status: "settled" | "failed" | "cancelled";
  },
): void {
  validatedSettlementIdentity(receipt);
  const entry = journal.entries.find((candidate) => candidate.transactionId === transactionId);
  const current = entry?.settlement;
  if (!entry || !current
    || current.ownerKey !== receipt.ownerKey.trim()
    || current.revision !== receipt.revision
    || current.status !== "pending") {
    throw new Error(`layout transaction settlement terminal identity is invalid: ${transactionId}`);
  }
  current.status = receipt.status;
}

export function journalPreparingLayoutTransition(
  change: LayoutChange,
  identity: { transactionId: string },
): {
  bind(prepared: PreparedLayoutTransition): PreparedLayoutTransition;
  fail(error: unknown): void;
} {
  const sequence = ++journal.sequence;
  const causeTraceId = journal.pendingCauseTraceId;
  journal.pendingCauseTraceId = null;
  const entry: MutableLayoutTransitionJournalEntry = {
    transactionId: identity.transactionId,
    clock: PRESENTATION_CLOCK,
    ...(causeTraceId === null ? {} : { causeTraceId }),
    sequence,
    ...(recordingFrame() === null ? {} : { recordingFrame: recordingFrame() as number }),
    phase: "preparing",
    mode: null,
    openedAtUnixMs: presentationNowUnixMs(),
    stagedTargetsStatus: "pending",
    stagedTargets: null,
    moves: change.moves.map((move) => ({ ...move })),
    panePresentationTargets: change.panePresentationTargets.map((target) => ({ ...target })),
    paneSettlementParticipants: change.paneSettlementParticipants.map((target) => ({ ...target })),
    settlement: null,
  };
  journal.entries.push(entry);
  publishLayoutTransitionJournal(Object.freeze({
    type: "preparing",
    transactionId: entry.transactionId,
    sequence: entry.sequence,
    ...(entry.causeTraceId ? { causeTraceId: entry.causeTraceId } : {}),
  }));
  const activeCount = journal.entries.filter((candidate) => !isTerminalPhase(candidate.phase)).length;
  if (activeCount > MAX_ACTIVE_LAYOUT_TRANSACTIONS) {
    const error = new Error(
      `layout active transaction capacity exceeded: ${MAX_ACTIVE_LAYOUT_TRANSACTIONS}`,
    );
    entry.phase = "failed";
    entry.closedAtUnixMs = presentationNowUnixMs();
    entry.failure = error.message;
    publishTerminalEntry(entry as LayoutTransitionJournalEntry & {
      phase: "failed";
      closedAtUnixMs: number;
    });
    throw error;
  }
  let bound = false;
  const closePreparingFailure = (error: unknown) => {
    if (entry.phase !== "preparing") return;
    entry.phase = "failed";
    entry.closedAtUnixMs = presentationNowUnixMs();
    entry.failure = error instanceof Error ? error.message : String(error);
    publishTerminalEntry(entry as LayoutTransitionJournalEntry & {
      phase: "failed";
      closedAtUnixMs: number;
    });
  };
  return {
    bind(prepared) {
      if (bound || entry.phase !== "preparing") {
        prepared.cancel();
        throw new Error(`layout transition journal bind is no longer open: ${entry.transactionId}`);
      }
      if (prepared.preparation) {
        const receipt = prepared.preparation;
        if (receipt.producer !== "layout-adapter" || !receipt.clock.trim()
          || receipt.stages.length === 0) {
          prepared.cancel();
          throw new Error(`layout preparation receipt is invalid: ${entry.transactionId}`);
        }
        const ids = new Set<string>();
        for (const stage of receipt.stages) {
          if (!stage.id.trim() || ids.has(stage.id)
            || stage.status !== "prepared"
            || !Number.isFinite(stage.startedAtUnixMs)
            || !Number.isFinite(stage.completedAtUnixMs)
            || stage.completedAtUnixMs < stage.startedAtUnixMs) {
            prepared.cancel();
            throw new Error(`layout preparation stage receipt is invalid: ${entry.transactionId}/${stage.id}`);
          }
          ids.add(stage.id);
        }
        entry.preparation = structuredClone(receipt);
      }
      bound = true;
      entry.phase = "prepared";
      entry.mode = prepared.mode;
      entry.preparedAtUnixMs = presentationNowUnixMs();
      entry.stagedTargetsStatus = "declared";
      entry.stagedTargets = [...prepared.stagedTargets];
      publishLayoutTransitionJournal(Object.freeze({
        type: "prepared",
        transactionId: entry.transactionId,
        sequence: entry.sequence,
        mode: prepared.mode,
        ...(entry.causeTraceId ? { causeTraceId: entry.causeTraceId } : {}),
      }));

      let closed = false;
      let startDone: Promise<import("./layoutPresentationCoordinator").LayoutPresentationStart | null>
        | null = null;
      return {
        transactionId: prepared.transactionId,
        mode: prepared.mode,
        requiresSharedStart: prepared.requiresSharedStart,
        stagedTargets: prepared.stagedTargets,
        start: (domParticipant) => {
          if (!prepared.requiresSharedStart) return Promise.resolve(null);
          if (!startDone) {
            startDone = (async () => {
              try {
                const rawReceipt = await prepared.start(domParticipant);
                const receipt = rawReceipt == null
                  ? null
                  : validateLayoutPresentationStart(rawReceipt, entry.transactionId);
                if (receipt) {
                  if (receipt.transactionId !== entry.transactionId) {
                    throw new Error(`layout presentation start identity changed: ${entry.transactionId}`);
                  }
                  entry.presentationStart = structuredClone(receipt);
                }
                return receipt;
              } catch (error) {
                if (!closed) {
                  closed = true;
                  prepared.cancel();
                  entry.phase = "failed";
                  entry.closedAtUnixMs = presentationNowUnixMs();
                  entry.failure = error instanceof Error ? error.message : String(error);
                  if (error instanceof LayoutPresentationCandidateFailure) {
                    entry.presentationFailure = {
                      transactionId: error.transactionId,
                      terminalStatus: error.terminalStatus,
                      candidateAttempts: error.candidateAttempts,
                    };
                  }
                  publishTerminalEntry(entry as LayoutTransitionJournalEntry & {
                    phase: "failed";
                    closedAtUnixMs: number;
                  });
                }
                throw error;
              }
            })();
          }
          return startDone;
        },
        commit: async () => {
          if (closed) return;
          closed = true;
          entry.domCommittedAtUnixMs = presentationNowUnixMs();
          publishLayoutTransitionJournal(Object.freeze({
            type: "dom-committed",
            transactionId: entry.transactionId,
            sequence: entry.sequence,
            domCommittedAtUnixMs: entry.domCommittedAtUnixMs,
          }));
          try {
            const projectionCommit = await prepared.commit();
            if (prepared.mode === "snap") {
              entry.projectionCommit = validateProjectionCommit(
                projectionCommit,
                entry.transactionId,
                prepared.stagedTargets,
              );
            } else if (projectionCommit !== undefined) {
              throw new Error(`glide layout cannot publish projection commit: ${entry.transactionId}`);
            }
            if (prepared.requiresSharedStart) {
              if (!startDone) throw new Error(`layout presentation was not started: ${entry.transactionId}`);
              await startDone;
            }
            entry.phase = "committed";
            entry.closedAtUnixMs = presentationNowUnixMs();
            publishTerminalEntry(entry as LayoutTransitionJournalEntry & {
              phase: "committed";
              closedAtUnixMs: number;
            });
          } catch (error) {
            entry.phase = "failed";
            entry.closedAtUnixMs = presentationNowUnixMs();
            const message = error instanceof Error ? error.message : String(error);
            entry.failure = message || "layout surface commit failed";
            if (error instanceof LayoutProjectionCommitFailure) {
              entry.projectionFailure = structuredClone(error.projectionFailure);
            }
            publishTerminalEntry(entry as LayoutTransitionJournalEntry & {
              phase: "failed";
              closedAtUnixMs: number;
            });
            throw error;
          }
        },
        cancel: () => {
          if (closed) return;
          closed = true;
          prepared.cancel();
          entry.phase = "cancelled";
          entry.closedAtUnixMs = presentationNowUnixMs();
          publishTerminalEntry(entry as LayoutTransitionJournalEntry & {
            phase: "cancelled";
            closedAtUnixMs: number;
          });
        },
      };
    },
    fail: closePreparingFailure,
  };
}

export function __resetLayoutTransitionJournalForTest(): void {
  for (const release of [...transactionWaiters]) release();
  journal.sequence = 0;
  journal.entries.length = 0;
  journal.pendingCauseTraceId = null;
  journalListeners.clear();
}

export function __layoutTransitionJournalListenerCountForTest(): number {
  return transactionWaiters.size;
}
