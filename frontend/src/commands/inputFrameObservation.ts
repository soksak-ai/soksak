import { createFiniteDomTraceSampler } from "./finiteDomTrace";
import { recordWindowFrames, startWindowRecording, validWindowRecordMaxBytes } from "./windowRecorder";

export type InputFrameObservationParams = {
  recordDir?: unknown; recordFrames?: unknown; recordIntervalMs?: unknown;
  recordLeadMs?: unknown; recordMaxBytes?: unknown; traceAddresses?: unknown;
};

type ResolvedTarget = { address: string; el: Element };

export async function prepareInputFrameObservation(
  params: InputFrameObservationParams,
  resolve: (address: string) => ResolvedTarget | null,
) {
  const recordDir = typeof params.recordDir === "string" && params.recordDir !== "" ? params.recordDir : undefined;
  const frames = params.recordFrames === undefined ? 40 : Number(params.recordFrames);
  const intervalMs = params.recordIntervalMs === undefined ? 16 : Number(params.recordIntervalMs);
  const leadMs = params.recordLeadMs === undefined ? 0 : Number(params.recordLeadMs);
  const maxBytes = params.recordMaxBytes;
  const addresses = params.traceAddresses === undefined ? [] : params.traceAddresses;
  if (recordDir && (!Number.isInteger(frames) || frames < 1 || frames > 600 ||
      !Number.isFinite(intervalMs) || intervalMs < 0 ||
      !Number.isFinite(leadMs) || leadMs < 0 || leadMs > 2000)) {
    throw new Error("recording arguments are outside their finite range");
  }
  if (maxBytes !== undefined && (!recordDir || !validWindowRecordMaxBytes(maxBytes))) {
    throw new Error("recording byte limit is invalid");
  }
  if (!Array.isArray(addresses) || addresses.length > 16 ||
      addresses.some((address) => typeof address !== "string" || address.length === 0) ||
      (addresses.length > 0 && !recordDir)) {
    throw new Error("recording trace addresses are invalid");
  }
  const targets: ResolvedTarget[] = [];
  for (const address of addresses as string[]) {
    const target = resolve(address);
    if (!target) throw new Error("recording address is not exposed: " + address);
    targets.push(target);
  }
  const trace = targets.length > 0 ? createFiniteDomTraceSampler(targets) : null;
  const recording = recordDir ? startWindowRecording({
    dir: recordDir, frames, intervalMs,
    ...(maxBytes === undefined ? {} : { maxBytes: Number(maxBytes) }),
    onFrame: (frame) => trace?.sample(frame),
  }, recordWindowFrames) : null;
  return {
    async ready() {
      const started = await (recording?.ready ?? Promise.resolve(false));
      if (started && leadMs > 0) await new Promise((done) => window.setTimeout(done, leadMs));
    },
    async result() {
      const report = recording ? await recording.report : { status: "not-requested" as const, mode: "realtime" as const };
      const samples = trace?.samples() ?? null;
      return { recording: report, ...(samples === null ? {} : { trace: { frames: samples.length, samples } }) };
    },
  };
}
