// 플러그인 API 의 프로덕션 의존성 배선 — api.ts 의 PluginApiDeps 구현.
// (테스트는 가짜 deps 를 주입 — 이 파일은 실제 registry/store/bridge 연결만 담당.)

import { invoke } from "@tauri-apps/api/core";
import {
  execute,
  getSpec,
  register,
  unregister,
} from "../commands/registry";
import { allGroups, useSessions } from "../state/sessions";
import { getFileView } from "../commands/fileViewBridge";
import { onPluginEvent } from "./hooks";
import type { PluginApiDeps } from "./api";

// 활성 체인(활성 프로젝트 → 활성 컨텐츠 → 활성 그룹 → 활성 뷰)의 파일 뷰.
function activeFile(): { viewId: string; path: string; text: string } | null {
  const s = useSessions.getState();
  const project = s.tabs.find((t) => t.id === s.activeId);
  const content = project?.contents.find(
    (c) => c.id === project.activeContentId,
  );
  if (!content) return null;
  const group = allGroups(content.layout).find(
    (g) => g.id === content.activeGroupId,
  );
  const view = group?.views.find((v) => v.id === group.activeViewId);
  if (!view || view.kind !== "file") return null;
  // 코드 편집 뷰가 아니면(프리뷰/미디어 — getText 미구현) null.
  const text = getFileView(view.id)?.getText?.();
  if (text === undefined) return null;
  return { viewId: view.id, path: view.path, text };
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
    activeFile,
    setFileText: (viewId, text) =>
      getFileView(viewId)?.setText?.(text) ?? false,
  };
}
