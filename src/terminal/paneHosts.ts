import type { ITheme } from "@xterm/xterm";
import {
  createTerminal,
  type TerminalHandle,
} from "./createTerminal";
import type { TerminalSettings } from "../state/settings";
import {
  registerPtyObservation,
  disposePtyObservation,
  pushObservedCwd,
  pushObservedCommandStart,
  pushObservedCommandFinished,
  pushObservedOutput,
  getObservedCwd as storeGetCwd,
  observedRunningCommands,
  subscribeObservedCwd,
  subscribeObservedCommandFinished,
  subscribeObservedOutput,
  subscribeAnyCommandStarted as storeSubAnyStart,
  subscribeAnyCommandFinished as storeSubAnyFinish,
} from "./ptyObservationStore";

// pane별 호스트 레지스트리. 핵심 불변식: paneId 하나당 호스트 <div> 와 터미널
// (PTY 세션)은 정확히 한 번 생성되고, pane 이 영구히 닫힐 때까지 재사용된다.
//
// 레이아웃이 바뀌면(분할/닫기/탭 전환) React 는 마운트 포인트 div 를 새로 만들지만,
// 여기 캐시된 호스트 div 는 그대로 두고 appendChild 로 옮긴다. appendChild 는 노드를
// 파괴/재생성하지 않고 위치만 이동하므로 canvas·WebGL 컨텍스트·PTY 가 보존된다.

interface PaneHost {
  div: HTMLDivElement;
  // 터미널 생성은 비동기 → 핸들은 준비되면 채워진다(div 는 즉시 존재).
  handle: TerminalHandle | null;
  // 핸들 준비 전 들어온 fit/focus/theme/설정 요청을 준비 직후 적용하기 위한 플래그.
  pendingFocus: boolean;
  pendingTheme: ITheme | null;
  pendingSettings: TerminalSettings | null;
}

const hosts = new Map<string, PaneHost>();

// [substrate 이관] cwd/명령/출력 관찰은 더 이상 paneHosts 의 사적 맵이 아니라 ptyObservationStore
// (범용 PTY substrate)가 단일 진실이다. 코어 터미널 뷰는 그 store 의 한 producer 로서, xterm
// shellIntegration 이 이미 파싱한 이벤트를 push*Observed* 로 store 에 흘린다(아래 getHost 브리지).
// 플러그인 터미널은 app.pty.spawn 이 raw 바이트를 feedPtyOutput 으로 흘린다. 두 경로 모두 같은
// store·같은 구독자를 채우므로, 코어 터미널 뷰가 사라져도 app.terminal.*/command.* 가 계속 동작한다.

/** 모든 pane 의 명령 종료를 구독(turn.ended 본문 enrich — 끝난 명령라인·cwd 동반). 반환=해지.
 *  [위임] substrate store 의 동명 구독으로 forward(코어/플러그인 producer 통합). */
export function subscribeAnyCommandFinished(
  cb: (paneId: string, commandLine?: string | null, cwd?: string | null) => void,
): () => void {
  return storeSubAnyFinish(cb);
}

/** 모든 pane 의 명령 시작을 구독(command.started 중계용). 반환=해지. [위임] substrate store. */
export function subscribeAnyCommandStarted(
  cb: (paneId: string, commandLine: string, cwd: string | null) => void,
): () => void {
  return storeSubAnyStart(cb);
}

/** 지금 실행 중인 모든 명령의 스냅샷. [위임] substrate store(코어+플러그인 통합). */
export function runningCommands(): {
  paneId: string;
  commandLine: string;
  cwd: string | null;
}[] {
  return observedRunningCommands();
}

// App 이 등록하는 "현재 테마" getter. 새 호스트의 최초 createTerminal 에 쓰인다.
let themeProvider: () => ITheme | undefined = () => undefined;

export function setThemeProvider(fn: () => ITheme | undefined): void {
  themeProvider = fn;
}

// App 이 등록하는 "현재 터미널 설정" getter. 새 호스트의 최초 createTerminal 에 쓰인다.
let terminalSettingsProvider: () => TerminalSettings | undefined = () =>
  undefined;

export function setTerminalSettingsProvider(
  fn: () => TerminalSettings | undefined,
): void {
  terminalSettingsProvider = fn;
}

// App 이 등록하는 pane 별 spawn 옵션 getter(프로젝트 root → cwd, 셸, 첫 pane → initialCommand).
let spawnOptionsProvider: (paneId: string) => {
  cwd?: string;
  shell?: string;
  initialCommand?: string;
  pasteCommandOnly?: boolean;
} = () => ({});

export function setSpawnOptionsProvider(
  fn: (paneId: string) => {
    cwd?: string;
    shell?: string;
    initialCommand?: string;
    pasteCommandOnly?: boolean;
  },
): void {
  spawnOptionsProvider = fn;
}

// 살아있는 모든 터미널에 설정 라이브 적용(설정 변경 시). 준비 전이면 pending 으로.
export function applyTerminalSettingsAll(settings: TerminalSettings): void {
  for (const host of hosts.values()) {
    if (host.handle) host.handle.applySettings(settings);
    else host.pendingSettings = settings;
  }
}

/**
 * paneId 의 호스트 div 를 반환한다. 최초 호출 시 div 를 만들고 그 안으로
 * createTerminal 을 한 번 띄운다(비동기). 이후 호출은 항상 같은 div 를 반환한다.
 */
