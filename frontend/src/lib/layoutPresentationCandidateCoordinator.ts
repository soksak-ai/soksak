import { PRESENTATION_CLOCK, presentationNowUnixUs } from "./presentationClock";

export interface LayoutPresentationCandidate {
  transactionId: string;
  producer: "display-callback";
  clock: typeof PRESENTATION_CLOCK;
  sourceGeneration: number;
  frameSequence: number;
  commandReceivedAtUnixUs: number;
  installedAtUnixUs: number;
  callbackReceivedAtUnixUs: number;
  callbackObservedAtUnixMs: number;
  callbackObservedAtUnixUs: number;
  startAtUnixUs: number;
  durationMs: number;
  documentTimelineBridge: Readonly<{
    producer: "display-callback-wall-bridge";
    clock: "unix-wall";
    callbackObservedAtUnixUs: number;
    startAtUnixUs: number;
  }>;
}

export interface LayoutPresentationCandidateInstallation {
  transactionId: string;
  producer: "display-callback-installation";
  clock: typeof PRESENTATION_CLOCK;
  sourceGeneration: number;
  commandReceivedAtUnixUs: number;
  installedAtUnixUs: number;
}

export interface ArmedLayoutPresentationCandidateParticipant {
  id: string;
  transactionId: string;
  /** Event-owned presentation prerequisite that must close before the candidate reservation. */
  ready?(): Promise<void>;
  arm(candidate: LayoutPresentationCandidate): Promise<void>;
  disarm(candidate: LayoutPresentationCandidate): Promise<void> | void;
  release(candidate: LayoutPresentationCandidate): Promise<void>;
  rollback(candidate: LayoutPresentationCandidate): Promise<void>;
  cancel(): void;
}

export interface LayoutPresentationCandidateParticipant {
  id: string;
  prepare(transactionId: string): Promise<ArmedLayoutPresentationCandidateParticipant>;
}

export type LayoutPresentationParticipantArmDiagnostic = Readonly<{
  kind: string;
  [key: string]: unknown;
}>;

export class LayoutPresentationParticipantArmFailure extends Error {
  readonly diagnostic: LayoutPresentationParticipantArmDiagnostic;

  constructor(message: string, diagnostic: LayoutPresentationParticipantArmDiagnostic) {
    super(message);
    this.name = "LayoutPresentationParticipantArmFailure";
    this.diagnostic = Object.freeze(structuredClone(diagnostic));
  }
}

type CandidateAcceptance = Readonly<{
  status: "accepted" | "missed";
  receipt: LayoutPresentationCandidate;
  acceptedAtUnixUs: number;
  remainingLeadMs: number;
}>;

export type LayoutPresentationCandidateReservation = Readonly<{
  transactionId: string;
  outcome: Promise<Readonly<
    | { status: "fulfilled"; candidate: LayoutPresentationCandidate }
    | { status: "rejected"; error: unknown }
  >>;
  cancel(): Promise<void>;
}>;

export type LayoutPresentationCandidateAttempt = Readonly<{
  attempt: number;
  candidate: LayoutPresentationCandidate;
  armAcknowledgedParticipantIds: readonly string[];
  armFailures: readonly Readonly<{
    participantId: string;
    error: string;
    diagnostic?: LayoutPresentationParticipantArmDiagnostic;
  }>[];
  armClock: typeof PRESENTATION_CLOCK;
  armStartedAtUnixUs: number;
  armCompletedAtUnixUs: number;
  armDurationUs: number;
  acceptance?: "accepted" | "missed";
  acceptedAtUnixUs?: number;
  remainingLeadMs?: number;
  disarmedParticipantIds: readonly string[];
  disarmFailures: readonly Readonly<{ participantId: string; error: string }>[];
  releasedParticipantIds: readonly string[];
  releaseFailures: readonly Readonly<{ participantId: string; error: string }>[];
  rolledBackParticipantIds: readonly string[];
  rollbackFailures: readonly Readonly<{ participantId: string; error: string }>[];
}>;

export type LayoutPresentationCandidateTerminalStatus =
  | "arm-failed"
  | "accept-failed"
  | "candidate-identity-changed"
  | "candidate-status-invalid"
  | "release-failed"
  | "candidates-exhausted";

