// Where a native surface is, read from both clocks at one instant.
//
// The measuring is `lib/layoutAlignment`, so the one-instant reading and the per-frame trace cannot
// disagree about what `off` means. This is the command that answers it once.
import { key, tmsg } from "../i18n";
import { readAlignment } from "../lib/layoutAlignment";
import { layoutTrace, startLayoutTrace, whenLayoutTraceEnds } from "../lib/layoutTrace";
import { presentationNowUnixMs } from "../lib/presentationClock";
import { nativeTimelineVerdict, type TimelineNativeSample } from "../lib/nativeTimelineVerdict";
import { invoke, nativeDecorationStatus } from "../framework";
import { nativeDecorationFacts } from "../lib/nativeDecorations";
import * as CompositorService from "../../bindings/github.com/soksak-ai/soksak-core/frameworks/wails/nativepresentationservice";
import { currentWindowLabel } from "../lib/webviewLabels";
import { register } from "./registry";

export function registerLayoutAlignmentCatalog(): void {
  register("surface.composition", {
    description: key("cmd.surface.composition.desc"),
    triggers: { ko: "네이티브 표면 합성 현재 적용 선언 좌표 판정" },
    params: {},
    returns: "{ sequence, appliedAtUnixMs, interactive, coordinates:'css-top-left', nativeParentPresent, worst, displaced, surfaces:[{id,declared,applied,drift,worst}], unapplied, undeclared, misparented, failure? }",
    message: (d) => tmsg("msg.surface.composition", { worst: Number(d.worst ?? 0) }),
    examples: ["surface.composition"],
    handler: () => invoke("surface.composition"),
  });

  register("surface.decorations", {
    description: key("cmd.surface.decorations.desc"),
    triggers: { ko: "네이티브 포커스 관계 보더 최상단 장식" },
    params: {},
    returns: "{ window, sequence, count, supported, layer, declarations:[{id,path,strokeWidth,dash}] }",
    message: (data) => tmsg("msg.surface.decorations", {
      n: Number(data.count ?? 0), layer: String(data.layer ?? ""),
    }),
    examples: ["surface.decorations"],
    handler: async () => ({
      ...(await nativeDecorationStatus()),
      declarations: nativeDecorationFacts().decorations.map((decoration) => ({
        id: decoration.id,
        path: decoration.path,
        strokeWidth: decoration.strokeWidth,
        dash: decoration.dash,
      })),
    }),
  });

  register("surface.composition.history", {
    description: key("cmd.surface.composition.history.desc"),
    triggers: { ko: "네이티브 표면 합성 적용 이력 타임라인 시각" },
    params: {
      sinceUnixMs: {
        type: "number",
        description: key("cmd.surface.composition.history.param.sinceUnixMs"),
        required: true,
      },
    },
    returns: "[{ sequence, appliedAtUnixMs, interactive, surfaces:[{id,declared,applied,drift,worst}], ... }] — the retained baseline immediately before sinceUnixMs, then every Apply at or after it; exact timestamp starts there",
    message: (d) => tmsg("msg.surface.composition.history", {
      n: Number((d as unknown as { length?: number }).length ?? 0),
    }),
    errors: ["INVALID_PARAMS"],
    examples: ["surface.composition.history sinceUnixMs=1787125000000"],
    handler: async (p) => {
      const sinceUnixMs = Number(p.sinceUnixMs);
      if (!Number.isFinite(sinceUnixMs)) {
        return { ok: false as const, code: "INVALID_PARAMS" as const,
          message: tmsg("msg.surface.composition.history.since") };
      }
      return CompositorService.History(currentWindowLabel(), sinceUnixMs);
    },
  });

  register("layout.alignment", {
    description: key("cmd.layout.alignment.desc"),
    triggers: { ko: "레이아웃 정렬 좌표 어긋남 리전 패널 페이지 위치 비교" },
    params: {},
    returns:
      "{ worstOff, worstLag, worstDrift, sampledAtUnixMs, surfaces: [{ id, dom, declared, applied, lag, drift, off, visible }], regions: [{ region, x, w }], sections: [{ region, section }], panes: [{ pane, x, w }] }",
    examples: ["layout.alignment"],
    message: (d) =>
      tmsg("msg.layout.alignment", {
        off: Number(d.worstOff ?? 0),
        lag: Number(d.worstLag ?? 0),
        drift: Number(d.worstDrift ?? 0),
      }),
    handler: async () => {
      const sampledAtUnixMs = presentationNowUnixMs();
      const alignment = await readAlignment();
      return { sampledAtUnixMs, ...alignment };
    },
  });
}

/** The trace: what every frame held, rather than what one sample caught.
 *
 * A reading through the plane costs a round trip and a frame costs 16.7ms, so a one-frame
 * disagreement between a pane and its page lands in one sample or two by chance. Recorded inside the
 * window, every frame is written down and the verdict is counted in frames. */
