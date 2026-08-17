// Where a native surface is, read from both clocks at one instant.
//
// The measuring is `lib/layoutAlignment`, so the one-instant reading and the per-frame trace cannot
// disagree about what `off` means. This is the command that answers it once.
import { tmsg } from "../i18n";
import { readAlignment } from "../lib/layoutAlignment";
import { layoutTrace, startLayoutTrace, stopLayoutTrace } from "../lib/layoutTrace";
import { presentationNowUnixMs } from "../lib/presentationClock";
import { register } from "./registry";

export function registerLayoutAlignmentCatalog(): void {
  register("layout.alignment", {
    description:
      "Where every native surface and every region is, at one instant. Per surface: dom = the declaring element's box now, declared = the box the last commit sent, applied = the box the native layer holds, lag = dom vs declared, drift = declared vs applied, off = dom vs applied. regions and panes are the boxes those surfaces sit beside, read in the same pass — two readings a frame apart cannot tell a window mid-motion from a window that is wrong. off is what a person sees as a page drawn away from its pane; a composition reading alone cannot state it, because declared and applied agree with each other while both are stale.",
    triggers: { ko: "레이아웃 정렬 좌표 어긋남 리전 패널 페이지 위치 비교" },
    params: {},
    returns:
      "{ worstOff, worstLag, worstDrift, sampledAtUnixMs, surfaces: [{ id, dom, declared, applied, lag, drift, off, visible }], regions: [{ region, x, w }], panes: [{ pane, x, w }] }",
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
    description:
      "Record the alignment of every region, pane and native surface once per animation frame, inside the window, for ms milliseconds (max 10000). A reading taken through the plane costs a round trip and misses frames; this misses none. The answer waits for the first frame and refuses if the window is not drawing — a covered window with occlusion detection on records nothing. Read it back with layout.trace.read. Starting discards whatever the last trace held.",
    triggers: { ko: "레이아웃 추적 시작 프레임 기록 모션 관측" },
    params: {
      ms: { type: "number", description: "How long to record (1..10000)", required: true },
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
    description:
      "What the trace recorded, one entry per animation frame: the regions, the panes, and every surface's dom / declared / applied boxes with lag, drift and off. appliedAgeMs is how old the native half of that frame is: the time since the commit that carried it was answered. No round trip is made for it, so that age is the pipeline's own latency rather than the reading's. Stops a running trace.",
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
