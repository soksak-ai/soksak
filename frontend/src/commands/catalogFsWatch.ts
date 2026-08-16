// fs.* — the file surface: what is in a directory, and when a directory changes. The core takes the
// path only, never the content (W8 M1).
//
// `fs.list` was `explorer.list` until 2026-08-16. Reading a directory is a mechanism; an explorer is
// a panel, and a panel is a plugin's (C6).
// OS-native events (0 polling), non-recursive, per-path refcount dedup — many windows, plugins, and agents
// watching one path still make 1 OS watch; release happens only at the last consumer. Changes emit fs-change.
// Registered at the end of registerCatalog() (catalog split — keeps catalog.ts from bloating, as in catalogGit).

import { invoke } from "../framework";
import { tmsg } from "../i18n";
import { P, resolveWorkspace } from "./catalog";
import { register } from "./registry";

export function registerFsWatchCatalog(): void {
  register("fs.list", {
    description:
      "List the direct children of a directory. Omit path to use the workspace root, and the user's home when there is none.",
    triggers: { ko: "파일 목록 디렉토리 목록 폴더 내용" },
    params: {
      workspace: P.workspace,
      path: { type: "string", description: "Absolute directory path" },
    },
    returns: "{ projectId|null, root, children: [{name,dir}] }",
    message: (d) => tmsg("msg.fs.list", { n: ((d.children as unknown[]) ?? []).length }),
    errors: ["TARGET_NOT_FOUND", "INTERNAL"],
    examples: ["fs.list", 'fs.list \'{"path":"<local-evidence>"}\''],
    handler: async (p, ctx) => {
      const t = resolveWorkspace(p, ctx);
      const path = (p.path as string) ?? t?.root ?? null;
      const r = await invoke<{ root: string; children: object[] }>("list_children", { path });
      // With an explicit path the answer stands without a workspace, so this axis can be null.
      return { projectId: t?.id ?? null, ...r };
    },
  });

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
