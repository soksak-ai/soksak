// PTY 관찰 store — paneId(문자열) 키로 cwd/명령 시작·종료/출력 관찰을 모은다.
//
// [원칙] 관찰은 터미널-프로토콜 레벨 = 범용 substrate(누구든 app.pty 를 구동하는 쪽)가 채운다.
// 코어 터미널 뷰의 paneHosts 가 사적으로 들고 있던 cwd/명령/출력 구독을 여기로 옮겨, 코어 뷰가
// 사라져도(플러그인 터미널만 남아도) app.terminal.* + command.*/turn.ended + idle/status 가
// 계속 동작하게 한다. 키는 app.terminal.* / 파일트리 / sok CLI 가 쓰는 그 paneId(문자열).
//
// [단일 producer 불변식 — 이중 발화 방지] 하나의 paneId 는 정확히 한 PTY producer 가 채운다:
//   - 코어 터미널 뷰: paneHosts.getHost 가 그 pane 의 PTY 출력을 feedPtyOutput 으로 흘린다.
//   - 플러그인 터미널: app.pty.spawn 이 그 pane 의 PTY 출력을 feedPtyOutput 으로 흘린다.
// 같은 paneId 를 두 producer 가 동시에 쓰는 일이 없으므로 OSC 가 한 번만 파싱된다(중복 emit 0).

import {
  createPtyObservationParser,
  type PtyObservationParser,
} from "./ptyObservation";

// PTY-driver 가 등록하는 IO 핸들러(GAP2) — 화면 버퍼 읽기 + PTY 입력 쓰기. 코어 호스트도
// 플러그인 터미널도 같은 paneId 키로 등록한다. app.terminal.readBuffer/sendText 가 이걸 우선 쓴다
// (코어 paneHosts host-div 비의존 — 코어 터미널 뷰 제거 후에도 플러그인 터미널에 닿는다).
export interface PtyIo {
  readBuffer: (lines?: number) => string;
  sendInput: (data: string) => void;
}

interface PaneObservation {
  parser: PtyObservationParser;
  cwd: string | undefined;
  running: { commandLine: string; cwd: string | null } | null;
  cwdSubs: Set<(cwd: string) => void>;
  cmdFinishedSubs: Set<() => void>;
  outputSubs: Set<() => void>;
  // 이 pane 을 구동하는 PTY-driver 의 IO 핸들러(등록되면). 없으면 undefined.
  io?: PtyIo;
}

const panes = new Map<string, PaneObservation>();

// 전역(어느 pane 이든) 명령 시작/종료 구독자 — 플러그인 이벤트(command.started/finished,
// turn.ended) 중계용. 끝난 명령라인·cwd 도 함께 전달(turn.ended 본문 enrich).
const anyCmdStartSubs = new Set<
  (paneId: string, commandLine: string, cwd: string | null) => void
>();
const anyCmdFinishedSubs = new Set<
  (paneId: string, commandLine?: string | null, cwd?: string | null, exitCode?: number) => void
>();

/**
 * paneId 의 관찰을 시작한다(PTY spawn 시 1회). 멱등 — 이미 있으면 기존 것을 유지.
 * 이후 feedPtyOutput(paneId, …) 로 출력을 먹이면 OSC 가 파싱되어 구독자에 흐른다.
 */
export function registerPtyObservation(paneId: string): void {
  if (panes.has(paneId)) return;
  const obs: PaneObservation = {
    parser: undefined as unknown as PtyObservationParser,
    cwd: undefined,
    running: null,
    cwdSubs: new Set(),
    cmdFinishedSubs: new Set(),
    outputSubs: new Set(),
  };
  obs.parser = createPtyObservationParser({
    onCwd: (c) => {
      obs.cwd = c;
      for (const cb of [...obs.cwdSubs]) cb(c);
    },
    onCommandStart: (commandLine) => {
      obs.running = { commandLine, cwd: obs.cwd ?? null };
      for (const cb of [...anyCmdStartSubs])
        cb(paneId, commandLine, obs.cwd ?? null);
    },
    onCommandFinished: (exitCode) => {
      // 삭제 직전 끝난 명령 캡처 → turn.ended 본문이 "어떤 명령이 끝났는지 + 종료코드(R2)" 를 담는다.
      // D(종료 마크)는 방출기(shell-integration.zsh)가 C(실행)와 짝일 때만 낸다 — 파서는
      // wire 를 신뢰한다(§5는 방출기에 새겨져 있다: 시작 없는 종료는 방출되지 않는다).
      const fin = obs.running;
      obs.running = null;
      for (const cb of [...obs.cmdFinishedSubs]) cb();
      for (const cb of [...anyCmdFinishedSubs])
        cb(paneId, fin?.commandLine ?? null, fin?.cwd ?? null, exitCode);
    },
  });
  panes.set(paneId, obs);
}

