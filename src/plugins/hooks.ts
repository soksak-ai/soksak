// 플러그인 이벤트 — 호스트 상태 변화를 플러그인에게 알리는 단일 채널.
// 구현 원칙: sessions/theme/bookmarks store 를 "구독해서 diff 를 합성"한다.
// 기존 store 코드에 emit 을 주입하지 않는다(외과적 — 유일한 명시 emit 은
// FileViewer 저장 성공 지점의 emitFileSaved 하나).
// 리스너 실패는 호스트를 죽이지 못한다(§0-4) — 콜백마다 try/catch.

import { listenThisWindow } from "../lib/windowEvents";
import { allGroups, collectLeafIds, useSessions } from "../state/sessions";
import { useTheme } from "../state/theme";
import { useSettings } from "../state/settings";
import { useBookmarks, type Bookmark } from "../state/bookmarks";
import {
  subscribeAnyCommandFinished,
  subscribeAnyCommandStarted,
} from "../terminal/paneHosts";
import { busOn } from "./bus";
import { configureIdleTurnDetector } from "../terminal/idleTurnDetector";
import type { PluginPermission } from "./spec";

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
  // 앱(메인 창) 활성 여부 — 코어 WindowEvent::Focused 중계. 다른 앱으로 전환하면 false,
  // 같은 창 안 child webview(내장 브라우저)로 포커스가 가도 창 레벨이라 불변. 펫 등 부차
  // 애니메이션이 "안 볼 때 멈춘다"를 정확히 판정하는 신호(DOM blur 는 child 에도 반응해 부정확).
  "app.focus": { focused: boolean };
  "bookmarks.changed": { bookmarks: Bookmark[] };
  // 터미널 명령 시작(셸 preexec 의 OSC 633;E — 명령라인·cwd 동반, 폴링 없음).
  // [RULE] claude 등 "명령별" 도메인 처리는 코어가 아니라 이 이벤트를 구독하는
  // 플러그인이 소유한다 — project.created 와 동일 원칙. 코어는 범용 소켓만 제공하고
  // 특정 플러그인(claude 등)용 특수 코드를 갖지 않는다(강결합 금지).
  "command.started": {
    projectId: string | null;
    paneId: string;
    commandLine: string;
    cwd: string | null;
  };
  // 터미널 명령 종료(OSC 133/633 셸 통합 탐지 — 폴링 없음). git 뷰 등의 자동
  // 갱신 트리거. projectId 는 pane 의 소속 프로젝트(못 찾으면 null).
  "command.finished": { projectId: string | null; paneId: string };
  // 오픈 토픽 "턴 종료" — provider 3종: shell(OSC133 명령 종료), idle(출력 유휴 휴리스틱,
  // 기본 OFF), acp(ACP 플러그인이 bus 로 발행 → 코어가 hooks 로 미러). 메일함 self-subscribe 가
  // 구독해 턴 종료 시 기계적으로 메시지 생성. 코어는 특정 플러그인을 모른다(결합 0) — 토픽 계약만.
  "turn.ended": {
    projectId: string | null;
    // 프로젝트 root(폴더 경로) — 창 무관 안정 식별자. 멀티창 같은 프로젝트 일관성의 스코프 키
    // (projectId 는 창마다 다를 수 있어 스코프로 부적합). 구독자(메일함)는 root 로 스코프한다.
    root: string | null;
    paneId: string | null;
    source: "shell" | "idle" | "acp";
    // 끝난 명령 컨텍스트(shell provider 한정 — 본문 enrich 용). idle/acp 는 없음(undefined).
    command?: string | null;
    cwd?: string | null;
  };
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
  "app.focus",
  "bookmarks.changed",
  "command.started",
  "command.finished",
  "turn.ended",
];

// 권한 게이트가 필요한 이벤트 → 요구 권한. 여기 없는 이벤트는 권한 불요(범용 알림).
// command.* 는 사용자가 실행하는 명령(명령라인·cwd)을 노출 → "terminal" 권한 필요.
// 동의 화면이 그 권한을 표시한다(코어/터미널 접근을 사용자에게 고지).
export const EVENT_PERMISSIONS: Partial<
  Record<keyof PluginEventMap, PluginPermission>
