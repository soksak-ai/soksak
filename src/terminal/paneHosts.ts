// PTY substrate 관찰 브리지 — 코어 터미널 뷰(host-div)는 제거됐고(터미널도 플러그인 뷰),
// 이 모듈은 ptyObservationStore(범용 PTY substrate)의 cwd/명령/출력 구독을 이름으로 노출하는
// 얇은 위임층만 남는다. 플러그인 터미널(app.pty.spawn → registerPtyIo/feedPtyOutput)이 store 의
// producer 이고, app.terminal.*·command.*·idle·status 소비자가 여기 함수로 그 store 를 읽는다.
//
// [history] 과거엔 paneHosts 가 코어 터미널 뷰의 host-div·xterm 인스턴스를 사적 맵으로 들고
// 직접 구동했다. 그 view 가 플러그인으로 이관되며 host-div 기계는 전부 제거됐다.

import {
  observedRunningCommands,
  getObservedCwd as storeGetCwd,
  subscribeObservedCwd,
  subscribeObservedCommandFinished,
  subscribeObservedOutput,
  subscribeAnyCommandStarted as storeSubAnyStart,
  subscribeAnyCommandFinished as storeSubAnyFinish,
} from "./ptyObservationStore";

/** 모든 pane 의 명령 종료를 구독(turn.ended 본문 enrich — 끝난 명령라인·cwd 동반). 반환=해지.
 *  [위임] substrate store 의 동명 구독으로 forward(플러그인 터미널 producer). */
export function subscribeAnyCommandFinished(
  cb: (paneId: string, commandLine?: string | null, cwd?: string | null, exitCode?: number) => void,
): () => void {
  return storeSubAnyFinish(cb);
}

/** 모든 pane 의 명령 시작을 구독(command.started 중계용). 반환=해지. [위임] substrate store. */
export function subscribeAnyCommandStarted(
  cb: (paneId: string, commandLine: string, cwd: string | null) => void,
): () => void {
  return storeSubAnyStart(cb);
}

/** 지금 실행 중인 모든 명령의 스냅샷. [위임] substrate store. */
export function runningCommands(): {
  paneId: string;
  commandLine: string;
  cwd: string | null;
}[] {
  return observedRunningCommands();
}

/** pane 터미널의 현재 작업 디렉토리(셸 통합 OSC 7/633;P). 미확인이면 undefined.
 *  [위임] substrate store(플러그인 터미널 cwd 해소). */
export function getCwdOfHost(paneId: string): string | undefined {
  return storeGetCwd(paneId);
}

/** pane 의 cwd 변경을 구독(폴링 없음). 현재값이 있으면 등록 즉시 1회. 반환=해지.
 *  [위임] substrate store — 핸들 준비 전 구독해도 안전(선등록된 빈 관찰). */
export function subscribeCwd(
  paneId: string,
  cb: (cwd: string) => void,
): () => void {
  return subscribeObservedCwd(paneId, cb);
}

/** pane 의 명령 종료(OSC 133/633 D)를 구독(폴링 없음). 반환=해지. [위임] substrate store. */
export function subscribeCommandFinished(
  paneId: string,
  cb: () => void,
): () => void {
  return subscribeObservedCommandFinished(paneId, cb);
}

/** pane 터미널의 출력 변경(화면 갱신)을 구독(폴링 없음). 반환=해지. [위임] substrate store.
 *  플러그인이 라이브 스트림 표시·입력 landed 검증(버퍼 재독 트리거)에 쓰는 범용 신호. */
export function subscribeOutput(paneId: string, cb: () => void): () => void {
  return subscribeObservedOutput(paneId, cb);
}
