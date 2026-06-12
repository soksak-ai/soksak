// 플러그인 이벤트 — 호스트 상태 변화를 플러그인에게 알리는 단일 채널.
// 구현 원칙: sessions/theme/bookmarks store 를 "구독해서 diff 를 합성"한다.
// 기존 store 코드에 emit 을 주입하지 않는다(외과적 — 유일한 명시 emit 은
// FileViewer 저장 성공 지점의 emitFileSaved 하나).
// 리스너 실패는 호스트를 죽이지 못한다(§0-4) — 콜백마다 try/catch.

import { rafThrottle } from "../lib/rafThrottle";
import { allGroups, collectLeafIds, useSessions } from "../state/sessions";
import { useTheme } from "../state/theme";
import { useSettings } from "../state/settings";
import { useBookmarks, type Bookmark } from "../state/bookmarks";
import { subscribeAnyCommandFinished } from "../terminal/paneHosts";

type SessionsState = ReturnType<(typeof useSessions)["getState"]>;

export interface Disposable {
  dispose(): void;
}

export interface PluginEventMap {
  "project.changed": { projectId: string; root: string | null };
  // 새 프로젝트 생성(루트 확정 직후) — 루트 초기화 정책(git init 등)은
  // 코어가 아니라 이 이벤트를 구독하는 플러그인이 소유한다.
  "project.created": { projectId: string; root: string | null };
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
  // 호스트 표시 언어 변경 — 플러그인 자체 i18n(뷰 내부 텍스트)의 갱신 신호.
  "locale.changed": { language: string };
  "bookmarks.changed": { bookmarks: Bookmark[] };
  // 터미널 명령 종료(OSC 133/633 셸 통합 탐지 — 폴링 없음). git 뷰 등의 자동
  // 갱신 트리거. projectId 는 pane 의 소속 프로젝트(못 찾으면 null).
  "command.finished": { projectId: string | null; paneId: string };
}

export const PLUGIN_EVENTS: readonly (keyof PluginEventMap)[] = [
  "project.changed",
  "project.created",
  "view.activated",
  "file.opened",
  "file.closed",
  "file.saved",
  "theme.changed",
  "locale.changed",
  "bookmarks.changed",
  "command.finished",
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
  for (const [projectId, root] of next.rootByProject) {
    if (!prev.rootByProject.has(projectId)) {
      emitPluginEvent("project.created", { projectId, root: root ?? null });
    }
  }
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

  // 모든 store 쓰기마다 O(n) 스냅샷+diff 를 돌리지 않는다(원칙 1·5,
  // docs/PERFORMANCE.md) — 드래그 중 resizeSplit 은 60Hz+ 로 쓰지만 이 이벤트들
  // (코스 시맨틱: 활성/열림 변화)은 레이아웃 비율로는 절대 바뀌지 않는다.
  // trailing rAF 로 coalesce: 프레임당 1회, 마지막 상태 기준으로 diff.
  let prevSessions = snapshotSessions(useSessions.getState());
  const scheduleSessionsDiff = rafThrottle(() => {
    const next = snapshotSessions(useSessions.getState());
    diffSessions(prevSessions, next);
    prevSessions = next;
  });
  useSessions.subscribe(() => scheduleSessionsDiff());

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

  let prevLanguage = useSettings.getState().language;
  useSettings.subscribe((state) => {
    if (state.language !== prevLanguage) {
      prevLanguage = state.language;
      emitPluginEvent("locale.changed", { language: state.language });
    }
  });

  let prevBookmarks = useBookmarks.getState().list;
  useBookmarks.subscribe((state) => {
    if (state.list !== prevBookmarks) {
      prevBookmarks = state.list;
      emitPluginEvent("bookmarks.changed", { bookmarks: state.list });
    }
  });

  // 터미널 명령 종료 → 플러그인 이벤트(git 뷰 자동 갱신 등). 이산 이벤트라
  // coalesce 불필요 — 발생 빈도 = 사용자가 명령을 끝내는 빈도.
  subscribeAnyCommandFinished((paneId) => {
    emitPluginEvent("command.finished", {
      projectId: projectOfPane(paneId),
      paneId,
    });
  });
}

// pane 이 속한 프로젝트 id. 터미널 뷰들의 leaf 를 걸어 찾는다(못 찾으면 null).
function projectOfPane(paneId: string): string | null {
  for (const t of useSessions.getState().tabs) {
    for (const c of t.contents) {
      for (const g of allGroups(c.layout)) {
        for (const v of g.views) {
          if (v.kind === "terminal" && collectLeafIds(v.layout).includes(paneId)) {
            return t.id;
          }
        }
      }
    }
  }
  return null;
}
