// Composition participant declaration — **the shape in which participants drawing one content view
// together state themselves**.
//
// The judgment enumerates three ledgers separately: the slot, the carrier (renderer) that fills
// it, and the live surface. Without separate counts a missing surface hides behind the paired
// result — a judgment that passes when one of them is gone is no judgment.
//
// The only thread tying the three to the same view is the topology path. So there must be exactly
// one site that builds that address: rewriting the same rule at two sites diverges silently the
// day one of them changes, and that divergence shows up as "participant not found", not
// "composition mismatch".
//
// **The core fixes the shape; the framework fixes what a participant is.** A framework whose
// content is outside the document stamps the band it projected; one whose content is inside the
// document stamps the slot and the tag within it. The core makes no distinction — it reads only
// the stamped declaration.

/** Kinds of participant observable in the document. A surface is a receipt from the host, not a DOM kind. */
export type CompositionParticipantKind = "slot" | "renderer";

const KINDS: readonly CompositionParticipantKind[] = ["slot", "renderer"];

export interface CompositionParticipant {
  kind: CompositionParticipantKind;
  /** The view this participant draws. The value the public anchor answers with, never inferred from label. */
  viewId: string;
  /** Topology path shared by every participant of the same view. */
  topologyPath: string;
  /** Whether it takes part in composition right now. Coordinates or the previous frame's state never answer in its place. */
  visible: boolean;
}

export const COMPOSITION_KIND_ATTR = "data-composition-kind";

/** Selector for participants of that kind — the name is never rebuilt as a string. */
export function compositionParticipantSelector(kind: CompositionParticipantKind): string {
  return `[${COMPOSITION_KIND_ATTR}=${kind}]`;
}

/**
 * Topology path of one content surface.
 *
 * Each segment is encoded so a separator inside a value cannot split the address — without it one
 * label adds an extra address segment and two views end up with the same address.
 */
export function contentCompositionTopologyPath(
  windowLabel: string,
  viewId: string,
  label: string,
): string {
  return `window/${encodeURIComponent(windowLabel)}`
    + `/view/${encodeURIComponent(viewId)}`
    + `/content/${encodeURIComponent(label)}`;
}

/**
 * Public node path of the content carrier — a participant not discoverable by address cannot be
 * counted by the ledger.
 *
 * The address grammar accepts lowercase letters, digits, dots and hyphens only. Other characters
 * are folded to hyphens to build the address; when two folded labels land on one path, the
 * duplicate report from ui.tree surfaces that fact.
 */
export function contentViewNodePath(label: string): string {
  const folded = label.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^[^a-z0-9]+/, "");
  return `content-view/${folded.length > 0 ? folded : "unnamed"}`;
}

/** The view this participant draws — the tab instance back-reference anchor (canonical) answers. */
export function compositionOwnerViewId(el: HTMLElement): string | null {
  return el.closest<HTMLElement>("[data-tab-id]")?.dataset.tabId ?? null;
}

export function declareCompositionParticipant(
  el: HTMLElement,
  participant: CompositionParticipant,
): void {
  el.setAttribute(COMPOSITION_KIND_ATTR, participant.kind);
  el.dataset.viewId = participant.viewId;
  el.dataset.topologyPath = participant.topologyPath;
  el.dataset.visible = String(participant.visible);
}

/** Updates visibility only — rewriting the identity axes silently reassigns the participant to another view. */
export function setCompositionParticipantVisible(el: HTMLElement, visible: boolean): void {
  if (!el.hasAttribute(COMPOSITION_KIND_ATTR)) return;
  el.dataset.visible = String(visible);
}

/** Clears the declaration — a dead participant left in the ledger makes the judgment wait for a surface that is gone. */
export function clearCompositionParticipant(el: HTMLElement): void {
  el.removeAttribute(COMPOSITION_KIND_ATTR);
  delete el.dataset.viewId;
  delete el.dataset.topologyPath;
  delete el.dataset.visible;
}

/**
 * Reads the stamped declaration. **An empty axis means it is not a participant** — filling a half
 * declaration with defaults makes the ledger count it as live, and the missing axis appears as a
 * normal value instead of an error.
 */
export function readCompositionParticipant(el: HTMLElement): CompositionParticipant | null {
  const kind = el.getAttribute(COMPOSITION_KIND_ATTR);
  const viewId = el.dataset.viewId;
  const topologyPath = el.dataset.topologyPath;
  const visible = el.dataset.visible;
  if (!KINDS.includes(kind as CompositionParticipantKind)) return null;
  if (!viewId || !topologyPath) return null;
  if (visible !== "true" && visible !== "false") return null;
  return {
    kind: kind as CompositionParticipantKind,
    viewId,
    topologyPath,
    visible: visible === "true",
  };
}
