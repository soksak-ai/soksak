import { tmsg } from "../i18n";
import { PRESENTATION_CLOCK, presentationNowUnixMs } from "../lib/presentationClock";
import { register } from "./registry";

/** One public owner for renderer/control-plane presentation acknowledgements. */
export function registerPresentationClockCatalog(): void {
  // Catalog boot fixes the one core control-clock origin before any later WebKit wall-clock
  // correction can change `performance.timeOrigin`.
  presentationNowUnixMs();
  register("presentation.clock.acknowledge", {
    description:
      "Acknowledge a caller-owned presentation correlation on the core renderer's stable control clock. Call immediately after a producer arm/checkpoint resolves; producer timestamps remain on their own clock and are never relabeled.",
    params: {
      traceId: {
        type: "string",
        description: tmsg("cmd.presentation.clock.acknowledge.param.traceId"),
        required: true,
      },
    },
    returns: "{ traceId, clock, atUnixMs }",
    message: (data) => tmsg("msg.presentation.clock.acknowledge", { traceId: String(data.traceId) }),
    examples: ["presentation.clock.acknowledge '{\"traceId\":\"gate-b05/left\"}'"],
    handler: (params) => {
      const traceId = String(params.traceId ?? "").trim();
      if (!traceId) throw new Error("presentation acknowledgement needs a traceId");
      return { traceId, clock: PRESENTATION_CLOCK, atUnixMs: presentationNowUnixMs() };
    },
  });
}
