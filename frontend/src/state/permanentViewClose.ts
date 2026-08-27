import { closeMountedView } from "../plugins/viewFocus";
import { useSessions } from "./sessions";

export async function closeViewPermanently(projectId: string, viewId: string) {
  await closeMountedView(viewId);
  return useSessions.getState().closeView(projectId, viewId);
}