export function registerLayoutTraceCatalog(): void {
  register("layout.trace.start", {
    description: key("cmd.layout.trace.start.desc"),
    triggers: { ko: "레이아웃 추적 시작 프레임 기록 모션 관측" },
    params: {
      ms: { type: "number", description: key("cmd.layout.trace.start.param.ms"), required: true },
    },
    returns: "{ ms, frames, run } — run names this recording, and layout.trace.wait waits for the end of it",
    message: (d) => tmsg("msg.layout.trace.start", { ms: Number(d.ms ?? 0) }),
    examples: ['layout.trace.start \'{"ms":2000}\''],
    handler: async (p) => {
      try {
        return await startLayoutTrace(Number(p.ms));
      } catch (cause) {
        // The reason travels. A refusal that answers INTERNAL with no words sends its reader to
        // read the source of a command that already knew what was wrong.
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: String(cause) };
      }
    },
  });

  register("layout.trace.wait", {
    description: key("cmd.layout.trace.wait.desc"),
    triggers: { ko: "레이아웃 추적 종료 대기 녹화 완료 이벤트" },
    params: {
      run: { type: "number", description: key("cmd.layout.trace.wait.param.run"), required: true },
      timeoutMs: {
        type: "number",
        description: key("cmd.layout.trace.wait.param.timeoutMs"),
        required: true,
      },
    },
    returns: "{ run, endedBecause:'elapsed'|'stopped'|'replaced', frames }",
    message: (d) => tmsg("msg.layout.trace.wait", { how: String(d.endedBecause ?? "") }),
    errors: ["INVALID_PARAMS", "TIMEOUT"],
    examples: ['layout.trace.wait \'{"run":1,"timeoutMs":5000}\''],
    handler: async (p) => {
      const run = Number(p.run);
      const timeoutMs = Number(p.timeoutMs);
      if (!Number.isInteger(run) || run < 1) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.trace.run") };
      }
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.trace.timeout") };
      }
      try {
        const endedBecause = await whenLayoutTraceEnds(run, timeoutMs);
        return { run, endedBecause, frames: layoutTrace().frames.length };
      } catch (cause) {
        return { ok: false as const, code: "TIMEOUT" as const, message: String(cause) };
      }
    },
  });

  register("layout.trace.read", {
    description: key("cmd.layout.trace.read.desc"),
    triggers: { ko: "레이아웃 추적 읽기 프레임 기록 조회" },
    params: {},
    returns: "{ running, run, endedBecause:''|'elapsed'|'stopped'|'replaced', startedAtUnixMs, frames: [{ frame, atUnixMs, appliedAgeMs, interactive, regions, panes, surfaces:[{dom,declared,applied,settled}], worstOff, worstLag, worstDrift, worstOver }] } — reading does not stop a running recording, so two reads of a finished one answer the same thing",
    message: (d) =>
      tmsg("msg.layout.trace.read", { n: Number((d.frames as unknown[] | undefined)?.length ?? 0) }),
    examples: ["layout.trace.read"],
    handler: () => {
      // Reading does not stop it. A read that ended the recording made the answer depend on when it
      // was asked and made a second read a different answer — wait for the end with
      // layout.trace.wait, which is announced rather than looked for.
      return layoutTrace();
    },
  });

  register("layout.trace.native", {
    description: key("cmd.layout.trace.native.desc"),
    triggers: { ko: "네이티브 합성 추적 판정 DOM 적용 시각 위치 결합" },
    params: {
      tolerance: {
        type: "number",
        description: key("cmd.layout.trace.native.param.tolerance"),
        default: 0,
      },
    },
    returns: "{ comparedFrames, unmatchedFrames, wrongFrames, worstOff, longestWrongMs, maxAppliedAgeMs, nativeSamples, tolerance } — drawn DOM frames joined to the latest compositor Apply at or before that frame",
    message: (d) => tmsg("msg.layout.trace.native", {
      off: Number(d.worstOff ?? 0),
      wrong: Number(d.wrongFrames ?? 0),
    }),
    errors: ["INVALID_PARAMS"],
    examples: ["layout.trace.native", "layout.trace.native tolerance=0.5"],
    handler: async (p) => {
      const tolerance = p.tolerance === undefined ? 0 : Number(p.tolerance);
      if (!Number.isFinite(tolerance) || tolerance < 0) {
        return { ok: false as const, code: "INVALID_PARAMS" as const,
          message: tmsg("msg.layout.trace.native.tolerance") };
      }
      const trace = layoutTrace();
      if (trace.frames.length === 0) {
        return { ok: false as const, code: "INVALID_PARAMS" as const,
          message: tmsg("msg.layout.trace.native.empty") };
      }
      const history = await CompositorService.History(currentWindowLabel(), trace.startedAtUnixMs);
      const native: TimelineNativeSample[] = history.map((sample) => ({
        appliedAtUnixMs: sample.appliedAtUnixMs,
        surfaces: sample.surfaces.map((surface) => ({
          id: surface.id,
          appliedVisible: surface.appliedVisible,
          applied: {
            x: surface.applied.x,
            y: surface.applied.y,
            w: surface.applied.width,
            h: surface.applied.height,
          },
        })),
      }));
      return { ...nativeTimelineVerdict(trace.frames, native, tolerance), tolerance };
    },
  });
}
