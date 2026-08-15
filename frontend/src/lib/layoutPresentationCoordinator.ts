import { PRESENTATION_CLOCK } from "./presentationClock";
import type { LayoutPresentationCandidateAttempt } from "./layoutPresentationCandidateCoordinator";

export interface LayoutPresentationStart {
  transactionId: string;
  producer: "display-callback";
  clock: typeof PRESENTATION_CLOCK;
  sourceGeneration: number;
  frameSequence: number;
  startAtUnixUs: number;
  durationMs: number;
  candidateAttempts: readonly LayoutPresentationCandidateAttempt[];
}

export interface PreparedLayoutPresentationParticipant {
  id: string;
  transactionId: string;
  start(receipt: LayoutPresentationStart): Promise<void>;
  cancel(): void;
}

export interface LayoutPresentationParticipant {
  id: string;
  prepare(transactionId: string): Promise<PreparedLayoutPresentationParticipant>;
}

export interface PreparedLayoutPresentation {
  transactionId: string;
  start(): Promise<LayoutPresentationStart>;
  cancel(): void;
}

export const validateLayoutPresentationStart = (
  receipt: LayoutPresentationStart,
  transactionId: string,
): LayoutPresentationStart => {
  if (!Array.isArray(receipt.candidateAttempts)
      || receipt.candidateAttempts.length < 1
      || receipt.candidateAttempts.length > 2) {
    throw new Error(`layout presentation start candidateAttempts are invalid: ${transactionId}`);
  }
  if (
    receipt.transactionId !== transactionId
    || receipt.producer !== "display-callback"
    || receipt.clock !== PRESENTATION_CLOCK
    || !Number.isInteger(receipt.sourceGeneration)
    || receipt.sourceGeneration < 1
    || !Number.isInteger(receipt.frameSequence)
    || receipt.frameSequence < 1
    || !Number.isSafeInteger(receipt.startAtUnixUs)
    || receipt.startAtUnixUs <= 0
    || !Number.isFinite(receipt.durationMs)
    || receipt.durationMs <= 0
  ) {
    throw new Error(`layout presentation start identity is invalid: ${transactionId}`);
  }
  const attemptsValid = receipt.candidateAttempts.every((attempt, index) => (
    attempt.attempt === index + 1
    && attempt.candidate?.transactionId === transactionId
    && attempt.candidate.producer === receipt.producer
    && attempt.candidate.clock === receipt.clock
    && Number.isInteger(attempt.candidate.sourceGeneration)
    && Number.isInteger(attempt.candidate.frameSequence)
    && Number.isSafeInteger(attempt.candidate.startAtUnixUs)
    && Array.isArray(attempt.armAcknowledgedParticipantIds)
    && Array.isArray(attempt.armFailures)
    && attempt.armClock === PRESENTATION_CLOCK
    && Number.isSafeInteger(attempt.armStartedAtUnixUs)
    && Number.isSafeInteger(attempt.armCompletedAtUnixUs)
    && attempt.armCompletedAtUnixUs >= attempt.armStartedAtUnixUs
    && Number.isSafeInteger(attempt.armDurationUs)
    && attempt.armDurationUs === attempt.armCompletedAtUnixUs - attempt.armStartedAtUnixUs
    && Array.isArray(attempt.disarmedParticipantIds)
    && Array.isArray(attempt.disarmFailures)
    && Array.isArray(attempt.releasedParticipantIds)
    && Array.isArray(attempt.releaseFailures)
    && Array.isArray(attempt.rolledBackParticipantIds)
    && Array.isArray(attempt.rollbackFailures)
  ));
  const accepted = receipt.candidateAttempts[receipt.candidateAttempts.length - 1];
  if (!attemptsValid
      || accepted?.acceptance !== "accepted"
      || accepted.candidate.sourceGeneration !== receipt.sourceGeneration
      || accepted.candidate.frameSequence !== receipt.frameSequence
      || accepted.candidate.startAtUnixUs !== receipt.startAtUnixUs
      || accepted.candidate.durationMs !== receipt.durationMs) {
    throw new Error(`layout presentation start candidateAttempts are invalid: ${transactionId}`);
  }
  return receipt;
};

/** One owner prepares every external surface before it requests one start from the display producer. */
export function createLayoutPresentationCoordinator({
  nextDisplay,
}: {
  nextDisplay(transactionId: string): Promise<LayoutPresentationStart>;
}) {
  return {
    async prepare({
      transactionId,
      participants,
    }: {
      transactionId: string;
      participants: readonly LayoutPresentationParticipant[];
    }): Promise<PreparedLayoutPresentation> {
      if (!transactionId) throw new Error("layout presentation transactionId is empty");
      const ids = new Set<string>();
      for (const participant of participants) {
        if (!participant.id || ids.has(participant.id)) {
          throw new Error(`layout presentation participant identity is invalid: ${participant.id}`);
        }
        ids.add(participant.id);
      }

      const outcomes = await Promise.allSettled(
        participants.map((participant) => participant.prepare(transactionId)),
      );
      const prepared = outcomes.flatMap((outcome) =>
        outcome.status === "fulfilled" ? [outcome.value] : []);
      const failed = outcomes.find((outcome) => outcome.status === "rejected");
      const identitiesValid = prepared.length === participants.length
        && prepared.every((entry, index) => (
          entry.id === participants[index]?.id && entry.transactionId === transactionId
        ));
      if (failed || !identitiesValid) {
        for (const entry of prepared) entry.cancel();
        if (failed?.status === "rejected") throw failed.reason;
        throw new Error(`layout presentation participant identity is invalid: ${transactionId}`);
      }

      let cancelled = false;
      let startPromise: Promise<LayoutPresentationStart> | null = null;
      const cancel = (): void => {
        if (cancelled) return;
        cancelled = true;
        for (const entry of prepared) entry.cancel();
      };
      return {
        transactionId,
        start(): Promise<LayoutPresentationStart> {
          if (cancelled) return Promise.reject(new Error(`layout presentation cancelled: ${transactionId}`));
          if (startPromise) return startPromise;
          startPromise = (async () => {
            try {
              const receipt = validateLayoutPresentationStart(await nextDisplay(transactionId), transactionId);
              await Promise.all(prepared.map((entry) => entry.start(receipt)));
              return receipt;
            } catch (error) {
              cancel();
              throw error;
            }
          })();
          return startPromise;
        },
        cancel,
      };
    },
  };
}
