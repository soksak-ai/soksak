// fs.watch/fs.unwatch — generic path watch commands (the core takes the path only, never the content, W8 M1).
// OS-native events (0 polling), non-recursive, per-path refcount dedup — many windows, plugins, and agents
// watching one path still make 1 OS watch; release happens only at the last consumer. Changes emit fs-change.
// Registered at the end of registerCatalog() (catalog split — keeps catalog.ts from bloating, as in catalogGit).

import { invoke } from "../framework";
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
