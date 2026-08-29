import type {
  LayoutTransitionHost,
  PreparedLayoutTransition,
} from "../../lib/layoutTransitionHost";
import {
  restoreNativeSurfacePresentation,
  stageNativeSurfacePresentation,
} from "./nativeSurfaces";

export const wailsLayoutTransitionHost: LayoutTransitionHost = {
  async prepareChange(change, identity): Promise<PreparedLayoutTransition> {
    const visibleViewIds = new Set([
      ...change.panePresentationTargets.map(({ viewId }) => viewId),
      ...change.paneSettlementParticipants.map(({ viewId }) => viewId),
    ]);
    await stageNativeSurfacePresentation(visibleViewIds);
    let closed = false;
    return {
      transactionId: identity.transactionId,
      mode: "glide",
      requiresSharedStart: false,
      stagedTargets: [],
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
