import { invoke } from "../framework";
import { closeMountedView } from "../plugins/viewFocus";
import { useSessions } from "./sessions";

// Ending the sessions on one view, before it leaves the layout.
//
// The core resolves which sessions those are: it holds the index that records where each session
// was last shown, so a view whose body was never mounted and a view already out of the tree are
// both covered. Asking the mounted view instead would reach neither.
//
// Ordered before the view leaves the layout, so the index still names the view. An owner that
// refuses is reported rather than swallowed, and the view closes all the same — the person closed
// it, and the owner does not decide that.
export async function endSessionsOnView(viewId: string) {
  await closeMountedView(viewId);
  try {
    await invoke("session_close", { view: viewId });
  } catch (error) {
    console.error(`closing the sessions on view ${viewId}`, error);
  }
}

// Closing a view for good, as opposed to a window closing or a space being switched away from.
export async function closeViewPermanently(projectId: string, viewId: string) {
  await endSessionsOnView(viewId);
  return useSessions.getState().closeView(projectId, viewId);
}