export function getHost(paneId: string): HTMLDivElement {
  const existing = hosts.get(paneId);
  if (existing) return existing.div;

  const div = document.createElement("div");
  div.className = "pane-host";
  div.dataset.paneId = paneId; // 파일 드롭 위치 → pane 역추적용.
  div.style.width = "100%";
  div.style.height = "100%";

  const host: PaneHost = {
    div,
    handle: null,
    pendingFocus: false,
    pendingTheme: null,
    pendingSettings: null,
  };
  hosts.set(paneId, host);
  // 이 pane 의 substrate 관찰을 선등록(구독이 핸들보다 먼저여도 안전). 코어 터미널 뷰는
  // 이 store 의 producer — 아래에서 handle 의 파싱 결과를 push 한다.
  registerPtyObservation(paneId);

  const theme = themeProvider();
  const settings = terminalSettingsProvider();
  const spawn = spawnOptionsProvider(paneId);
  createTerminal(div, {
    ...(theme ? { theme } : {}),
    ...(settings ? { settings } : {}),
    ...(spawn.cwd ? { cwd: spawn.cwd } : {}),
    ...(spawn.shell ? { shell: spawn.shell } : {}),
    ...(spawn.initialCommand ? { initialCommand: spawn.initialCommand } : {}),
    ...(spawn.pasteCommandOnly ? { pasteCommandOnly: true } : {}),
    paneId,
  })
    .then((handle) => {
      // 생성 도중 pane 이 닫혔다면 즉시 폐기.
      if (!hosts.has(paneId)) {
        handle.dispose();
        return;
      }
      host.handle = handle;
      if (host.pendingTheme) handle.setTheme(host.pendingTheme);
      if (host.pendingSettings) handle.applySettings(host.pendingSettings);
      if (host.pendingFocus) {
        handle.focus();
        handle.fit();
      }
      // [substrate producer] xterm shellIntegration 이 이미 파싱한 관찰을 store 로 푸시(raw
      // 재파싱 없이 — 단일 producer 불변식이라 플러그인 경로와 안 겹친다). store 가 cwd/명령/
      // 출력 구독자(app.terminal.*·command.*·idle·status)에 흘린다.
      handle.onCwdChange((c) => pushObservedCwd(paneId, c));
      const cwd = handle.getCwd();
      if (cwd) pushObservedCwd(paneId, cwd);
      handle.onCommandStart((commandLine) =>
        pushObservedCommandStart(paneId, commandLine),
      );
      handle.onCommandFinished(() => pushObservedCommandFinished(paneId));
      handle.onOutput(() => pushObservedOutput(paneId));
    })
    .catch((e) => {
      console.error(`createTerminal failed for pane ${paneId}:`, e);
    });

  return div;
}

/** pane 이 영구히 닫혔을 때만 호출: PTY 종료 + div 제거 + 캐시에서 삭제. */
export function disposeHost(paneId: string): void {
  const host = hosts.get(paneId);
  if (!host) return;
  hosts.delete(paneId);
  disposePtyObservation(paneId); // substrate 관찰(cwd/명령/출력 구독) 회수.
  host.handle?.dispose();
  host.div.remove();
}

/** 살아있는 모든 터미널에 테마 적용(테마 토글). */
export function setThemeAll(theme: ITheme): void {
  for (const host of hosts.values()) {
    if (host.handle) {
      host.handle.setTheme(theme);
    } else {
      host.pendingTheme = theme; // 준비 전이면 생성 직후 적용.
    }
  }
}

/** pane 으로 텍스트 붙여넣기(파일 드래그 경로 주입). 핸들 준비 전이면 무시. */
export function pasteToHost(paneId: string, text: string): void {
  hosts.get(paneId)?.handle?.paste(text);
}

/** pane 의 PTY 에 raw 입력 주입(TUI 키 조작). 준비 전이면 false. */
export function sendInputToHost(paneId: string, data: string): boolean {
  const h = hosts.get(paneId)?.handle;
  if (!h) return false;
  h.sendInput(data);
  return true;
}

/** pane 의 화면+스크롤백 텍스트(끝에서 lines 줄). 준비 전이면 undefined. */
export function readHostBuffer(
  paneId: string,
  lines?: number,
): string | undefined {
  return hosts.get(paneId)?.handle?.readBuffer(lines);
}

/** pane 터미널의 현재 작업 디렉토리(셸 통합 OSC 7/633;P). 미확인이면 undefined.
 *  [위임] substrate store(코어+플러그인 통합 — 코어 뷰 제거 후에도 플러그인 cwd 가 해소된다). */
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

/** pane 에 포커스 + fit. 핸들이 아직 없으면 준비 직후 적용되도록 플래그를 남긴다.
 * [범용 가드] 이 pane 하위에 텍스트 입력(input/textarea/contenteditable — 예: 플러그인
 * 오버레이 입력창)이 포커스면 xterm 으로 포커스를 뺏지 않는다. 호출처(PaneTree·GroupArea
 * 등) 어디서 와도 단일 지점에서 보호 — 입력 중 터미널이 키를 가로채는 것을 막는다. */
export function focusHost(paneId: string): void {
  const host = hosts.get(paneId);
  if (!host) return;
  const a = document.activeElement as HTMLElement | null;
  if (
    a &&
    (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable) &&
    a.closest("[data-pane-id]")?.getAttribute("data-pane-id") === paneId
  ) {
    return;
  }
  if (host.handle) {
    host.handle.focus();
    host.handle.fit();
  } else {
    host.pendingFocus = true;
  }
}

/** appendChild 이동 직후 호출: 부모가 바뀌면 크기를 다시 맞춘다(ResizeObserver 보강). */
export function fitHost(paneId: string): void {
  hosts.get(paneId)?.handle?.fit();
}
