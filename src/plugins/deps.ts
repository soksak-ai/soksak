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
    // fs-change(코어 watcher, 폴링 없음) 구독 → 변경된 부모 디렉토리 문자열을 콜백.
    // 반환 = 해지. listen 은 async 라 비동기 도착하면 즉시 연결(중간 해지도 처리).
    onFsChange: (cb) => {
      let un = () => {};
      let disposed = false;
      void listen<string>("fs-change", (e) => cb(e.payload)).then((u) => {
        if (disposed) u();
        else un = u;
      });
      return () => {
        disposed = true;
        un();
      };
    },
    // data-change(Rust DbState 변경) 전 창 구독 — app.data.watch 의 크로스윈도우 채널.
    // 전역 listen(@tauri-apps/api/event)이라 어느 창의 변경이든 모든 창이 받는다(같은 프로젝트 일관).
    onDataChange: (cb) => {
      let un = () => {};
      let disposed = false;
      void listen<DataChangeEvent>("data-change", (e) => cb(e.payload)).then((u) => {
        if (disposed) u();
        else un = u;
      });
      return () => {
        disposed = true;
        un();
      };
    },
    // clipboard-change(코어 네이티브 watcher — Win/X11/Wayland 이벤트, macOS changeCount 폴링)
    // 전 창 구독 → 바뀐 텍스트를 콜백. onFsChange 와 동형(async 도착/중간해지 가드).
    onClipboardChange: (cb) => {
      let un = () => {};
      let disposed = false;
      void listen<string>("clipboard-change", (e) => cb(e.payload)).then((u) => {
        if (disposed) u();
        else un = u;
      });
      return () => {
        disposed = true;
        un();
      };
    },
    // 터미널 pane cwd 스냅샷/구독 + 명령 종료 구독 — 코어 paneHosts 브리지(app.terminal 노출).
    getCwd: (paneId) => getCwdOfHost(paneId),
    subscribeCwd: (paneId, cb) => subscribeCwd(paneId, cb),
    subscribeCommandFinished: (paneId, cb) => subscribeCommandFinished(paneId, cb),
  };
}
