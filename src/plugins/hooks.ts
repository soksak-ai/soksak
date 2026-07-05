// 플러그인 이벤트 — 호스트 상태 변화를 플러그인에게 알리는 단일 채널.
// 구현 원칙: sessions/theme/bookmarks store 를 "구독해서 diff 를 합성"한다.
// 기존 store 코드에 emit 을 주입하지 않는다(외과적 — 유일한 명시 emit 은
// FileViewer 저장 성공 지점의 emitFileSaved 하나).
// 리스너 실패는 호스트를 죽이지 못한다(§0-4) — 콜백마다 try/catch.

import { invoke } from "@tauri-apps/api/core";
import { safeListen } from "../lib/safeListen";
import { listenThisWindow } from "../lib/windowEvents";
import { currentWindowLabel } from "../lib/webviewLabels";
import {
  currentSessionOf,
  isTracking,
  startSessionTrack,
  stopSessionTrack,
} from "../state/sessionLineage";
import { allGroups, useSessions } from "../state/sessions";
import { useTheme } from "../state/theme";
import { useSettings } from "../state/settings";
import { useBookmarks, type Bookmark } from "../state/bookmarks";
import { setAnyOutputSink } from "../terminal/ptyObservationStore";
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
  // 진행 델타(MESSAGE-PROTOCOL §2) — 사이드카 이벤트·AI thinking 을 소비 플러그인이 발행.
  "command.progress": { command?: string; delta?: unknown; source?: string };
  // 호스트 표시 언어 변경 — 플러그인 자체 i18n(뷰 내부 텍스트)의 갱신 신호.
  "locale.changed": { language: string };
  // 앱(메인 창) 활성 여부 — 코어 WindowEvent::Focused 중계. 다른 앱으로 전환하면 false,
  // 같은 창 안 child webview(내장 브라우저)로 포커스가 가도 창 레벨이라 불변. 펫 등 부차
  // 애니메이션이 "안 볼 때 멈춘다"를 정확히 판정하는 신호(DOM blur 는 child 에도 반응해 부정확).
  "app.focus": { focused: boolean };
  // 창 가장자리 드래그 라이브 리사이즈 시작(true)/끝(false) — 코어 NSWindow live-resize 통지
  // (browser.rs install_live_resize_monitor)를 중계한다. 터미널/브라우저 플러그인이 드래그 중
  // 무거운 작업(터미널 fit·PTY, 네이티브 webview 재배치)의 빈도를 낮추고 드래그 끝에 1회
  // 정확히 스냅하기 위한 단일 채널 — app.focus(window-focus 중계)와 동형. 권한 불요(비민감
  // 라이프사이클). 이 창에 emit_to 된 신호만 받는다(per-window — listenThisWindow).
  "window.live-resize": { active: boolean };
  // 패널 디바이더 드래그 제스처 시작(true)/끝(false) — window.live-resize(창 가장자리)와
  // 동형의 레이아웃-내부 제스처 채널. 네이티브 표면 제공자(브라우저 플러그인)가 드래그 중
  // bounds 커밋을 유예하고 시각 연속 스탠드인(freeze-frame)을 띄우는 근거 신호. 발화는
  // GroupArea 디바이더 핸들러(실드래그·네이티브 브리지·E2E 합성 모두 같은 경로). 권한 불요.
  "layout.resize-gesture": { active: boolean };
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
    // [R2] 막 시작한 명령의 foreground pgid(best-effort — exec 레이스면 셸/null). command/pid/sessionId 짝.
    pid?: number | null;
  };
  // 터미널 명령 종료(OSC 133/633 셸 통합 탐지 — 폴링 없음). git 뷰 등의 자동
  // 갱신 트리거. projectId 는 pane 의 소속 프로젝트(못 찾으면 null). commandLine = 관찰된
  // 시작이 있던 실명령만(셸 초기화 부산물은 null — 부팅 시 pane 마다 발사되는 프롬프트 종료).
  "command.finished": {
    projectId: string | null;
    paneId: string;
    exitCode?: number;
    commandLine?: string | null;
  };
  // 오픈 토픽 "턴 종료" — provider 3종: shell(OSC133 명령 종료), idle(출력 유휴 휴리스틱,
  // 기본 OFF), acp(ACP 플러그인이 bus 로 발행 → 코어가 hooks 로 미러). 메일함 self-subscribe 가
  // 구독해 턴 종료 시 기계적으로 메시지 생성. 코어는 특정 플러그인을 모른다(결합 0) — 토픽 계약만.
  // 활동 허브 엔트리(P12 실행 가시성) — 오케스트레이터 피드와 동일 스트림의 창-측 중계.
  // 전 창 엔트리가 흐른다(payload.window=발생 창) — ownWindow 로 이 창 것만 필터 가능.
  activity: {
    seq: number;
    ts: number;
    kind: string;
    source: string;
    payload: Record<string, unknown>;
    ownWindow: boolean;
  };
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
    // 종료코드(R2 — shell provider OSC133 D;<code>). 없으면 undefined(코드 미동반/비-shell).
    exitCode?: number;
    // [단계⑤] AI 세션 계보 — 끝난 명령이 claude/codex 면 그 종류와 sessionId(없으면 null). 블록에
    // 기록해 복원 후 '이어가기' 의 토대. 비-에이전트 명령은 둘 다 null/undefined(부하 0).
    agentKind?: string | null;
    sessionId?: string | null;
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
  "window.live-resize",
  "layout.resize-gesture",
  "bookmarks.changed",
  "command.started",
  "command.finished",
  "command.progress",
  "turn.ended",
  "activity",
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
  // 활동 허브엔 명령라인·턴 등 터미널 활동이 흐른다 → 같은 급의 게이트.
  activity: "terminal",
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