// 전 pane 출력 활동 sink(B3) — hooks 가 주입해 lastActivity 를 기록한다(스로틀은 주입측 소유).
// pane별 구독(subscribeObservedOutput)과 달리 pane 열거 없이 전 출력을 한 곳에서 본다.
let anyOutputSink: ((paneId: string) => void) | null = null;
export function setAnyOutputSink(cb: ((paneId: string) => void) | null): void {
  anyOutputSink = cb;
}

/** PTY 출력 청크를 그 paneId 의 관찰 파서에 먹인다 + output 구독자 통지. 미등록이면 no-op. */
export function feedPtyOutput(paneId: string, chunk: string | Uint8Array): void {
  const obs = panes.get(paneId);
  if (!obs) return;
  obs.parser.write(chunk);
  if (obs.outputSubs.size) for (const cb of [...obs.outputSubs]) cb();
  anyOutputSink?.(paneId);
}

// ── 이미-파싱된 관찰 푸시(코어 터미널 뷰 producer 경로) ──────────────────────────
// 코어 터미널 뷰는 xterm shellIntegration 으로 이미 OSC 를 파싱한다 → 그 결과를 raw 바이트
// 재파싱 없이 store 에 직접 푸시한다. 같은 paneId 는 한 producer 만 채우므로(단일 producer
// 불변식) 플러그인 경로의 feedPtyOutput 과 절대 겹치지 않는다 — 이중 발화 0.

/** 코어 producer: cwd 변경 푸시(실제 변경 시에만 통지). */
export function pushObservedCwd(paneId: string, cwd: string): void {
  const obs = panes.get(paneId);
  if (!obs || !cwd || cwd === obs.cwd) return;
  obs.cwd = cwd;
  for (const cb of [...obs.cwdSubs]) cb(cwd);
}

/** 코어 producer: 명령 시작 푸시(명령라인 동반 — 전역 구독자 통지 + running 갱신). */
export function pushObservedCommandStart(paneId: string, commandLine: string): void {
  const obs = panes.get(paneId);
  if (!obs) return;
  obs.running = { commandLine, cwd: obs.cwd ?? null };
  for (const cb of [...anyCmdStartSubs]) cb(paneId, commandLine, obs.cwd ?? null);
}

/** 코어 producer: 명령 종료 푸시(pane + 전역 구독자, 끝난 명령라인·cwd·exitCode(R2) 동반, running clear). */
export function pushObservedCommandFinished(paneId: string, exitCode?: number): void {
  const obs = panes.get(paneId);
  if (!obs) return;
  const fin = obs.running;
  obs.running = null;
  for (const cb of [...obs.cmdFinishedSubs]) cb();
  for (const cb of [...anyCmdFinishedSubs])
    cb(paneId, fin?.commandLine ?? null, fin?.cwd ?? null, exitCode);
}

/** 코어 producer: 출력 변경 푸시(화면 갱신 통지 — 라이브 스트림·입력 검증용). */
export function pushObservedOutput(paneId: string): void {
  const obs = panes.get(paneId);
  if (!obs || !obs.outputSubs.size) return;
  for (const cb of [...obs.outputSubs]) cb();
}

/** pane 의 관찰 종료(PTY close / pane 영구 닫힘). cwd 스냅샷·구독 전부 회수. */
export function disposePtyObservation(paneId: string): void {
  const obs = panes.get(paneId);
  if (!obs) return;
  obs.cwdSubs.clear();
  obs.cmdFinishedSubs.clear();
  obs.outputSubs.clear();
  panes.delete(paneId);
}

/** pane 의 현재 cwd 스냅샷(셸 통합 전이면 undefined). */
export function getObservedCwd(paneId: string): string | undefined {
  return panes.get(paneId)?.cwd;
}

