import { invoke } from "../framework";
import { lastAppliedSurfaces } from "../lib/contentViews";
import { parkedPicture } from "../lib/parkedPicture";
import { surfaceLabelOfView } from "../lib/surfaceLabels";
import { startWindowRecording } from "./windowRecorder";
import {
  classifySwitchFrames,
  classifySwitchMotion,
  classifySwitchPresentation,
  type SwitchPresentationSample,
  type SwitchViewPresentation,
} from "./switchScan";
import { motionJourneys } from "../lib/motionDebug";

export type SwitchScanRegion = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

export type SwitchScanLayoutTransaction = {
  transactionId: string;
  sequence: number;
  phase: "committed";
  mode: "glide" | "snap";
};

export type SwitchScanActivationReceipt = {
  changed: true;
  layoutMoved: boolean;
  presentation: {
    kind: "space" | "tab";
    id: string;
    phase: "presentation-settled";
  };
  transaction: SwitchScanLayoutTransaction | null;
};

type AnalyzeReport = {
  frames: number;
  regions: Array<{
    name: string;
    frames: Array<{ frame: number; changed?: number }>;
  }>;
};

function nodeFor(viewId: string, suffix = ""): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-node="layout/${suffix}${viewId}"]`,
  );
}

function sampleView(viewId: string): SwitchViewPresentation {
  const node = nodeFor(viewId, "tab/");
  const label = surfaceLabelOfView(viewId);
  const applied = label === null
    ? null
    : lastAppliedSurfaces().surfaces.find((surface) => surface.id === label) ?? null;
  return {
    native: label !== null,
    contentVisible: node?.dataset.contentVisible === "true",
    surfaceVisible: node?.dataset.surfaceVisible === "true",
    liveSurfaceVisible: applied?.visible === true,
    parkedPictureVisible: nodeFor(viewId, "parked-picture/") !== null
      && parkedPicture(viewId) !== null,
  };
}

function sampleSide(viewIds: readonly string[]): SwitchViewPresentation[] {
  return viewIds.map(sampleView);
}

export async function runSwitchScan(input: {
  dir: string;
  frames: number;
  intervalMs: number;
  applyAtFrame: number;
  region: SwitchScanRegion;
  threshold: number;
  fromViews: readonly string[];
  toViews: readonly string[];
  activate: () => Promise<SwitchScanActivationReceipt>;
}): Promise<{
  frames: number;
  frameMs: number;
  switchFrame: number;
  switchFrames: number;
  flickerFrames: number;
  blankFrames: number[];
  overlapFrames: number[];
  nativeMismatchFrames: number[];
  motion: ReturnType<typeof classifySwitchMotion>;
  clean: boolean;
  diffsPct: number[];
  presentationFrames: SwitchPresentationSample[];
  activation: SwitchScanActivationReceipt;
  recordingDir: string;
}> {
  const samples: SwitchPresentationSample[] = [];
  const motionStartedAt = performance.now();
  const activation = { current: null as Promise<
    { ok: true; activation: SwitchScanActivationReceipt }
    | { ok: false; error: unknown }
  > | null };
  const startedAt = performance.now();
  const recording = startWindowRecording({
    dir: input.dir,
    frames: input.frames,
    intervalMs: input.intervalMs,
    onFrame: (frame) => {
      samples.push({
        frame,
        from: sampleSide(input.fromViews),
        to: sampleSide(input.toViews),
      });
      if (frame === input.applyAtFrame) {
        activation.current = input.activate().then(
          (receipt) => ({ ok: true as const, activation: receipt }),
          (error) => ({ ok: false as const, error }),
        );
      }
    },
  });
  const ready = await recording.ready;
  if (!ready) throw new Error("switch recording did not save its first frame");
  const report = await recording.report;
  if (report.status !== "complete" || report.frames !== input.frames) {
    throw new Error(
      report.status === "failed"
        ? `switch recording failed: ${report.reason}`
        : `switch recording incomplete: ${report.status}`,
    );
  }
  const pendingActivation = activation.current;
  if (pendingActivation === null) {
    throw new Error(`switch activation frame was not recorded: ${input.applyAtFrame}`);
  }
  const activationResult = await pendingActivation;
  if (!activationResult.ok) throw activationResult.error;

  const analyzed = await invoke<AnalyzeReport>("capture_analyze", {
    dir: input.dir,
    regions: [{
      name: "switch-content",
      x: input.region.x0,
      y: input.region.y0,
      width: input.region.x1 - input.region.x0,
      height: input.region.y1 - input.region.y0,
    }],
  });
  const series = analyzed.regions.find((region) => region.name === "switch-content");
  if (!series || analyzed.frames !== input.frames) {
    throw new Error("switch frame analysis is incomplete");
  }
  const diffs = series.frames.map((frame) => frame.changed ?? 0);
  const pixels = classifySwitchFrames(diffs, input.threshold);
  const presentation = classifySwitchPresentation(samples);
  const activationReceipt = activationResult.activation;
  const motion = classifySwitchMotion(
    motionJourneys().filter(({ startedAt }) => startedAt >= motionStartedAt),
    activationReceipt.layoutMoved && activationReceipt.transaction?.mode === "glide",
  );
  const pixelVerdictApplies = !activationReceipt.layoutMoved
    || activationReceipt.transaction?.mode === "snap";
  return {
    frames: report.frames,
    frameMs: Math.round((performance.now() - startedAt) / report.frames),
    switchFrame: pixels.switchFrame,
    switchFrames: pixels.switchFrames,
    flickerFrames: pixelVerdictApplies
      ? pixels.flickerFrames
      : motion.cancelled.length + motion.incomplete.length,
    blankFrames: presentation.blankFrames,
    overlapFrames: presentation.overlapFrames,
    nativeMismatchFrames: presentation.nativeMismatchFrames,
    motion,
    clean: presentation.clean && motion.clean && (!pixelVerdictApplies || pixels.clean),
    diffsPct: diffs.map((value) => +(value * 100).toFixed(1)),
    presentationFrames: samples,
    activation: activationReceipt,
    recordingDir: input.dir,
  };
}