export class LayoutPresentationCandidateFailure extends Error {
  readonly transactionId: string;
  readonly terminalStatus: LayoutPresentationCandidateTerminalStatus;
  readonly candidateAttempts: readonly LayoutPresentationCandidateAttempt[];

  constructor({
    transactionId,
    terminalStatus,
    candidateAttempts,
    cause,
  }: {
    transactionId: string;
    terminalStatus: LayoutPresentationCandidateTerminalStatus;
    candidateAttempts: readonly LayoutPresentationCandidateAttempt[];
    cause: unknown;
  }) {
    super(cause instanceof Error ? cause.message : String(cause));
    Object.defineProperty(this, "cause", { value: cause, enumerable: false });
    this.name = "LayoutPresentationCandidateFailure";
    this.transactionId = transactionId;
    this.terminalStatus = terminalStatus;
    this.candidateAttempts = Object.freeze(candidateAttempts.map((attempt) => Object.freeze({
      ...attempt,
      candidate: Object.freeze({
        ...attempt.candidate,
        documentTimelineBridge: Object.freeze({ ...attempt.candidate.documentTimelineBridge }),
      }),
      armAcknowledgedParticipantIds: Object.freeze([...attempt.armAcknowledgedParticipantIds]),
      armFailures: Object.freeze(attempt.armFailures.map((failure) => Object.freeze({ ...failure }))),
      disarmedParticipantIds: Object.freeze([...attempt.disarmedParticipantIds]),
      disarmFailures: Object.freeze(attempt.disarmFailures.map((failure) => Object.freeze({ ...failure }))),
      releasedParticipantIds: Object.freeze([...attempt.releasedParticipantIds]),
      releaseFailures: Object.freeze(attempt.releaseFailures.map((failure) => Object.freeze({ ...failure }))),
      rolledBackParticipantIds: Object.freeze([...attempt.rolledBackParticipantIds]),
      rollbackFailures: Object.freeze(attempt.rollbackFailures.map((failure) => Object.freeze({ ...failure }))),
    })));
  }
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

function settlementResults(
  participants: readonly ArmedLayoutPresentationCandidateParticipant[],
  outcomes: readonly PromiseSettledResult<void>[],
): {
  acknowledged: string[];
  failures: Array<{
    participantId: string;
    error: string;
    diagnostic?: LayoutPresentationParticipantArmDiagnostic;
  }>;
} {
  return outcomes.reduce((result, outcome, index) => {
    const participantId = participants[index]?.id ?? `missing-${index}`;
    if (outcome.status === "fulfilled") result.acknowledged.push(participantId);
    else {
      const candidateDiagnostic = outcome.reason instanceof Object
        ? Reflect.get(outcome.reason, "diagnostic")
        : undefined;
      const diagnostic = candidateDiagnostic && typeof candidateDiagnostic === "object"
        && typeof Reflect.get(candidateDiagnostic, "kind") === "string"
        ? structuredClone(candidateDiagnostic) as LayoutPresentationParticipantArmDiagnostic
        : undefined;
      result.failures.push({
        participantId,
        error: errorText(outcome.reason),
        ...(diagnostic === undefined ? {} : { diagnostic }),
      });
    }
    return result;
  }, {
    acknowledged: [] as string[],
    failures: [] as Array<{
      participantId: string;
      error: string;
      diagnostic?: LayoutPresentationParticipantArmDiagnostic;
    }>,
  });
}

function validCandidate(
  value: LayoutPresentationCandidate,
  transactionId: string,
): LayoutPresentationCandidate {
  if (
    value.transactionId !== transactionId
    || value.producer !== "display-callback"
    || value.clock !== PRESENTATION_CLOCK
    || !Number.isInteger(value.sourceGeneration)
    || value.sourceGeneration < 1
    || !Number.isInteger(value.frameSequence)
    || value.frameSequence < 1
    || !Number.isSafeInteger(value.commandReceivedAtUnixUs)
    || value.commandReceivedAtUnixUs <= 0
    || !Number.isSafeInteger(value.installedAtUnixUs)
    || value.installedAtUnixUs < value.commandReceivedAtUnixUs
    || !Number.isSafeInteger(value.callbackReceivedAtUnixUs)
    || value.callbackReceivedAtUnixUs < value.installedAtUnixUs
    || !Number.isFinite(value.callbackObservedAtUnixMs)
    || !Number.isSafeInteger(value.callbackObservedAtUnixUs)
    || value.callbackObservedAtUnixUs <= 0
    || !Number.isSafeInteger(value.startAtUnixUs)
    || value.startAtUnixUs <= 0
    || !Number.isFinite(value.durationMs)
    || value.durationMs <= 0
    || value.documentTimelineBridge?.producer !== "display-callback-wall-bridge"
    || value.documentTimelineBridge.clock !== "unix-wall"
    || !Number.isSafeInteger(value.documentTimelineBridge.callbackObservedAtUnixUs)
    || value.documentTimelineBridge.callbackObservedAtUnixUs <= 0
    || !Number.isSafeInteger(value.documentTimelineBridge.startAtUnixUs)
    || value.documentTimelineBridge.startAtUnixUs <= value.documentTimelineBridge.callbackObservedAtUnixUs
  ) {
    throw new Error(`layout presentation candidate identity is invalid: ${transactionId}`);
  }
  return value;
}

function validInstallation(
  value: LayoutPresentationCandidateInstallation,
  transactionId: string,
): LayoutPresentationCandidateInstallation {
  if (value.transactionId !== transactionId
    || value.producer !== "display-callback-installation"
    || value.clock !== PRESENTATION_CLOCK
    || !Number.isInteger(value.sourceGeneration)
    || value.sourceGeneration < 1
    || !Number.isSafeInteger(value.commandReceivedAtUnixUs)
    || value.commandReceivedAtUnixUs <= 0
    || !Number.isSafeInteger(value.installedAtUnixUs)
    || value.installedAtUnixUs < value.commandReceivedAtUnixUs) {
    throw new Error(`layout presentation candidate installation identity is invalid: ${transactionId}`);
  }
  return value;
}

function sameCandidate(left: LayoutPresentationCandidate, right: LayoutPresentationCandidate): boolean {
  return left.transactionId === right.transactionId
    && left.producer === right.producer
    && left.clock === right.clock
    && left.sourceGeneration === right.sourceGeneration
    && left.frameSequence === right.frameSequence
    && left.commandReceivedAtUnixUs === right.commandReceivedAtUnixUs
    && left.installedAtUnixUs === right.installedAtUnixUs
    && left.callbackReceivedAtUnixUs === right.callbackReceivedAtUnixUs
    && left.callbackObservedAtUnixUs === right.callbackObservedAtUnixUs
    && left.startAtUnixUs === right.startAtUnixUs
    && left.documentTimelineBridge.producer === right.documentTimelineBridge.producer
    && left.documentTimelineBridge.clock === right.documentTimelineBridge.clock
    && left.documentTimelineBridge.callbackObservedAtUnixUs === right.documentTimelineBridge.callbackObservedAtUnixUs
    && left.documentTimelineBridge.startAtUnixUs === right.documentTimelineBridge.startAtUnixUs
    && left.durationMs === right.durationMs;
}

/**
 * The producer accepts a candidate only after every presentation participant arms the same future
 * epoch. A missed callback candidate is never presented — all participants disarm — and
 * exhausting the finite candidates fails.
 */
export function createLayoutPresentationCandidateCoordinator({
  reserveCandidate,
  installCandidate,
  readCandidate,
  cancelCandidate = async () => {},
  acceptCandidate,
  maxCandidateAttempts,
  nowUnixUs = presentationNowUnixUs,
}: {
  reserveCandidate(transactionId: string): Promise<LayoutPresentationCandidate>;
  installCandidate?(transactionId: string): Promise<LayoutPresentationCandidateInstallation>;
  readCandidate?(installation: LayoutPresentationCandidateInstallation): Promise<LayoutPresentationCandidate>;
  cancelCandidate?(transactionId: string): Promise<void>;
  acceptCandidate(candidate: LayoutPresentationCandidate): Promise<CandidateAcceptance>;
  maxCandidateAttempts: number;
  nowUnixUs?: () => number;
}) {
  if (!Number.isInteger(maxCandidateAttempts) || maxCandidateAttempts < 1) {
    throw new Error(`layout presentation candidate attempts is invalid: ${maxCandidateAttempts}`);
  }
  const reservation = (
    transactionId: string,
    pending: Promise<LayoutPresentationCandidate>,
    installed = false,
    cancelReady?: Promise<unknown>,
  ): LayoutPresentationCandidateReservation => {
    const outcome = pending.then(
      (candidate) => Object.freeze({ status: "fulfilled" as const, candidate }),
      (error) => Object.freeze({ status: "rejected" as const, error }),
    );
    let cancelPromise: Promise<void> | null = null;
    return Object.freeze({
      transactionId,
      outcome,
      cancel() {
        cancelPromise ??= installed
          ? cancelCandidate(transactionId)
          : cancelReady
            ? cancelReady.then(
              () => cancelCandidate(transactionId),
              () => {},
            )
          : outcome.then(async (result) => {
            if (result.status === "fulfilled") await cancelCandidate(transactionId);
          });
        return cancelPromise;
      },
    });
  };
  return {
    reserve(transactionId: string): LayoutPresentationCandidateReservation {
      if (!transactionId) throw new Error("layout presentation transactionId is empty");
      return reservation(transactionId, reserveCandidate(transactionId));
    },
    reserveInstalling(transactionId: string): LayoutPresentationCandidateReservation {
      if (!transactionId) throw new Error("layout presentation transactionId is empty");
      if (!installCandidate || !readCandidate) {
        throw new Error(`layout presentation candidate installation boundary is absent: ${transactionId}`);
      }
      const installation = installCandidate(transactionId).then((value) =>
        validInstallation(value, transactionId));
      const pending = installation.then((installed) => readCandidate(installed).then((candidate) => {
        const validated = validCandidate(candidate, transactionId);
        if (validated.sourceGeneration !== installed.sourceGeneration
          || validated.commandReceivedAtUnixUs !== installed.commandReceivedAtUnixUs
          || validated.installedAtUnixUs !== installed.installedAtUnixUs) {
          throw new Error(`layout presentation candidate installation identity changed: ${transactionId}`);
        }
        return validated;
      }));
      return reservation(transactionId, pending, false, installation);
    },
    reserveInstallation(
      value: LayoutPresentationCandidateInstallation,
    ): LayoutPresentationCandidateReservation {
      const transactionId = value.transactionId;
      if (!transactionId) throw new Error("layout presentation transactionId is empty");
      if (!readCandidate) {
        throw new Error(`layout presentation candidate read boundary is absent: ${transactionId}`);
      }
      const installation = validInstallation(value, transactionId);
      const pending = readCandidate(installation).then((candidate) => {
        const validated = validCandidate(candidate, transactionId);
        if (validated.sourceGeneration !== installation.sourceGeneration
          || validated.commandReceivedAtUnixUs !== installation.commandReceivedAtUnixUs
          || validated.installedAtUnixUs !== installation.installedAtUnixUs) {
          throw new Error(`layout presentation candidate installation identity changed: ${transactionId}`);
        }
        return validated;
      });
      return reservation(transactionId, pending, true);
    },
    async reserveInstalled(transactionId: string): Promise<LayoutPresentationCandidateReservation> {
      if (!transactionId) throw new Error("layout presentation transactionId is empty");
      if (!installCandidate || !readCandidate) {
        throw new Error(`layout presentation candidate installation boundary is absent: ${transactionId}`);
      }
      const installation = validInstallation(await installCandidate(transactionId), transactionId);
      const pending = readCandidate(installation).then((candidate) => {
        const validated = validCandidate(candidate, transactionId);
        if (validated.sourceGeneration !== installation.sourceGeneration
          || validated.commandReceivedAtUnixUs !== installation.commandReceivedAtUnixUs
          || validated.installedAtUnixUs !== installation.installedAtUnixUs) {
          throw new Error(`layout presentation candidate installation identity changed: ${transactionId}`);
        }
        return validated;
      });
      return reservation(transactionId, pending, true);
    },
    async prepare({
      transactionId,
      participants,
      firstReservation,
    }: {
      transactionId: string;
      participants: readonly LayoutPresentationCandidateParticipant[];
      firstReservation?: LayoutPresentationCandidateReservation;
    }) {
      if (!transactionId) throw new Error("layout presentation transactionId is empty");
      const ids = participants.map(({ id }) => id);
      if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
        throw new Error(`layout presentation participant identity is invalid: ${transactionId}`);
      }
      const outcomes = await Promise.allSettled(
        participants.map((participant) => participant.prepare(transactionId)),
      );
      const prepared = outcomes.flatMap((outcome) => (
        outcome.status === "fulfilled" ? [outcome.value] : []
      ));
      const preparationFailed = outcomes.find((outcome) => outcome.status === "rejected");
      const identitiesValid = prepared.length === participants.length
        && prepared.every((entry, index) => (
          entry.id === participants[index]?.id && entry.transactionId === transactionId
        ));
      if (preparationFailed || !identitiesValid) {
        for (const entry of prepared) entry.cancel();
        if (preparationFailed?.status === "rejected") throw preparationFailed.reason;
        throw new Error(`layout presentation participant identity is invalid: ${transactionId}`);
      }

      let cancelled = false;
      let startPromise: Promise<LayoutPresentationCandidate> | null = null;
      const candidateAttempts: LayoutPresentationCandidateAttempt[] = [];
      if (firstReservation && firstReservation.transactionId !== transactionId) {
        throw new Error(`layout presentation candidate reservation identity changed: ${transactionId}`);
      }
      let prefetchedReservation = firstReservation;
      const cancel = () => {
        if (cancelled) return;
        cancelled = true;
        for (const entry of prepared) entry.cancel();
      };
      return {
        transactionId,
        get candidateAttempts(): readonly LayoutPresentationCandidateAttempt[] {
          return structuredClone(candidateAttempts);
        },
        start(): Promise<LayoutPresentationCandidate> {
          if (cancelled) {
            return Promise.reject(new Error(`layout presentation cancelled: ${transactionId}`));
          }
          if (startPromise) return startPromise;
          startPromise = (async () => {
            try {
              await Promise.all(prepared.map((entry) => entry.ready?.()));
              for (let attempt = 1; attempt <= maxCandidateAttempts; attempt += 1) {
                const reservation = attempt === 1 ? prefetchedReservation : undefined;
                prefetchedReservation = undefined;
                const outcome = reservation ? await reservation.outcome : null;
                if (outcome?.status === "rejected") throw outcome.error;
                const candidate = validCandidate(
                  outcome?.status === "fulfilled"
                    ? outcome.candidate
                    : await reserveCandidate(transactionId),
                  transactionId,
                );
                const armStartedAtUnixUs = nowUnixUs();
                const armed = await Promise.allSettled(prepared.map((entry) => entry.arm(candidate)));
                const armCompletedAtUnixUs = nowUnixUs();
                if (!Number.isSafeInteger(armStartedAtUnixUs)
                    || !Number.isSafeInteger(armCompletedAtUnixUs)
                    || armCompletedAtUnixUs < armStartedAtUnixUs) {
                  throw new Error(`layout presentation arm completion clock is invalid: ${transactionId}`);
                }
                const armResult = settlementResults(prepared, armed);
                const attemptReceipt: LayoutPresentationCandidateAttempt = {
                  attempt,
                  candidate: { ...candidate },
                  armAcknowledgedParticipantIds: armResult.acknowledged,
                  armFailures: armResult.failures,
                  armClock: PRESENTATION_CLOCK,
                  armStartedAtUnixUs,
                  armCompletedAtUnixUs,
                  armDurationUs: armCompletedAtUnixUs - armStartedAtUnixUs,
                  disarmedParticipantIds: [],
                  disarmFailures: [],
                  releasedParticipantIds: [],
                  releaseFailures: [],
                  rolledBackParticipantIds: [],
                  rollbackFailures: [],
                };
                candidateAttempts.push(attemptReceipt);
                const armFailure = armed.find((outcome) => outcome.status === "rejected");
                const disarmAttempt = async () => {
                  const disarmed = await Promise.allSettled(
                    prepared.map((entry) => entry.disarm(candidate)),
                  );
                  const disarmResult = settlementResults(prepared, disarmed);
                  Object.assign(attemptReceipt, {
                    disarmedParticipantIds: disarmResult.acknowledged,
                    disarmFailures: disarmResult.failures,
                  });
                };
                if (armFailure) {
                  await disarmAttempt();
                  throw new LayoutPresentationCandidateFailure({
                    transactionId,
                    terminalStatus: "arm-failed",
                    candidateAttempts,
                    cause: armFailure.status === "rejected" ? armFailure.reason : "layout arm failed",
                  });
                }
                let acceptance: CandidateAcceptance;
                try {
                  acceptance = await acceptCandidate(candidate);
                } catch (error) {
                  await disarmAttempt();
                  throw new LayoutPresentationCandidateFailure({
                    transactionId,
                    terminalStatus: "accept-failed",
                    candidateAttempts,
                    cause: error,
                  });
                }
                if (!Number.isSafeInteger(acceptance.acceptedAtUnixUs)
                    || !Number.isFinite(acceptance.remainingLeadMs)
                    || acceptance.remainingLeadMs
                      !== (candidate.startAtUnixUs - acceptance.acceptedAtUnixUs) / 1_000) {
                  await disarmAttempt();
                  throw new LayoutPresentationCandidateFailure({
                    transactionId,
                    terminalStatus: "candidate-identity-changed",
                    candidateAttempts,
                    cause: new Error(`layout presentation candidate acceptance clock is invalid: ${transactionId}`),
                  });
                }
                Object.assign(attemptReceipt, {
                  acceptance: acceptance.status,
                  acceptedAtUnixUs: acceptance.acceptedAtUnixUs,
                  remainingLeadMs: acceptance.remainingLeadMs,
                });
                let acceptedReceipt: LayoutPresentationCandidate;
                try {
                  acceptedReceipt = validCandidate(acceptance.receipt, transactionId);
                } catch (error) {
                  await disarmAttempt();
                  throw new LayoutPresentationCandidateFailure({
                    transactionId,
                    terminalStatus: "candidate-identity-changed",
                    candidateAttempts,
                    cause: error,
                  });
                }
                if (!sameCandidate(acceptedReceipt, candidate)) {
                  await disarmAttempt();
                  throw new LayoutPresentationCandidateFailure({
                    transactionId,
                    terminalStatus: "candidate-identity-changed",
                    candidateAttempts,
                    cause: new Error(`layout presentation candidate identity changed: ${transactionId}`),
                  });
                }
                if (acceptance.status === "accepted") {
                  const released = await Promise.allSettled(
                    prepared.map((entry) => entry.release(candidate)),
                  );
                  const releaseResult = settlementResults(prepared, released);
                  Object.assign(attemptReceipt, {
                    releasedParticipantIds: releaseResult.acknowledged,
                    releaseFailures: releaseResult.failures,
                  });
                  const releaseFailure = released.find((outcome) => outcome.status === "rejected");
                  if (releaseFailure) {
                    const rolledBack = await Promise.allSettled(prepared.map((entry) => entry.rollback(candidate)));
                    const rollbackResult = settlementResults(prepared, rolledBack);
                    Object.assign(attemptReceipt, {
                      rolledBackParticipantIds: rollbackResult.acknowledged,
                      rollbackFailures: rollbackResult.failures,
                    });
                    throw new LayoutPresentationCandidateFailure({
                      transactionId,
                      terminalStatus: "release-failed",
                      candidateAttempts,
                      cause: releaseFailure.status === "rejected" ? releaseFailure.reason : "layout release failed",
                    });
                  }
                  return candidate;
                }
                if (acceptance.status !== "missed") {
                  await disarmAttempt();
                  throw new LayoutPresentationCandidateFailure({
                    transactionId,
                    terminalStatus: "candidate-status-invalid",
                    candidateAttempts,
                    cause: new Error(`layout presentation candidate status is invalid: ${transactionId}`),
                  });
                }
                await disarmAttempt();
              }
              throw new LayoutPresentationCandidateFailure({
                transactionId,
                terminalStatus: "candidates-exhausted",
                candidateAttempts,
                cause: new Error(`display candidate missed: ${transactionId}/${maxCandidateAttempts}`),
              });
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
