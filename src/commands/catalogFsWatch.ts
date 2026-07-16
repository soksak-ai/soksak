// fs.watch/fs.unwatch — generic 경로 감시 커맨드(코어는 경로만 알고 내용을 모른다, W8 M1).
// OS 네이티브 이벤트(폴링 0), 비재귀, 경로 단위 refcount dedup — 여러 창·플러그인·에이전트가
// 같은 경로를 watch 해도 OS watch 는 1개, 해제는 마지막 소비자에서만. 변경은 fs-change 이벤트.
// registerCatalog() 말미에서 등록(catalog 분할 — catalog.ts 비대화 방지, catalogGit 선례).

import { invoke } from "@tauri-apps/api/core";
import { tmsg } from "../i18n";
import { register } from "./registry";

export function registerFsWatchCatalog(): void {
  register("fs.watch", {
    description:
      "Watch a directory for changes using OS-native file events (non-recursive, no polling). Changes emit the fs-change event with the changed directory. Watches are reference-counted per path — pair every fs.watch with a matching fs.unwatch.",
    triggers: { ko: "디렉토리 감시 폴더 변경 감지 워치 파일 변경 구독" },
    params: {
      path: { type: "string", description: "Absolute directory path to watch", required: true },
    },
    returns: "{ path, watchers: subscription count for the path after registration }",
    message: (d) => tmsg("msg.fs.watch", { n: Number(d.watchers ?? 0) }),
    errors: ["INTERNAL"],
    examples: ['fs.watch \'{"path":"/Users/me/work"}\''],
    handler: async (p) => {
      const watchers = await invoke<number>("watch_dir", { path: p.path });
      return { path: p.path, watchers };
    },
  });

  register("fs.unwatch", {
    description:
      "Release one fs.watch subscription for a directory. The OS watch is removed only when the last subscription is released; unwatching a path that is not watched is a no-op.",
    triggers: { ko: "디렉토리 감시 해제 폴더 변경 감지 중지 언워치" },
    params: {
      path: { type: "string", description: "Absolute directory path to stop watching", required: true },
    },
    returns: "{ path, watchers: remaining subscription count for the path }",
    message: (d) => tmsg("msg.fs.unwatch", { n: Number(d.watchers ?? 0) }),
    errors: ["INTERNAL"],
    examples: ['fs.unwatch \'{"path":"/Users/me/work"}\''],
    handler: async (p) => {
      const watchers = await invoke<number>("unwatch_dir", { path: p.path });
      return { path: p.path, watchers };
    },
  });
}
