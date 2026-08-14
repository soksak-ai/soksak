import { flushSync } from "react-dom";

/**
 * Finishes a layout state write and its React DOM commit as one transaction.
 *
 * A layout-motion end consumer reads the slot rect as final right after the call. A plain store
 * flush settles state only and can leave the concurrent React DOM behind, so use this boundary
 * ahead of the end event.
 */
export function commitDomLayout(commit: () => void): void {
  flushSync(commit);
}
