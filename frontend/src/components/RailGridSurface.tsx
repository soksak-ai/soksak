import {
  forwardRef,
  useImperativeHandle,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import { railTravelDeclaredMs } from "../lib/railMotion";
import {
  presentationDocumentTimeFromWallBridgeUnixUs,
  presentationNowUnixUs,
} from "../lib/presentationClock";
import {
  LayoutPresentationParticipantArmFailure,
  type LayoutPresentationCandidateParticipant,
} from "../lib/layoutPresentationCandidateCoordinator";
import { beginLayoutDecorationClearance } from "../lib/layoutDecorationClearance";

const sameDocumentTimelineMicrosecond = (actual: CSSNumberish | null, expected: number) => (
  typeof actual === "number"
  && Number.isSafeInteger(Math.round(actual * 1_000))
  && Math.round(actual * 1_000) === Math.round(expected * 1_000)
);

export interface RailGridSurfaceHandle {
  candidateParticipant: LayoutPresentationCandidateParticipant;
}

/**
 * Coordinate system of the panel grid a content tab selects.
 * The rail occupies this surface only, not the tab chrome.
 */
export const RailGridSurface = forwardRef<RailGridSurfaceHandle, {
  children: ReactNode;
  railPlane: ReactNode;
  relationOverlay?: ReactNode;
  traveling?: boolean;
  starting?: boolean;
}>(function RailGridSurface({
  children,
  railPlane,
  relationOverlay,
  traveling = false,
  starting = false,
}, ref) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => ({
    candidateParticipant: {
      id: "dom-layout",
      async prepare(transactionId) {
        const surfaceAtPrepare = surfaceRef.current;
        const railAtPrepare = surfaceAtPrepare?.querySelector<HTMLElement>(".sidebar[data-rail-role]") ?? null;
        // The handle keeps its identity across the mount, so it does not capture the render prop. When the
        // real DOM inventory at transaction prepare time has no rail, ACK that removal frame.
        const clearance = surfaceAtPrepare && !railAtPrepare
          ? beginLayoutDecorationClearance(transactionId)
          : null;
        const cancelClearance = () => {
          clearance?.cancel();
        };
        let armedAnimations: Animation[] = [];
        let armedCandidate: import("../lib/layoutPresentationCandidateCoordinator").LayoutPresentationCandidate
          | null = null;
        const candidateMatches = (
          candidate: import("../lib/layoutPresentationCandidateCoordinator").LayoutPresentationCandidate,
        ) => armedCandidate?.transactionId === candidate.transactionId
          && armedCandidate.sourceGeneration === candidate.sourceGeneration
          && armedCandidate.frameSequence === candidate.frameSequence
          && armedCandidate.startAtUnixUs === candidate.startAtUnixUs
          && armedCandidate.durationMs === candidate.durationMs;
        return {
          id: "dom-layout",
          transactionId,
          async arm(candidate) {
            const surface = surfaceRef.current;
            if (!surface || !surface.classList.contains("rail-starting")) {
              throw new Error(`DOM layout candidate is not paused: ${transactionId}`);
            }
            if (candidate.transactionId !== transactionId) {
              throw new Error(`DOM layout candidate identity changed: ${transactionId}`);
            }
            if (clearance) {
              const rail = surface.querySelector<HTMLElement>(".sidebar[data-rail-role]");
              const receipt = clearance.publishFrame(
                rail?.dataset.railRole ?? "absent",
                rail ? getComputedStyle(rail).visibility : "absent",
              );
              if (receipt.status !== "cleared") {
                const error = new Error(`DOM decoration was not cleared: ${transactionId}`);
                clearance.fail(error.message);
                throw error;
              }
            }
            const animations = surface.getAnimations({ subtree: true }).filter((animation) => (
              (animation as CSSAnimation).animationName === "rail-flip-x"
            ));
            if (animations.length === 0) {
              throw new Error(`DOM layout candidate animations are empty: ${transactionId}`);
            }
            const observedAtUnixUs = presentationNowUnixUs();
            const remainingLeadMs = (candidate.startAtUnixUs - observedAtUnixUs) / 1_000;
            const startTime = presentationDocumentTimeFromWallBridgeUnixUs(
              candidate.documentTimelineBridge.startAtUnixUs,
            );
            for (const animation of animations) animation.startTime = startTime;
            if (animations.some((animation) => !sameDocumentTimelineMicrosecond(animation.startTime, startTime))) {
              throw new LayoutPresentationParticipantArmFailure(
                `DOM layout candidate arm was not exact: ${transactionId}`,
                {
                  kind: "dom-animation-arm",
                  expectedDocumentStartTime: startTime,
                  observedAtUnixUs,
                  remainingLeadMs,
                  animations: animations.map((animation) => ({
                    animationName: (animation as CSSAnimation).animationName,
                    startTime: typeof animation.startTime === "number" ? animation.startTime : null,
                    currentTime: typeof animation.currentTime === "number" ? animation.currentTime : null,
                    playState: animation.playState,
                  })),
                },
              );
            }
            armedAnimations = animations;
            armedCandidate = { ...candidate };
          },
          disarm(candidate) {
            if (!candidateMatches(candidate)) return;
            for (const animation of armedAnimations) animation.startTime = null;
            armedAnimations = [];
            armedCandidate = null;
          },
          async release(candidate) {
            if (!candidateMatches(candidate) || armedAnimations.length === 0) {
              throw new Error(`DOM layout candidate release identity changed: ${transactionId}`);
            }
            const startTime = presentationDocumentTimeFromWallBridgeUnixUs(
              candidate.documentTimelineBridge.startAtUnixUs,
            );
            // play() on a paused animation recomputes startTime while aligning hold time to the current
            // document timeline. So the future epoch used at arm must be reapplied after play with the same
            // transaction receipt. Reversing the order starts the DOM from the release moment instead.
            for (const animation of armedAnimations) {
              animation.play();
              animation.startTime = startTime;
            }
            if (armedAnimations.some((animation) => !sameDocumentTimelineMicrosecond(animation.startTime, startTime))) {
              throw new LayoutPresentationParticipantArmFailure(
                `DOM layout candidate release was not exact: ${transactionId}`,
                {
                  kind: "dom-animation-release",
                  expectedDocumentStartTime: startTime,
                  animations: armedAnimations.map((animation) => ({
                    animationName: (animation as CSSAnimation).animationName,
                    startTime: typeof animation.startTime === "number" ? animation.startTime : null,
                    currentTime: typeof animation.currentTime === "number" ? animation.currentTime : null,
                    playState: animation.playState,
                  })),
                },
              );
            }
          },
          async rollback(candidate) {
            if (!candidateMatches(candidate)) return;
            for (const animation of armedAnimations) {
              animation.pause();
              animation.startTime = null;
            }
            armedAnimations = [];
            armedCandidate = null;
          },
          cancel() {
            cancelClearance();
            for (const animation of armedAnimations) {
              animation.pause();
              animation.startTime = null;
            }
            armedAnimations = [];
            armedCandidate = null;
          },
        };
      },
    },
  }), []);
  return (
    <div
      // Old name kept alongside — the commands layer reads the travel phase via `.content-body.rail-traveling`.
      // Removal condition: once that selector in catalogDom moves to `.space-body`, drop the second token.
      className={`space-body content-body${traveling ? " rail-traveling" : ""}${starting ? " rail-starting" : ""}`}
      ref={surfaceRef}
      // The declaration is the bare length — do not multiply the factor here. The single axis for slow
      // motion is Web Animations playbackRate, which already stretches this transition. Multiplying the
      // declaration too slows the screen by the square of the factor while the JS timer that closes the
      // phase multiplies once, so the phase ends when the move is only a few % in and the layers split and
      // jump(real incident: at 20x it slowed, cut off and reverted).
      style={{ "--rail-travel-ms": `${railTravelDeclaredMs()}ms` } as CSSProperties}
    >
      {children}
      {railPlane}
      {relationOverlay}
    </div>
  );
});
