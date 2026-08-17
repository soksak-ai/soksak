// Where a native surface is, read from both clocks at one instant.
//
// The measuring is `lib/layoutAlignment`, so the one-instant reading and the per-frame trace cannot
// disagree about what `off` means. This is the command that answers it once.
import { key, tmsg } from "../i18n";
import { readAlignment } from "../lib/layoutAlignment";
import { layoutTrace, startLayoutTrace, stopLayoutTrace } from "../lib/layoutTrace";
import { presentationNowUnixMs } from "../lib/presentationClock";
import { register } from "./registry";

export function registerLayoutAlignmentCatalog(): void {
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
    returns: "{ ms, frames }",
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

  register("layout.trace.read", {
    description: key("cmd.layout.trace.read.desc"),
    triggers: { ko: "레이아웃 추적 읽기 프레임 기록 조회" },
    params: {},
    returns: "{ running, startedAtUnixMs, frames: [{ frame, atUnixMs, appliedAgeMs, regions, panes, surfaces, worstOff, worstLag, worstDrift, worstOver }] }",
    message: (d) =>
      tmsg("msg.layout.trace.read", { n: Number((d.frames as unknown[] | undefined)?.length ?? 0) }),
    examples: ["layout.trace.read"],
    handler: () => {
      stopLayoutTrace();
      return layoutTrace();
    },
  });
}