> = {
  "command.started": "terminal",
  "command.finished": "terminal",
  // 턴 종료는 터미널 화면 활동(유휴 감지 포함)을 노출 → 화면 읽기 권한 게이트.
  "turn.ended": "terminal:read",
};

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
  // coalesce 는 rAF 가 아니라 마이크로태스크다: diff 는 렌더와 무관하고(원칙 4
  // 의 rAF 는 입력→렌더 정렬용), WebKit 은 가려진(occluded) 창에서 rAF 를
  // 정지시켜 원격(sok/MCP) 조작 중 이벤트가 무기한 지연되는 사고가 실측됐다.
  // 같은 동기 burst(리사이즈 스톰 등)는 1회로 합쳐진다.
  let prevSessions = snapshotSessions(useSessions.getState());
  let diffQueued = false;
  const scheduleSessionsDiff = () => {
    if (diffQueued) return;
    diffQueued = true;
    queueMicrotask(() => {
      diffQueued = false;
      const next = snapshotSessions(useSessions.getState());
      diffSessions(prevSessions, next);
      prevSessions = next;
    });
  };
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

  // 터미널 명령 시작 → 플러그인 이벤트(범용 소켓 — claude-GUI 등이 구독). 이산 이벤트.
  subscribeAnyCommandStarted((paneId, commandLine, cwd) => {
    emitPluginEvent("command.started", {
      projectId: projectOfPane(paneId),
      paneId,
      commandLine,
      cwd,
    });
  });

  // 터미널 명령 종료 → 플러그인 이벤트(git 뷰 자동 갱신 등). 이산 이벤트라
  // coalesce 불필요 — 발생 빈도 = 사용자가 명령을 끝내는 빈도.
  subscribeAnyCommandFinished((paneId, commandLine, cwd) => {
    const info = projectInfoOfPane(paneId);
    emitPluginEvent("command.finished", { projectId: info?.id ?? null, paneId });
    // shell provider: 명령 종료 = turn.ended(source shell). 끝난 명령라인/cwd 동반(본문 enrich).
    emitPluginEvent("turn.ended", {
      projectId: info?.id ?? null,
      root: info?.root ?? null,
      paneId,
      source: "shell",
      command: commandLine ?? null,
      cwd: cwd ?? null,
    });
  });

  // idle provider 배선(기본 OFF — turn.idleDetection 커맨드로 켬). emit/projectInfo 주입(순환 import 회피).
  configureIdleTurnDetector({
    emit: (p) => emitPluginEvent("turn.ended", p),
    projectInfoOf: (paneId) => projectInfoOfPane(paneId),
  });

  // acp provider 채널 통합 — 오픈 bus 의 "turn.ended"(ACP 플러그인 발행)를 hooks 채널로 미러.
  // 메일함은 app.events.on("turn.ended") 한 곳만 구독하면 3 provider 를 모두 받는다(창-로컬).
  busOn("turn.ended", (payload) => {
    if (payload && typeof payload === "object") {
      emitPluginEvent("turn.ended", payload as PluginEventMap["turn.ended"]);
    }
  });

  // 앱(이 창) 활성 → 플러그인 이벤트. 이 창에 emit_to 된 "window-focus" 만 받는다(전역 listen 이면
  // 다른 창 포커스도 받아 app.focus 가 잘못 발화). lib/windowEvents 머리말 참조.
  listenThisWindow<boolean>("window-focus", (e) => {
    emitPluginEvent("app.focus", { focused: e.payload });
  });
}

// pane 이 속한 프로젝트 {id, root}. 못 찾으면 null. root 는 창 무관 안정 식별자(turn.ended 스코프
// 키). id 는 창-로컬 UI 핸들(project.activate 용).
//
// 관찰 substrate 의 paneId 는 producer 가 정한다:
//   - 코어 터미널 뷰: PaneTree leaf id(v.layout 의 collectLeafIds). v.focusedPaneId 도 그 중 하나.
//   - 플러그인 터미널: 그 콘텐츠 뷰의 sessions view.id(= app.pty.spawn 에 넘긴 paneId).
// 둘 다 동일 paneId 키로 매칭해, 코어 뷰가 사라져도 플러그인 터미널의 프로젝트가 해소된다.
function projectInfoOfPane(paneId: string): { id: string; root: string | null } | null {
  for (const t of useSessions.getState().tabs) {
    for (const c of t.contents) {
      for (const g of allGroups(c.layout)) {
        for (const v of g.views) {
          if (v.kind === "terminal" && collectLeafIds(v.layout).includes(paneId)) {
            return { id: t.id, root: t.root ?? null };
          }
          // 플러그인 터미널 뷰: paneId = 그 콘텐츠 뷰의 view.id.
          if (v.kind === "plugin" && v.id === paneId) {
            return { id: t.id, root: t.root ?? null };
          }
        }
      }
    }
  }
  return null;
}

// pane 이 속한 프로젝트 id(command.started 등 id-만 필요한 곳).
function projectOfPane(paneId: string): string | null {
  return projectInfoOfPane(paneId)?.id ?? null;
}
