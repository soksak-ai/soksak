import { createStream, invoke } from "../framework";
import { tmsg } from "../i18n";
import { noteRecordingFrame } from "../lib/layoutTransitionJournal";

export type WindowRecordRequest = {
  dir: string;
  frames: number;
  intervalMs: number;
  /** Upper bound on total encoded PNG bytes the producer may write. Omitted means no limit. */
  maxBytes?: number;
  /** Finite deadline for waiting on each native frame to complete. */
  frameTimeoutMs?: number;
  /** 0-based number of each captured frame once saved. The shared clock for capture and numeric
   *  observation. */
  onFrame?: (frame: number) => void;
};

/**
 * A recording: the frame count, the readiness of the first frame, and why it stopped.
 *
 * The count alone is what landed on disk, which is not always what was asked for. `stopped`
 * names the difference — a deadline every frame missed, a byte budget, a grab that failed —
 * and without it a short recording and a complete one are one answer (measured 2026-08-16:
 * frameTimeoutMs=1 answered frames 0 with no reason and wrote no directory).
 *
 * Undefined when every requested frame landed. Absent rather than empty, so nothing went wrong
 * is readable without inspecting a string.
 */
export type WindowRecording = Promise<number> & {
  ready: Promise<void>;
  stopped: Promise<string | undefined>;
};

export type WindowRecordingReport =
  | { status: "not-requested"; mode: "realtime" }
  | {
      status: "complete";
      mode: "realtime";
      dir: string;
      requestedFrames: number;
      frames: number;
    }
  | {
      status: "failed";
      mode: "realtime";
      dir: string;
      requestedFrames: number;
      frames: number;
      reason: string;
    };

export type WindowRecorder = (request: WindowRecordRequest) => WindowRecording;

export const WINDOW_RECORD_MAX_BYTES = 1_073_741_824;
export const WINDOW_RECORD_MAX_FRAMES = 600;
export const WINDOW_RECORD_MAX_INTERVAL_MS = 60_000;
export const WINDOW_RECORD_DEFAULT_FRAME_TIMEOUT_MS = 8_000;
export const WINDOW_RECORD_MAX_FRAME_TIMEOUT_MS = 60_000;

export function validWindowRecordMaxBytes(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= 1
    && (value as number) <= WINDOW_RECORD_MAX_BYTES;
}

export function validWindowRecordFrames(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= 1
    && (value as number) <= WINDOW_RECORD_MAX_FRAMES;
}

export function validWindowRecordIntervalMs(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= 0
    && (value as number) <= WINDOW_RECORD_MAX_INTERVAL_MS;
}

export function validWindowRecordFrameTimeoutMs(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= 1
    && (value as number) <= WINDOW_RECORD_MAX_FRAME_TIMEOUT_MS;
}

const recordingFailureReason = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Turns the recorder's start, first save, and completion into one non-rejecting state transaction.
 *
 * Pixel recording is evidence of the product stimulus, not the stimulus itself. On a ready failure
 * the report closes immediately even if the completion Promise never settles, and the late final
 * rejection handler is already attached at start time.
 */
export function startWindowRecording(
  request: WindowRecordRequest,
  recorder: WindowRecorder = recordWindowFrames,
): { ready: Promise<boolean>; report: Promise<WindowRecordingReport> } {
  let savedFrames = 0;
  let frameObservationFailure: string | null = null;
  try {
    const onFrame = request.onFrame;
    const recording = recorder({
      ...request,
      onFrame: (frame) => {
        savedFrames += 1;
        // The clock every journal shares. Kept here rather than at each call site: the command
        // that starts a recording has no layout record in scope, and the state write that opens a
        // record has no recording in scope.
        noteRecordingFrame(frame);
        if (!onFrame) return;
        try {
          onFrame(frame);
        } catch (error) {
          frameObservationFailure ??= recordingFailureReason(error);
        }
      },
    });
    // Even when ready fails first and the report ends early, the late final rejection is already
    // consumed here.
    const completion = Promise.resolve(recording).then(
      (frames) => ({ ok: true as const, frames }),
      (error) => ({ ok: false as const, reason: recordingFailureReason(error) }),
    ).then((outcome) => {
      // Cleared when the burst ends, either way. A record opened after it would otherwise carry the
      // last frame of a recording that is over, which is a number pointing at a picture of an
      // earlier moment — worse than no number, because it looks like one.
      noteRecordingFrame(null);
      return outcome;
    });
    // The final handler is attached first. Even when a bad recorder's ready getter itself throws,
    // the final rejection does not escape as a separate unhandledrejection.
    const ready = recording.ready as unknown;
    if (
      (typeof ready !== "object" && typeof ready !== "function")
      || ready === null
      || typeof (ready as PromiseLike<void>).then !== "function"
    ) {
      throw new Error("recorder.ready must be a Promise");
    }
    const readiness = Promise.resolve(ready as PromiseLike<void>).then(
      () => ({ ok: true as const }),
      (error) => ({ ok: false as const, reason: recordingFailureReason(error) }),
    );
    const failed = (reason: string): WindowRecordingReport => ({
      status: "failed",
      mode: "realtime",
      dir: request.dir,
      requestedFrames: request.frames,
      frames: savedFrames,
      reason,
    });
    const report = readiness.then(async (ready): Promise<WindowRecordingReport> => {
      if (!ready.ok) return failed(ready.reason);
      const finished = await completion;
      if (!finished.ok) return failed(finished.reason);
      if (frameObservationFailure) return failed(frameObservationFailure);
      return {
        status: "complete",
        mode: "realtime",
        dir: request.dir,
        requestedFrames: request.frames,
        frames: finished.frames,
      };
    });
    return { ready: readiness.then((result) => result.ok), report };
  } catch (error) {
    const result: WindowRecordingReport = {
      status: "failed",
      mode: "realtime",
      dir: request.dir,
      requestedFrames: request.frames,
      frames: savedFrames,
      reason: recordingFailureReason(error),
    };
    return { ready: Promise.resolve(false), report: Promise.resolve(result) };
  }
}

