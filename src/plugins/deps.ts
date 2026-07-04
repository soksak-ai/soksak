// 플러그인 API 의 프로덕션 의존성 배선 — api.ts 의 PluginApiDeps 구현.
// (테스트는 가짜 deps 를 주입 — 이 파일은 실제 registry/store/bridge 연결만 담당.)

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  execute,
  getSpec,
  register,
  unregister,
} from "../commands/registry";
import { useSessions } from "../state/sessions";
import {
  getCwdOfHost,
  subscribeCwd,
  subscribeCommandFinished,
} from "../terminal/paneHosts";
import { onPluginEvent } from "./hooks";
import type { DataChangeEvent, PluginApiDeps } from "./api";

// Tauri listen 을 즉시 해지 가능한 구독으로 감싼다. listen 은 async 라 해지가 도착 전에 올 수
// 있고(중간 해지), 이미 해제된 리스너를 다시 해지하면(HMR 모듈 폐기·중복 dispose) Tauri 내부
// 맵 접근이 TypeError 로 reject 된다 — un() 을 try/catch 로 가드해 무해한 no-op 으로 만든다.
function subscribe<T>(event: string, onPayload: (payload: T) => void): () => void {
  let un = () => {};
  let disposed = false;
  const safeUnlisten = (u: () => void) => {
    try {
      u();
    } catch {
      // 이미 해제된 리스너(Tauri 내부 맵 소거) — 재해지는 no-op.
    }
  };
  void listen<T>(event, (e) => onPayload(e.payload)).then((u) => {
    if (disposed) safeUnlisten(u);
    else un = () => safeUnlisten(u);
  });
  return () => {
    disposed = true;
    un();
    un = () => {};
  };
}

export function defaultPluginDeps(appVersion: string): PluginApiDeps {
  return {
    appVersion,
    invoke: (cmd, args) => invoke(cmd, args),
    execute,
    registerCommand: register,
    unregisterCommand: unregister,
    getCommandDanger: (name) => getSpec(name)?.danger,
    on: onPluginEvent,
    currentProject: () => {
      const s = useSessions.getState();
      const project = s.tabs.find((t) => t.id === s.activeId);
      return project ? { id: project.id, root: project.root ?? null } : null;
    },
    // fs-change(코어 watcher, 폴링 없음) 구독 → 변경된 부모 디렉토리 문자열을 콜백. 반환 = 해지.
    onFsChange: (cb) => subscribe<string>("fs-change", cb),
    // data-change(Rust DbState 변경) 전 창 구독 — app.data.watch 의 크로스윈도우 채널. 전역
    // listen(@tauri-apps/api/event)이라 어느 창의 변경이든 모든 창이 받는다(같은 프로젝트 일관).
    onDataChange: (cb) => subscribe<DataChangeEvent>("data-change", cb),
    // clipboard-change(코어 네이티브 watcher — Win/X11/Wayland 이벤트, macOS changeCount 폴링)
    // 전 창 구독 → 바뀐 텍스트를 콜백.
    onClipboardChange: (cb) => subscribe<string>("clipboard-change", cb),
    // 터미널 pane cwd 스냅샷/구독 + 명령 종료 구독 — 코어 paneHosts 브리지(app.terminal 노출).
    getCwd: (paneId) => getCwdOfHost(paneId),
    subscribeCwd: (paneId, cb) => subscribeCwd(paneId, cb),
    subscribeCommandFinished: (paneId, cb) => subscribeCommandFinished(paneId, cb),
    // webview 이벤트(코어가 browser.rs 에서 emit 하는 `browser-<event>`) label 필터 구독 —
    // app.webview.on 노출. event 는 "nav"|"title"|"status"|"open-external".
    subscribeWebview: (label, event, cb) =>
      subscribe<{ label: string } & Record<string, unknown>>(`browser-${event}`, (p) => {
        if (p.label === label) cb(p);
      }),
  };
}
