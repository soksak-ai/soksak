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
import type { ProjectTab, ContentArea, ViewGroup, View } from "./sessions";

// ── 스냅샷 타입 ───────────────────────────────────────────────────────────────

type ViewSnapshot =
  | {
      id: string;
      kind: "terminal";
      title: string;
      layout: SplitSnapshot<string>;
      focusedPaneId: string;
      autorun?: { paneId: string; command: string };
    }
  | { id: string; kind: "file"; title: string; path: string; mode: "code" | "preview" }
  | { id: string; kind: "browser"; title: string; url: string }
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
  leftTab: string;
  activeContentId: string;
  contents: ContentSnapshot[];
}

// ── serialize ─────────────────────────────────────────────────────────────────

function serializeView(v: View): ViewSnapshot {
  switch (v.kind) {
    case "terminal":
      return {
        id: v.id,
        kind: "terminal",
        title: v.title,
        layout: serializeSplitTree(v.layout, (p) => p), // PaneNode(leaf=paneId)
        focusedPaneId: v.focusedPaneId,
        ...(v.autorun ? { autorun: v.autorun } : {}),
      };
    case "file":
      return { id: v.id, kind: "file", title: v.title, path: v.path, mode: v.mode };
    case "browser":
      return { id: v.id, kind: "browser", title: v.title, url: v.url };
    case "plugin":
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
    leftTab: p.leftTab,
    activeContentId: p.activeContentId,
    contents: p.contents.map(serializeContent),
  };
}

// ── deserialize (split id 만 재생성; 나머지 id·active 참조 보존) ────────────────

function deserializeView(s: ViewSnapshot, newSplitId: () => string): View {
  switch (s.kind) {
    case "terminal":
      return {
        id: s.id,
        kind: "terminal",
        title: s.title,
        layout: deserializeSplitTree(s.layout, (p) => p, newSplitId),
        focusedPaneId: s.focusedPaneId,
        ...(s.autorun ? { autorun: s.autorun } : {}),
      };
    case "file":
      return { id: s.id, kind: "file", title: s.title, path: s.path, mode: s.mode };
    case "browser":
      return { id: s.id, kind: "browser", title: s.title, url: s.url };
    case "plugin":
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
    leftTab: s.leftTab,
    activeContentId: s.activeContentId,
    contents: s.contents.map((c) => deserializeContent(c, newSplitId)),
  };
}
