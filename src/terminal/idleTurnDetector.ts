// 출력 유휴 휴리스틱 turn.ended provider(코어, 기본 OFF). 명령이 실행 중인 pane 의 PTY 출력을
// 구독해, 출력 버스트 후 N ms 무출력이면 "턴 종료"로 추정한다(대화형 agent 가 출력 후 입력 대기).
// 폴링 아님(출력 이벤트 디바운스). 오탐 가능(느린 스트리머·TUI 리드로) → opt-in(turn.idleDetection
// 커맨드로 켬). 메일함 self-subscribe 의 idle 소스가 이걸 켠다(코어는 메일함을 모름 — 커맨드로 결합 0).

import {
  subscribeAnyCommandStarted,
  subscribeAnyCommandFinished,
  subscribeOutput,
} from "./paneHosts";

export interface IdleTurnPayload {
  projectId: string | null;
  root: string | null;
  paneId: string | null;
  source: "idle";
}

let emitFn: ((p: IdleTurnPayload) => void) | null = null;
let projectInfoOf: (paneId: string) => { id: string; root: string | null } | null = () => null;
let idleMs = 2000;
let active: { dispose: () => void } | null = null;

// 1회 배선(startPluginHooks) — emit/projectInfo 주입(순환 import 회피). 시작 전엔 무동작.
export function configureIdleTurnDetector(deps: {
  emit: (p: IdleTurnPayload) => void;
  projectInfoOf: (paneId: string) => { id: string; root: string | null } | null;
}): void {
  emitFn = deps.emit;
  projectInfoOf = deps.projectInfoOf;
}

export function isIdleTurnDetectionOn(): boolean {
  return active !== null;
}

export function idleTurnMs(): number {
  return idleMs;
}

// 토글 — enabled=true 면 감지 시작(이미 켜져 있으면 ms 만 갱신), false 면 정지·정리. 멱등.
export function setIdleTurnDetection(enabled: boolean, ms?: number): void {
  if (typeof ms === "number" && ms > 0) idleMs = Math.max(250, ms);
  if (enabled) {
    if (!active) active = startDetector();
  } else if (active) {
    active.dispose();
    active = null;
  }
}

function startDetector(): { dispose: () => void } {
  // pane 별 출력 구독 + 디바운스 타이머. 명령 시작 시 부착, 종료 시 해제.
  const perPane = new Map<
    string,
    { unOut: () => void; timer: ReturnType<typeof setTimeout> | null }
  >();

  const arm = (paneId: string) => {
    const e = perPane.get(paneId);
    if (!e) return;
    if (e.timer) clearTimeout(e.timer);
    e.timer = setTimeout(() => {
      const info = projectInfoOf(paneId);
      emitFn?.({
        projectId: info?.id ?? null,
        root: info?.root ?? null,
        paneId,
        source: "idle",
      });
    }, idleMs);
  };

  const detach = (paneId: string) => {
    const e = perPane.get(paneId);
    if (!e) return;
    e.unOut();
    if (e.timer) clearTimeout(e.timer);
    perPane.delete(paneId);
  };

  // 명령 시작 → 그 pane 출력 모니터 시작(첫 출력 후부터 타이머 — 출력 없는 즉시 오탐 방지).
  const unStart = subscribeAnyCommandStarted((paneId) => {
    if (perPane.has(paneId)) return;
    const unOut = subscribeOutput(paneId, () => arm(paneId));
    perPane.set(paneId, { unOut, timer: null });
  });
  // 명령 종료 → 모니터 해제(턴 단위가 아니라 프로그램 종료 — command.finished 가 shell 소스로 별도 발화).
  const unFinish = subscribeAnyCommandFinished((paneId) => detach(paneId));

  return {
    dispose: () => {
      unStart();
      unFinish();
      for (const paneId of [...perPane.keys()]) detach(paneId);
    },
  };
}

// 테스트용 — 전체 초기화.
export function resetIdleTurnDetectorForTest(): void {
  if (active) {
    active.dispose();
    active = null;
  }
  emitFn = null;
  projectInfoOf = () => null;
  idleMs = 2000;
}
