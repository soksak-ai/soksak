// Terminal status bridge (M5) — maps shell-integration OSC events (command.started/finished, zero
// polling) onto view status. paneId → terminal view (locateTab) → setViewStatus({code:"running",
// message: command line}). A raw or unintegrated shell emits no events, so running is never reported
// and close is immediate (no guard, safety §13).
import {
  subscribeAnyCommandFinished,
  subscribeAnyCommandStarted,
} from "./ptyBridge";
import { locateTab, useSessions } from "../state/sessions";

export function reportTerminalRunning(
  paneId: string,
  commandLine: string,
): void {
  const loc = locateTab(useSessions.getState().workspaces, paneId);
  if (loc)
    useSessions.getState().setViewStatus(loc.projectId, loc.viewId, {
      code: "running",
      message: commandLine,
    });
}

export function clearTerminalRunning(paneId: string): void {
  const loc = locateTab(useSessions.getState().workspaces, paneId);
  if (loc) useSessions.getState().setViewStatus(loc.projectId, loc.viewId, null);
}

// Called once at boot (main.tsx) — wires the subscriptions to status reporting. Return value = unsubscribe.
export function startTerminalStatusBridge(): () => void {
  const off1 = subscribeAnyCommandStarted((paneId, commandLine) =>
    reportTerminalRunning(paneId, commandLine),
  );
  const off2 = subscribeAnyCommandFinished((paneId) =>
    clearTerminalRunning(paneId),
  );
  return () => {
    off1();
    off2();
  };
}
