import type { ITheme } from "@xterm/xterm";
import {
  createTerminal,
  type TerminalHandle,
} from "./createTerminal";
import type { TerminalSettings } from "../state/settings";

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

// paneId 별 cwd 변경 구독자(호스트 존재와 독립). 사이드바가 폴링 없이 cwd 를 따라가는
// 통로. 호스트의 터미널이 준비되면 handle.onCwdChange 를 이 셋으로 브리지한다.
const cwdSubs = new Map<string, Set<(cwd: string) => void>>();

// paneId 별 명령 종료 구독자(git 상태 등 갱신 트리거). 위와 동일한 브리지 구조.
const cmdSubs = new Map<string, Set<() => void>>();

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

// App 이 등록하는 pane 별 spawn 옵션 getter(프로젝트 root → cwd, 첫 pane → initialCommand).
let spawnOptionsProvider: (paneId: string) => {
  cwd?: string;
  initialCommand?: string;
} = () => ({});

export function setSpawnOptionsProvider(
  fn: (paneId: string) => { cwd?: string; initialCommand?: string },
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

  const theme = themeProvider();
  const settings = terminalSettingsProvider();
  const spawn = spawnOptionsProvider(paneId);
  createTerminal(div, {
    ...(theme ? { theme } : {}),
    ...(settings ? { settings } : {}),
    ...(spawn.cwd ? { cwd: spawn.cwd } : {}),
    ...(spawn.initialCommand ? { initialCommand: spawn.initialCommand } : {}),
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
      // cwd 이벤트를 paneId 구독 셋으로 브리지 + 현재값 즉시 통지.
      handle.onCwdChange((c) => cwdSubs.get(paneId)?.forEach((cb) => cb(c)));
      const cwd = handle.getCwd();
      if (cwd) cwdSubs.get(paneId)?.forEach((cb) => cb(cwd));
      // 명령 종료 이벤트 브리지.
      handle.onCommandFinished(() =>
        cmdSubs.get(paneId)?.forEach((cb) => cb()),
      );
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
  cwdSubs.delete(paneId);
  cmdSubs.delete(paneId);
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

/** pane 터미널의 현재 작업 디렉토리(셸 통합 OSC 7/633;P). 미확인이면 undefined. */
export function getCwdOfHost(paneId: string): string | undefined {
  return hosts.get(paneId)?.handle?.getCwd();
}

/**
 * pane 의 cwd 변경을 구독(폴링 없음). 등록 즉시 현재값이 있으면 한 번 호출하고,
 * 이후 OSC 7/633;P 로 cwd 가 바뀔 때마다 호출한다. 반환=해지 함수.
 * 핸들이 아직 준비 전이어도 안전 — 준비되면 getHost 가 현재값을 통지한다.
 */
export function subscribeCwd(
  paneId: string,
  cb: (cwd: string) => void,
): () => void {
  let set = cwdSubs.get(paneId);
  if (!set) {
    set = new Set();
    cwdSubs.set(paneId, set);
  }
  set.add(cb);
  const cur = hosts.get(paneId)?.handle?.getCwd();
  if (cur) cb(cur);
  return () => {
    set?.delete(cb);
  };
}

/** pane 의 명령 종료(OSC 133/633 D)를 구독(폴링 없음). 반환=해지. */
export function subscribeCommandFinished(
  paneId: string,
  cb: () => void,
): () => void {
  let set = cmdSubs.get(paneId);
  if (!set) {
    set = new Set();
    cmdSubs.set(paneId, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
  };
}

/** pane 에 포커스 + fit. 핸들이 아직 없으면 준비 직후 적용되도록 플래그를 남긴다. */
export function focusHost(paneId: string): void {
  const host = hosts.get(paneId);
  if (!host) return;
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
