// 플러그인 이벤트 — 호스트 상태 변화를 플러그인에게 알리는 단일 채널.
// 구현 원칙: sessions/theme/bookmarks store 를 "구독해서 diff 를 합성"한다.
// 기존 store 코드에 emit 을 주입하지 않는다(외과적 — 유일한 명시 emit 은
// FileViewer 저장 성공 지점의 emitFileSaved 하나).
// 리스너 실패는 호스트를 죽이지 못한다(§0-4) — 콜백마다 try/catch.

import { allGroups, useSessions } from "../state/sessions";
import { useTheme } from "../state/theme";
import { useBookmarks, type Bookmark } from "../state/bookmarks";

type SessionsState = ReturnType<(typeof useSessions)["getState"]>;

export interface Disposable {
  dispose(): void;
}

export interface PluginEventMap {
  "project.changed": { projectId: string; root: string | null };
  "view.activated": {
    projectId: string;
    viewId: string;
    kind: string;
    path?: string;
  };
  "file.opened": { projectId: string; viewId: string; path: string };
  "file.closed": { projectId: string; viewId: string; path: string };
  "file.saved": { projectId: string; viewId: string; path: string };
  "theme.changed": { name: string; mode: "light" | "dark" };
  "bookmarks.changed": { bookmarks: Bookmark[] };
}

export const PLUGIN_EVENTS: readonly (keyof PluginEventMap)[] = [
  "project.changed",
  "view.activated",
  "file.opened",
  "file.closed",
  "file.saved",
  "theme.changed",
  "bookmarks.changed",
];

type AnyListener = (payload: never) => void;
const listeners = new Map<keyof PluginEventMap, Set<AnyListener>>();

export function onPluginEvent<K extends keyof PluginEventMap>(
  event: K,
  fn: (payload: PluginEventMap[K]) => void,
): Disposable {
  if (!PLUGIN_EVENTS.includes(event)) {
    throw new Error(`알 수 없는 이벤트: ${String(event)}`);
  }
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(fn as AnyListener);
  return {
    dispose: () => {
      set.delete(fn as AnyListener);
    },
  };
}

export function emitPluginEvent<K extends keyof PluginEventMap>(
  event: K,
  payload: PluginEventMap[K],
): void {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      (fn as (p: PluginEventMap[K]) => void)(payload);
    } catch (e) {
      // §0-4: 플러그인 리스너 실패는 격리 — 다른 리스너/호스트에 전파하지 않는다.
      console.error(`플러그인 이벤트 리스너 실패(${String(event)}):`, e);
    }
  }
}

// FileViewer 저장 성공 시 1회 호출(저장 성공은 store 신호만으로 구분 불가).
export function emitFileSaved(payload: PluginEventMap["file.saved"]): void {
  emitPluginEvent("file.saved", payload);
}

// ── 상태 diff 합성 ───────────────────────────────────────────────────────────

interface ActiveViewKey {
  projectId: string;
  viewId: string;
  kind: string;
  path?: string;
}

interface SessionsSnapshot {
  activeProjectId: string;
  rootByProject: Map<string, string | null>;
  activeView: ActiveViewKey | null;
  // 열린 파일 뷰 전체(프로젝트 불문): viewId → {projectId, path}
  fileViews: Map<string, { projectId: string; path: string }>;
}

function snapshotSessions(s: SessionsState): SessionsSnapshot {
  const rootByProject = new Map<string, string | null>();
  const fileViews = new Map<string, { projectId: string; path: string }>();
  let activeView: ActiveViewKey | null = null;
  for (const project of s.tabs) {
    rootByProject.set(project.id, project.root ?? null);
    for (const content of project.contents) {
      for (const group of allGroups(content.layout)) {
        for (const view of group.views) {
          if (view.kind === "file") {
            fileViews.set(view.id, { projectId: project.id, path: view.path });
          }
        }
      }
    }
    if (project.id === s.activeId) {
      const content = project.contents.find(
        (c) => c.id === project.activeContentId,
      );
      if (content) {
        const group = allGroups(content.layout).find(
          (g) => g.id === content.activeGroupId,
        );
        const view = group?.views.find((v) => v.id === group.activeViewId);
        if (view) {
          activeView = {
            projectId: project.id,
            viewId: view.id,
            kind: view.kind,
            path: view.kind === "file" ? view.path : undefined,
          };
        }
      }
    }
  }
  return { activeProjectId: s.activeId, rootByProject, activeView, fileViews };
}

function diffSessions(prev: SessionsSnapshot, next: SessionsSnapshot): void {
  if (prev.activeProjectId !== next.activeProjectId) {
    emitPluginEvent("project.changed", {
      projectId: next.activeProjectId,
      root: next.rootByProject.get(next.activeProjectId) ?? null,
    });
  }
  const a = prev.activeView;
  const b = next.activeView;
  if (b && (!a || a.projectId !== b.projectId || a.viewId !== b.viewId)) {
    emitPluginEvent("view.activated", b);
  }
  for (const [viewId, info] of next.fileViews) {
    if (!prev.fileViews.has(viewId)) {
      emitPluginEvent("file.opened", { viewId, ...info });
    }
  }
  for (const [viewId, info] of prev.fileViews) {
    if (!next.fileViews.has(viewId)) {
      emitPluginEvent("file.closed", { viewId, ...info });
    }
  }
}

let started = false;

// 앱 시작 시 1회 — store 구독을 건다(initPluginHost 에서 호출).
export function startPluginHooks(): void {
  if (started) return;
  started = true;

  let prevSessions = snapshotSessions(useSessions.getState());
  useSessions.subscribe((state) => {
    const next = snapshotSessions(state);
    diffSessions(prevSessions, next);
    prevSessions = next;
  });

  let prevTheme = {
    name: useTheme.getState().current,
    mode: useTheme.getState().effectiveMode,
  };
  useTheme.subscribe((state) => {
    if (
      state.current !== prevTheme.name ||
      state.effectiveMode !== prevTheme.mode
    ) {
      prevTheme = { name: state.current, mode: state.effectiveMode };
      emitPluginEvent("theme.changed", prevTheme);
    }
  });

  let prevBookmarks = useBookmarks.getState().list;
  useBookmarks.subscribe((state) => {
    if (state.list !== prevBookmarks) {
      prevBookmarks = state.list;
      emitPluginEvent("bookmarks.changed", { bookmarks: state.list });
    }
  });
}
