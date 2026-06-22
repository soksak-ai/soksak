// 터미널 status 브리지(M5) — 셸 통합 OSC 이벤트(command.started/finished, 폴링 0)에
// status 를 얹는다. paneId → 터미널 뷰(paneToView) → setViewStatus({code:"running", message:명령라인}).
// raw·미통합 셸은 이벤트가 안 와 running 미보고 → 즉시 닫힘(가드 없음, 안전 §13).
import {
  subscribeAnyCommandFinished,
  subscribeAnyCommandStarted,
} from "./paneHosts";
import { paneToView, useSessions } from "../state/sessions";

export function reportTerminalRunning(
  paneId: string,
  commandLine: string,
): void {
  const loc = paneToView(useSessions.getState().tabs, paneId);
  if (loc)
    useSessions.getState().setViewStatus(loc.projectId, loc.viewId, {
      code: "running",
      message: commandLine,
    });
}

export function clearTerminalRunning(paneId: string): void {
  const loc = paneToView(useSessions.getState().tabs, paneId);
  if (loc) useSessions.getState().setViewStatus(loc.projectId, loc.viewId, null);
}

// 부팅 시 1회(main.tsx) — 구독을 status 보고에 연결. 반환=해지.
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