/** 이 id 가 PTY substrate 를 구동하는가(터미널 generic 신호 — pluginId 무관). 등록된 관찰이
 *  있으면 true. 파일트리 cwdPaneOf 가 코어/플러그인 터미널을 구분 없이 따라가는 데 쓴다. */
export function hasPtyObservation(paneId: string): boolean {
  return panes.has(paneId);
}

/** PTY-driver(코어 호스트/플러그인 터미널)가 이 paneId 의 IO 핸들러를 등록(GAP2). 관찰이
 *  아직 없으면 함께 선등록(멱등). 반환=해지(등록 해제). app.terminal.readBuffer/sendText 우선 경로. */
export function registerPtyIo(paneId: string, io: PtyIo): () => void {
  registerPtyObservation(paneId); // 관찰 선등록(구독·IO 가 spawn 보다 먼저여도 안전)
  const obs = panes.get(paneId)!;
  obs.io = io;
  return () => {
    const cur = panes.get(paneId);
    if (cur && cur.io === io) cur.io = undefined;
  };
}

/** 이 paneId 의 등록된 IO 핸들러(없으면 undefined). app.terminal.readBuffer/sendText 가 조회. */
export function getPtyIo(paneId: string): PtyIo | undefined {
  return panes.get(paneId)?.io;
}

/** 지금 실행 중인 모든 명령 스냅샷(pane 당 최대 1). */
export function observedRunningCommands(): {
  paneId: string;
  commandLine: string;
  cwd: string | null;
}[] {
  const out: { paneId: string; commandLine: string; cwd: string | null }[] = [];
  for (const [paneId, obs] of panes) {
    if (obs.running)
      out.push({ paneId, commandLine: obs.running.commandLine, cwd: obs.running.cwd });
  }
  return out;
}

/** pane cwd 변경 구독(폴링 없음). 현재값이 있으면 등록 즉시 1회. 반환=해지. */
export function subscribeObservedCwd(
  paneId: string,
  cb: (cwd: string) => void,
): () => void {
  registerPtyObservation(paneId); // 구독이 spawn 보다 먼저여도 안전(빈 관찰 선등록)
  const obs = panes.get(paneId)!;
  obs.cwdSubs.add(cb);
  if (obs.cwd) cb(obs.cwd);
  return () => {
    obs.cwdSubs.delete(cb);
  };
}

/** pane 명령 종료(OSC 133/633 D) 구독(폴링 없음). 반환=해지. */
export function subscribeObservedCommandFinished(
  paneId: string,
  cb: () => void,
): () => void {
  registerPtyObservation(paneId);
  const obs = panes.get(paneId)!;
  obs.cmdFinishedSubs.add(cb);
  return () => {
    obs.cmdFinishedSubs.delete(cb);
  };
}

/** pane 출력 변경(화면 갱신) 구독(폴링 없음). 반환=해지. 라이브 스트림·입력 landed 검증용. */
export function subscribeObservedOutput(
  paneId: string,
  cb: () => void,
): () => void {
  registerPtyObservation(paneId);
  const obs = panes.get(paneId)!;
  obs.outputSubs.add(cb);
  return () => {
    obs.outputSubs.delete(cb);
  };
}

/** 모든 pane 의 명령 시작 구독(플러그인 command.started 중계용). 반환=해지. */
export function subscribeAnyCommandStarted(
  cb: (paneId: string, commandLine: string, cwd: string | null) => void,
): () => void {
  anyCmdStartSubs.add(cb);
  return () => {
    anyCmdStartSubs.delete(cb);
  };
}

/** 모든 pane 의 명령 종료 구독(command.finished/turn.ended 중계용). 끝난 명령라인·cwd 동반. 반환=해지. */
export function subscribeAnyCommandFinished(
  cb: (paneId: string, commandLine?: string | null, cwd?: string | null, exitCode?: number) => void,
): () => void {
  anyCmdFinishedSubs.add(cb);
  return () => {
    anyCmdFinishedSubs.delete(cb);
  };
}

// 테스트용 — 전체 초기화.
export function resetPtyObservationStoreForTest(): void {
  panes.clear();
  anyCmdStartSubs.clear();
  anyCmdFinishedSubs.clear();
}
