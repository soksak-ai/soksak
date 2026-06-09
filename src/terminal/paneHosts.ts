import type { ITheme } from "@xterm/xterm";
import {
  createTerminal,
  type TerminalHandle,
} from "./createTerminal";

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
  // 핸들 준비 전 들어온 fit/focus/theme 요청을 준비 직후 적용하기 위한 플래그.
  pendingFocus: boolean;
  pendingTheme: ITheme | null;
}

const hosts = new Map<string, PaneHost>();

// App 이 등록하는 "현재 테마" getter. 새 호스트의 최초 createTerminal 에 쓰인다.
let themeProvider: () => ITheme | undefined = () => undefined;

export function setThemeProvider(fn: () => ITheme | undefined): void {
  themeProvider = fn;
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
  div.style.width = "100%";
  div.style.height = "100%";

  const host: PaneHost = {
    div,
    handle: null,
    pendingFocus: false,
    pendingTheme: null,
  };
  hosts.set(paneId, host);

  const theme = themeProvider();
  createTerminal(div, theme ? { theme } : {})
    .then((handle) => {
      // 생성 도중 pane 이 닫혔다면 즉시 폐기.
      if (!hosts.has(paneId)) {
        handle.dispose();
        return;
      }
      host.handle = handle;
      if (host.pendingTheme) handle.setTheme(host.pendingTheme);
      if (host.pendingFocus) {
        handle.focus();
        handle.fit();
      }
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
