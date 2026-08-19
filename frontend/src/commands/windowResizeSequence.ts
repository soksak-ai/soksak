import {
  RESIZE_TRANSACTION_PHASES,
  type PhysicalWindowSize,
  type ResizeObservationRequest,
  type ResizeSequenceStep,
} from "../lib/windowResizeProbe";
import {
  startWindowRecording,
  validWindowRecordMaxBytes,
  type WindowRecordRequest,
  type WindowRecorder,
  type WindowRecordingReport,
} from "./windowRecorder";
import { tmsg } from "../i18n";

// The shapes of size, request, and step are owned by the observation envelope contract. Redeclaring
// them here would give the observer and the transaction driver two different shapes for one axis.
export type { PhysicalWindowSize, ResizeObservationRequest, ResizeSequenceStep };

/**
 * The observation slot before the first size is requested. Not asked (not-observed), asked with no
 * answer (unavailable), and observed are different facts, so they are not collapsed into one null.
 */
export type ResizeBaselineReport =
  | { status: "not-observed" }
  | { status: "unavailable"; reason: string }
  | { status: "observed"; observation: unknown };

export type ResizeSampleReport =
  | { step: number; size: ResizeSequenceStep; status: "observed"; observation: unknown }
  | { step: number; size: ResizeSequenceStep; status: "unavailable"; reason: string };

export type WindowResizeRecording = Pick<
  WindowRecordRequest,
  "dir" | "frames" | "intervalMs" | "maxBytes"
>;

export type WindowResizeRecordingResult = WindowRecordingReport;

interface ResizeSequenceRequest {
  sizes: ResizeSequenceStep[];
  intervalMs: number;
  record?: WindowResizeRecording;
  setSize: (w: number, h: number) => Promise<void>;
  recordFrames: WindowRecorder;
  observe?: (request: ResizeObservationRequest) => Promise<unknown> | unknown;
}

const MAX_STEPS = 120;
const NO_OBSERVATION_REASON = "resize observer returned no observation";

const delay = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

async function observeBaseline(
  observe: ResizeSequenceRequest["observe"],
): Promise<ResizeBaselineReport> {
  if (!observe) return { status: "not-observed" };
  try {
    const observation = await observe({ kind: "baseline" });
    return observation == null
      ? { status: "unavailable", reason: NO_OBSERVATION_REASON }
      : { status: "observed", observation };
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function validateRecording(record: WindowResizeRecording): void {
  if (typeof record.dir !== "string" || record.dir.trim().length === 0) {
    throw new Error(tmsg("msg.window.record.dirEmpty"));
  }
  if (!Number.isSafeInteger(record.frames) || record.frames < 1 || record.frames > 600) {
    throw new Error(tmsg("msg.window.record.frames"));
  }
  if (!Number.isFinite(record.intervalMs) || record.intervalMs < 0 || record.intervalMs > 1_000) {
    throw new Error(tmsg("msg.window.record.intervalMs"));
  }
  if (record.maxBytes !== undefined && !validWindowRecordMaxBytes(record.maxBytes)) {
    throw new Error(tmsg("msg.window.record.maxBytes"));
  }
}

/**
 * A finite native window resize transaction.
 *
 * Once recording is ready, physical sizes are applied in input order after the first baseline frame.
 * Recording is separate evidence for a person reviewing the transition, so a start, readiness, or
 * completion failure does not cancel the resize transaction. No state polling, no retries; only the
 * cadence the caller specified.
 *
 * Before the first size is applied, baseline is read once through the same observation surface the
 * steps use. A change cannot be judged without the prior state, and that prior state cannot be
 * derived from the requested sizes.
 *
 * The observation surface can reject baseline because no native transaction has settled yet. That
 * rejection is a fact from before the transaction, not its result, so the reason is reported as-is
 * and the resize is not cancelled. A step observation failure is the opposite — it means the
 * transaction has no evidence — so it is surfaced directly.
 */
export async function runWindowResizeSequence({
  sizes,
  intervalMs,
  record,
  setSize,
  recordFrames,
  observe,
}: ResizeSequenceRequest): Promise<{
  steps: number;
  recording: WindowResizeRecordingResult;
  resizeElapsedMs: number;
  elapsedMs: number;
  final: ResizeSequenceStep;
  baseline: ResizeBaselineReport;
  samples: ResizeSampleReport[];
  measurement: { passed: boolean; unavailableSteps: number };
}> {
  if (!Array.isArray(sizes) || sizes.length === 0) throw new Error(tmsg("msg.window.resizeSequence.sizesEmpty"));
  if (sizes.length > MAX_STEPS) throw new Error(tmsg("msg.window.resizeSequence.maxSteps", { max: MAX_STEPS }));
  if (!Number.isFinite(intervalMs) || intervalMs < 0 || intervalMs > 1_000) {
    throw new Error(tmsg("msg.window.resizeSequence.intervalMs"));
  }
  for (const size of sizes) {
    if (!Number.isFinite(size?.w) || !Number.isFinite(size?.h) || size.w <= 0 || size.h <= 0) {
      throw new Error(tmsg("msg.window.resizeSequence.invalidSize", { size: JSON.stringify(size) }));
    }
    // The caller declares each step's intent. An unrecognized name cannot be cross-checked by the
    // observation, so it is rejected here — deriving it from the observed geometry would make that
    // cross-check a comparison with itself.
    if (size.phase !== undefined
      && !(RESIZE_TRANSACTION_PHASES as readonly string[]).includes(size.phase)) {
      throw new Error(
        `invalid resize phase: ${JSON.stringify(size.phase)}`
          + ` (expected one of ${RESIZE_TRANSACTION_PHASES.join(", ")})`,
      );
    }
  }
  if (record) validateRecording(record);

  const startedAt = performance.now();
  const recording = record
    ? startWindowRecording(record, recordFrames)
    : null;
  // Only a successful readiness guarantees the baseline ordering. A failure is already closed as
  // recording state, so the native resize proceeds unchanged.
  await (recording?.ready ?? Promise.resolve(false));

  // Observation before the first size is requested. It must sit outside the resize time budget so a
  // stall verdict measures resize only.
  const baseline = await observeBaseline(observe);

  const resizeStartedAt = performance.now();
  const samples: ResizeSampleReport[] = [];
  for (let index = 0; index < sizes.length; index += 1) {
    const size = sizes[index];
    await setSize(size.w, size.h);
    if (observe) {
      const observation = await observe({
        kind: "step",
        step: index,
        size: { w: size.w, h: size.h },
        ...(size.phase === undefined ? {} : { phase: size.phase }),
      });
      samples.push(observation == null
        ? { step: index, size, status: "unavailable", reason: NO_OBSERVATION_REASON }
        : { step: index, size, status: "observed", observation });
    }
    if (index + 1 < sizes.length) await delay(intervalMs);
  }
  const resizeElapsedMs = Math.round(performance.now() - resizeStartedAt);

  const recordingResult: WindowResizeRecordingResult = recording
    ? await recording.report
    : { status: "not-requested", mode: "realtime" };
  const unavailableSteps = samples.filter((sample) => sample.status === "unavailable").length;

  return {
    steps: sizes.length,
    recording: recordingResult,
    resizeElapsedMs,
    elapsedMs: Math.round(performance.now() - startedAt),
    final: sizes[sizes.length - 1],
    baseline,
    samples,
    measurement: {
      passed: baseline.status === "observed"
        && samples.length === sizes.length
        && unavailableSteps === 0,
      unavailableSteps,
    },
  };
}
