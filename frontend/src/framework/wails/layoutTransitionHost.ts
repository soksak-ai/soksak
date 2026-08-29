import type {
  LayoutTransitionHost,
  PreparedLayoutTransition,
} from "../../lib/layoutTransitionHost";
import {
  restoreNativeSurfacePresentation,
  stageNativeSurfacePresentation,
} from "./nativeSurfaces";
import { presentationNowUnixMs } from "../../lib/presentationClock";

export const wailsLayoutTransitionHost: LayoutTransitionHost = {
  async prepareChange(change, identity): Promise<PreparedLayoutTransition> {
    const visibleViewIds = new Set([
      ...change.panePresentationTargets.map(({ viewId }) => viewId),
      ...change.paneSettlementParticipants.map(({ viewId }) => viewId),
    ]);
    const startedAtUnixMs = presentationNowUnixMs();
    const stage = await stageNativeSurfacePresentation(visibleViewIds);
    const completedAtUnixMs = presentationNowUnixMs();
    let closed = false;
    return {
      transactionId: identity.transactionId,
      mode: "glide",
      requiresSharedStart: false,
      stagedTargets: [],
      preparation: {
        producer: "layout-adapter",
        clock: "unix-anchored-monotonic",
        stages: [{
          id: "native-presentation",
          startedAtUnixMs,
          completedAtUnixMs,
          status: "prepared",
          data: stage,
        }],
      },
      start: async () => null,
      commit: async () => {
        closed = true;
      },
      cancel: () => {
        if (closed) return;
        closed = true;
        void restoreNativeSurfacePresentation().catch((error) => {
          console.error("native presentation restore failed", error);
        });
      },
    };
  },
};