/**
 * Framework-neutral window recording policy.
 *
 * The shell provides only one frame's pixels. Frame count, interval, and file names must be owned by
 * the shared command layer so Electron and Tauri answer the same automation contract. Runs only the
 * finite number of times the caller set; never waits on state, never retries.
 */
export function recordWindowFrames({
  dir,
  frames,
  intervalMs,
  maxBytes,
  frameTimeoutMs = WINDOW_RECORD_DEFAULT_FRAME_TIMEOUT_MS,
  onFrame,
}: WindowRecordRequest): WindowRecording {
  if (!validWindowRecordFrames(frames)) {
    throw new Error(tmsg("msg.window.record.framesRange", { max: WINDOW_RECORD_MAX_FRAMES }));
  }
  if (!validWindowRecordIntervalMs(intervalMs)) {
    throw new Error(tmsg("msg.window.record.intervalRange", { max: WINDOW_RECORD_MAX_INTERVAL_MS }));
  }
  if (maxBytes !== undefined && !validWindowRecordMaxBytes(maxBytes)) {
    throw new Error(tmsg("msg.window.record.maxBytesRange", { max: WINDOW_RECORD_MAX_BYTES }));
  }
  if (!validWindowRecordFrameTimeoutMs(frameTimeoutMs)) {
    throw new Error(
      `frameTimeoutMs must be between 1 and ${WINDOW_RECORD_MAX_FRAME_TIMEOUT_MS}`,
    );
  }
  const frameEvents = createStream<number>();
  let settled = false;
  let resolveReady!: () => void;
  let rejectReady!: (reason: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Existing callers that consume only the completion Promise still do not leave a separate
  // readiness rejection unhandled. The same Promise object is kept, so a caller waiting on readiness
  // still receives that error.
  ready.catch(() => {});
  frameEvents.onmessage = (frame) => {
    onFrame?.(frame);
    if (!settled) {
      settled = true;
      resolveReady();
    }
  };
  // The host's own recording. It invoked a command of the preceding implementation's plugin, which
  // this host never served, so every recording answered INTERNAL and no frame was ever written
  // (measured 2026-08-16). The frame count that comes back is what landed on disk, which is not
  // always what was asked for — the report names why when they differ.
  const finished = invoke<{ frames: number; stopped?: string }>("window_record", {
    dir,
    frames,
    intervalMs,
    ...(maxBytes === undefined ? {} : { maxBytes }),
    frameTimeoutMs,
    onFrame: frameEvents,
    // The rejection consumer is attached to the producer itself, before the count is read off the
    // report. Reading first puts a promise in between, and the readiness rejection then arrives at
    // a handler nobody installed — an unhandledrejection instead of a recording that failed.
  }).catch((error) => {
    if (!settled) {
      settled = true;
      rejectReady(error);
    }
    throw error;
  });
  // Some diagnostic commands start the recorder, wait until the stimulus time, then await final. To
  // keep a producer failure in that window from becoming an unhandledrejection, the original final
  // is kept and only a rejection consumer is attached immediately.
  finished.catch(() => {});
  // The caller's value is the frame count, and the count is what landed on disk. `stopped` on the
  // report names why that differs from what was asked for.
  const counted = finished.then((report) => report.frames);
  counted.catch(() => {});
  const stopped = finished.then((report) => report.stopped);
  stopped.catch(() => {});
  return Object.assign(counted, { ready, stopped });
}
