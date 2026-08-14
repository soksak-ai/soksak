import type { LayoutPresentationCandidate } from "./layoutPresentationCandidateCoordinator";

/**
 * Public DOM layout transaction for a visible surface outside the document.
 *
 * Core has no reference to surface providers or framework names. The framework composition host
 * dispatches this event at the `data-content-view-body` slot being moved, and the provider that
 * owns that slot claims the transaction. The claiming provider applies the integer rect it received
 * to its own surface after the target DOM commit, and does not settle the Promise until the ACK
 * completes. With no provider the slot is plain DOM, and the existing CSS glide is correct.
 */
export const EXTERNAL_SURFACE_TRANSITION_EVENT =
  "soksak:external-surface-layout-transition" as const;

/**
 * Public DOM slot declaration owned by a provider of a visible surface outside the document.
 *
 * The value is a stable surface identity internal to the provider. Core does not parse the value's
 * syntax or engine; the framework adapter performs only the projection its own compositing needs.
 * A plain-DOM framework has no reason to read this declaration.
 */
export const EXTERNAL_SURFACE_ATTR = "data-external-surface" as const;

export interface ExternalSurfaceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ExternalSurfaceTransitionParticipant {
  /** With no usable shared clock, applies the target rect without animation and ACKs. */
  snap(rect: ExternalSurfaceRect): Promise<void>;
  /** Arms the target model frame under the exact transaction, before the display callback. */
  stage(rect: ExternalSurfaceRect, identity: ExternalSurfaceTransitionIdentity): Promise<void>;
  /** Binds the candidate epoch without releasing the visible surface. */
  armPaused(candidate: LayoutPresentationCandidate): Promise<void>;
  /** Drops a missed candidate and preserves the staged target. */
  disarm(candidate: LayoutPresentationCandidate): Promise<void>;
  /** After global adoption, releases the surface on the same candidate epoch. */
  release(candidate: LayoutPresentationCandidate): Promise<void>;
  /** Restores a partial release failure to the starting frame and preserves the stage. */
  rollback(candidate: LayoutPresentationCandidate): Promise<void>;
  /** After the target DOM commits, applies the external surface frame and waits for the applied ACK. */
  commit(rect: ExternalSurfaceRect): Promise<void>;
  /** Releases the preparation lock when the target is discarded. Does not move the external frame
   *  to an arbitrary position. */
  cancel(): void;
}

export interface ExternalSurfaceTransitionIdentity {
  transactionId: string;
  durationMs: number;
}

export interface ExternalSurfaceTransitionDetail {
  /** Public layout view identity. Not an engine label or a plugin name. */
  viewId: string;
  /** One slot has one owner. A second claim is rejected as a contract violation. */
  claim(participant: ExternalSurfaceTransitionParticipant): void;
}