// 부트 복원 적용 직후 세션 diff 기준점을 현재로 재씨딩 — 복원은 생성이 아니다(§5).
// startPluginHooks 가 실체를 주입한다(그 전 호출은 no-op — 훅 미기동 창은 diff 도 없다).
let reseedSessions: (() => void) | null = null;
export function reseedSessionsSnapshot(): void {
  reseedSessions?.();
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
    // B3 — 활성화도 활동이다(마지막 사용 시각·hydration 우선순위의 근거).
    useSessions.getState().setViewRuntime(b.projectId, b.viewId, { lastActivity: Date.now() });
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
  // 복원 델타 삼킴(§5 "재생은 관찰이 아니다") — 부트 복원이 적용된 직후 workspaceBoot 가
  // 호출한다. 복원으로 나타난 프로젝트를 diff 가 "생성"으로 오인해 project.created 를
  // 창마다 발화하던 원천(실측: 창마다 git.init 자동 실행 + "OK" 낭독 연발).
  reseedSessions = () => {
    prevSessions = snapshotSessions(useSessions.getState());
  };

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
  // B3 — PTY 출력도 활동이다(process 출력 근거). 영속 반영은 pane 당 30s 스로틀:
  // 출력은 고빈도라 매번 스토어에 쓰면 저장·리렌더 폭풍(live vs durable 분리 원칙).
  // CPU/GPU 사용률 샘플링은 불채택 — 상시 폴링이며, 출력 이벤트가 같은 정보의 이벤트 근거다.
  {
    const OUTPUT_ACTIVITY_MS = 30_000;
    const lastWrite = new Map<string, number>();
    setAnyOutputSink((paneId) => {
      const now = Date.now();
      const prev = lastWrite.get(paneId) ?? 0;
      if (now - prev < OUTPUT_ACTIVITY_MS) return;
      lastWrite.set(paneId, now);
      useSessions.getState().setViewRuntime(null, paneId, { lastActivity: now });
    });
  }

  useBookmarks.subscribe((state) => {
    if (state.list !== prevBookmarks) {
      prevBookmarks = state.list;
      emitPluginEvent("bookmarks.changed", { bookmarks: state.list });
    }
  });

  // 터미널 명령 시작 → 플러그인 이벤트(범용 소켓 — claude-GUI 등이 구독). 이산 이벤트.
  subscribeAnyCommandStarted((paneId, commandLine, cwd) => {
    // [R2] 막 시작한 명령의 foreground pid 를 best-effort 캡처해 함께 emit(command/pid/sessionId 짝).
    // [단계⑤] claude 실행이면 그 cwd 세션 디렉토리 watch arm — 실행 중 /clear·/resume 전이를 fs-change
    // 이벤트로 관찰한다(폴링 아님). detect 는 코어 단일진실, 명령당 1회.
    void (async () => {
      const pid = await invoke<number | null>("pty_pane_pid", { paneId }).catch(() => null);
      emitPluginEvent("command.started", {
        projectId: projectOfPane(paneId),
        paneId,
        commandLine,
        cwd,
        pid,
      });
      // B3 — 뷰 런타임 기록: 관찰된 cwd(복원 spawn 위치)와 활동 시각(이벤트가 근거).
      useSessions.getState().setViewRuntime(null, paneId, {
        ...(cwd ? { cwd } : {}),
        lastActivity: Date.now(),
      });
      const kind = commandLine ? await invoke<string | null>("ai_session_detect", { commandLine }) : null;
      if (kind === "claude" && cwd) void startSessionTrack(paneId, cwd);
    })();
  });

  // 터미널 명령 종료 → 플러그인 이벤트(git 뷰 자동 갱신 등). 이산 이벤트라
  // coalesce 불필요 — 발생 빈도 = 사용자가 명령을 끝내는 빈도.
  subscribeAnyCommandFinished((paneId, commandLine, cwd, exitCode) => {
    const info = projectInfoOfPane(paneId);
    emitPluginEvent("command.finished", {
      projectId: info?.id ?? null,
      paneId,
      exitCode,
      commandLine: commandLine ?? null,
    });
    // B3 — 명령 종료 시점의 cwd(cd 후 종료 반영)·활동 시각.
    useSessions.getState().setViewRuntime(null, paneId, {
      ...(cwd ? { cwd } : {}),
      lastActivity: Date.now(),
    });
    // shell provider: 명령 종료 = turn.ended(source shell). 끝난 명령라인/cwd/exitCode(R2) 동반(본문 enrich).
    // [단계⑤] claude 추적 중이었으면 그 watch 추적값(currentSessionOf)을 블록에 싣는다 — find 폴링이 아니라
    // 실행 내내 fs-change 로 갱신된 현재 세션. 그 후 watch disarm.
    const agentKind = isTracking(paneId) ? "claude" : null;
    const sessionId = currentSessionOf(paneId);
    emitPluginEvent("turn.ended", {
      projectId: info?.id ?? null,
      root: info?.root ?? null,
      paneId,
      source: "shell",
      command: commandLine ?? null,
      cwd: cwd ?? null,
      exitCode,
      agentKind,
      sessionId,
    });
    if (agentKind === "claude") void stopSessionTrack(paneId);
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

  // 활동 허브 브로드캐스트(전 창 공통 스트림, activity.rs app.emit) → 플러그인 이벤트.
  // 오케스트레이터가 보는 피드와 동일 원천 — 활동 소비 플러그인(로그 뷰·낭독 등)의 표준 입구.
  // ownWindow = 이 창에서 발생한 엔트리인지(entry.payload.window 비교) — 창-스코프 필터용.
  // 전역 listen 이 맞다(app.emit 브로드캐스트 수신) — safeListen(백엔드 부재·중복 해지 가드).
  safeListen<{ seq: number; ts: number; kind: string; source: string; payload: Record<string, unknown> }>(
    "activity",
    (e) => {
      const entry = e.payload;
      emitPluginEvent("activity", {
        ...entry,
        ownWindow: String(entry.payload?.window ?? "") === currentWindowLabel(),
      });
    },
  );

  // 앱(이 창) 활성 → 플러그인 이벤트. 이 창에 emit_to 된 "window-focus" 만 받는다(전역 listen 이면
  // 다른 창 포커스도 받아 app.focus 가 잘못 발화). lib/windowEvents 머리말 참조.
  listenThisWindow<boolean>("window-focus", (e) => {
    emitPluginEvent("app.focus", { focused: e.payload });
  });

  // 창 라이브 리사이즈(가장자리 드래그) 시작/끝 → 플러그인 이벤트. 이 창에 emit_to 된
  // "window-live-resize" 만 받는다(per-window). 코어 browser.rs install_live_resize_monitor
  // 가 NSWindow Will/DidEndLiveResize 통지를 그 창 label 로만 보낸다 → 각 창은 자기
  // 드래그만 받는다(프론트 필터 불필요). window-focus → app.focus 와 동형 배선.
  listenThisWindow<boolean>("window-live-resize", (e) => {
    emitPluginEvent("window.live-resize", { active: e.payload });
  });
}

// pane 이 속한 프로젝트 {id, root}. 못 찾으면 null. root 는 창 무관 안정 식별자(turn.ended 스코프
// 키). id 는 창-로컬 UI 핸들(project.activate 용).
//
// 관찰 substrate 의 paneId = 플러그인 터미널 뷰의 sessions view.id(= app.pty.spawn 에 넘긴 paneId).
// 코어는 터미널 뷰를 소유하지 않는다(터미널도 플러그인 뷰).
function projectInfoOfPane(paneId: string): { id: string; root: string | null } | null {
  for (const t of useSessions.getState().tabs) {
    for (const c of t.contents) {
      for (const g of allGroups(c.layout)) {
        for (const v of g.views) {
          if (v.id === paneId) {
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
