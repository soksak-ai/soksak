// 워크스페이스 직렬화 — 레이아웃을 plain JSON 스냅샷으로(영속·복원, A2). 두 트리(GroupNode·
// PaneNode)는 splitTree.ts 의 serializeSplitTree 동일 경로로 직렬화된다(중복 없음).
//
// [RULE] leaf payload id(group/pane)·view id·content id 는 보존한다 → active 참조
// (activeContentId/activeGroupId/activeViewId/focusedPaneId/maximizedViewId)가 무손상으로 동작.
// split id 만 복원 시 재생성(트리 구조에만 쓰이고 참조 대상이 아니므로 serializeSplitTree 가 생략).
// live status·live 세션(PTY/webview)은 직렬화하지 않는다 — 복원 후 뷰가 재보고/재마운트.

import {
  serializeSplitTree,
  deserializeSplitTree,
  type SplitSnapshot,
} from "./splitTree";
import type { SidebarGroup } from "./sidebarLayout";
import type { ProjectTab, ContentArea, ViewGroup, View } from "./sessions";

// ── 스냅샷 타입 ───────────────────────────────────────────────────────────────

type ViewSnapshot =
  | { id: string; kind: "file"; title: string; path: string; mode: "code" | "preview" }
  | { id: string; kind: "plugin"; title: string; pluginId: string; view: string };

interface ViewGroupSnapshot {
  id: string;
  activeViewId: string;
  views: ViewSnapshot[];
}

interface ContentSnapshot {
  id: string;
  title: string;
  activeGroupId: string;
  maximizedViewId?: string;
  layout: SplitSnapshot<ViewGroupSnapshot>;
}

export interface ProjectSnapshot {
  id: string;
  title: string;
  root: string;
  shell?: string;
  color?: string;
  sidebarOpen: boolean;
  rightOpen: boolean;
  rightView: string | null;
  leftLayout: SplitSnapshot<SidebarGroup>;
  activeContentId: string;
  contents: ContentSnapshot[];
}

// ── serialize ─────────────────────────────────────────────────────────────────

function serializeView(v: View): ViewSnapshot {
  switch (v.kind) {
    case "file":
      return { id: v.id, kind: "file", title: v.title, path: v.path, mode: v.mode };
    case "plugin":
      // command(자동 실행)는 영속하지 않는다 — 복원된 터미널은 명령을 재실행하지 않는다(A6:
      // live PTY 복원 불가, 재실행은 부작용). 새로 열 때만 autorun 한다.
      return {
        id: v.id,
        kind: "plugin",
        title: v.title,
        pluginId: v.pluginId,
        view: v.view,
      };
  }
}

const serializeViewGroup = (g: ViewGroup): ViewGroupSnapshot => ({
  id: g.id,
  activeViewId: g.activeViewId,
  views: g.views.map(serializeView),
});

const serializeContent = (c: ContentArea): ContentSnapshot => ({
  id: c.id,
  title: c.title,
  activeGroupId: c.activeGroupId,
  ...(c.maximizedViewId ? { maximizedViewId: c.maximizedViewId } : {}),
  layout: serializeSplitTree(c.layout, serializeViewGroup), // GroupNode(leaf=ViewGroup)
});

export function serializeProject(p: ProjectTab): ProjectSnapshot {
  return {
    id: p.id,
    title: p.title,
    root: p.root,
    ...(p.shell ? { shell: p.shell } : {}),
    ...(p.color ? { color: p.color } : {}),
    sidebarOpen: p.sidebarOpen,
    rightOpen: p.rightOpen,
    rightView: p.rightView,
    // 사이드바 레이아웃(SplitTree<SidebarGroup>) — leaf 페이로드는 plain JSON.
    leftLayout: serializeSplitTree(p.leftLayout, (g) => g),
    activeContentId: p.activeContentId,
    contents: p.contents.map(serializeContent),
  };
}

// ── deserialize (split id 만 재생성; 나머지 id·active 참조 보존) ────────────────

function deserializeView(s: ViewSnapshot, _newSplitId: () => string): View {
  switch (s.kind) {
    case "file":
      return { id: s.id, kind: "file", title: s.title, path: s.path, mode: s.mode };
    case "plugin":
      // command 미복원 — 복원된 터미널은 명령을 재실행하지 않는다(A6).
      return {
        id: s.id,
        kind: "plugin",
        title: s.title,
        pluginId: s.pluginId,
        view: s.view,
      };
  }
}

const deserializeViewGroup = (
  s: ViewGroupSnapshot,
  newSplitId: () => string,
): ViewGroup => ({
  id: s.id,
  activeViewId: s.activeViewId,
  views: s.views.map((v) => deserializeView(v, newSplitId)),
});

const deserializeContent = (
  s: ContentSnapshot,
  newSplitId: () => string,
): ContentArea => ({
  id: s.id,
  title: s.title,
  activeGroupId: s.activeGroupId,
  ...(s.maximizedViewId ? { maximizedViewId: s.maximizedViewId } : {}),
  layout: deserializeSplitTree(
    s.layout,
    (g) => deserializeViewGroup(g, newSplitId),
    newSplitId,
  ),
});

// newSplitId 는 호출부(sessions)가 주입 — split id 생성기. 보존 id 와의 충돌 방지는 호출부가
// 복원 후 카운터를 보존 최대치 위로 올려 처리(A5).
export function deserializeProject(
  s: ProjectSnapshot,
  newSplitId: () => string,
): ProjectTab {
  return {
    id: s.id,
    title: s.title,
    root: s.root,
    ...(s.shell ? { shell: s.shell } : {}),
    ...(s.color ? { color: s.color } : {}),
    sidebarOpen: s.sidebarOpen,
    rightOpen: s.rightOpen,
    rightView: s.rightView,
    leftLayout: deserializeSplitTree(s.leftLayout, (g) => g, newSplitId),
    activeContentId: s.activeContentId,
    contents: s.contents.map((c) => deserializeContent(c, newSplitId)),
  };
}
