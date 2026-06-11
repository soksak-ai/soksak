import { create } from "zustand";

// 3단 구조:
//   - 최상단 탭 = 프로젝트(ProjectTab): 자체 사이드바(파일트리) + 콘텐츠 영역
//   - 콘텐츠 영역 = 그룹 트리(GroupNode): editor 에디터 그룹처럼 좌/우/상/하 재귀 분할.
//       각 leaf = ViewGroup(자체 탭바 + 활성 뷰). 탭을 드래그해 분할/이동.
//   - 뷰(View) = 터미널(내부 PaneTree 분할 가능) 또는 파일.
// 비활성 프로젝트/뷰는 언마운트하지 않고 숨겨 세션(PTY/에디터)을 유지한다.

// 재귀 pane 트리. leaf = 터미널 하나, split = 자식들의 행/열 묶음.
export type PaneNode =
  | { type: "leaf"; id: string }
  | { type: "split"; dir: "row" | "col"; children: PaneNode[] };

// 콘텐츠 뷰: 터미널(분할 가능) 또는 파일(CodeMirror/프리뷰).
export type View =
  | {
      id: string;
      kind: "terminal";
      title: string;
      layout: PaneNode;
      focusedPaneId: string;
    }
  | {
      id: string;
      kind: "file";
      title: string;
      path: string; // 절대 경로
      mode: "code" | "preview";
      dirty?: boolean; // 편집 후 미저장
    };

// 에디터 그룹: 탭(뷰) 묶음 + 활성 뷰. 그룹 트리의 leaf.
export interface ViewGroup {
  id: string;
  views: View[];
  activeViewId: string;
}

// 그룹 재귀 트리. leaf = 그룹 하나, split = 행/열로 묶인 그룹들(sizes = 분할 비율).
export type GroupNode =
  | { type: "leaf"; group: ViewGroup }
  | {
      type: "split";
      id: string;
      dir: "row" | "col";
      children: GroupNode[];
      sizes: number[]; // children 와 같은 길이, 합 1
    };

// 드롭 위치(드래그 분할 방향). center=이동, 나머지=해당 방향으로 분할.
export type DropZone = "center" | "left" | "right" | "top" | "bottom";

// 프로젝트가 처음 열 때 띄우는 프로그램.
export type Program = "terminal" | "claude" | "codex";

export interface ProjectTab {
  id: string;
  title: string; // 별칭
  sidebarOpen: boolean;
  layout: GroupNode; // 그룹 트리
  activeGroupId: string;
  // 프로젝트 루트 디렉토리(터미널 시작 위치). 미지정이면 앱 실행 디렉토리.
  root?: string;
  // 첫 프로그램(첫 pane 에서 자동 실행). terminal 이면 셸만.
  program: Program;
  // 프로그램을 실행할 최초 pane id(이 pane 만 program 자동 실행).
  initialPaneId: string;
}

export interface NewProjectOpts {
  alias: string;
  root?: string;
  program: Program;
}

interface SessionsStore {
  tabs: ProjectTab[]; // 프로젝트들
  activeId: string;

  // 프로젝트 레벨
  addProject: (opts: NewProjectOpts) => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  renameTab: (id: string, title: string) => void;
  toggleSidebar: (id: string) => void;

  // 콘텐츠 뷰/그룹 레벨
  addTerminalView: (projectId: string, groupId?: string) => void;
  openFileView: (projectId: string, path: string) => void;
  closeView: (projectId: string, viewId: string) => void;
  setActiveView: (projectId: string, viewId: string) => void;
  setActiveGroup: (projectId: string, groupId: string) => void;
  setFileMode: (projectId: string, viewId: string, mode: "code" | "preview") => void;
  setFileDirty: (projectId: string, viewId: string, dirty: boolean) => void;
  // 드래그 분할/이동: viewId 를 targetGroup 의 zone 위치로.
  moveViewToGroup: (
    projectId: string,
    viewId: string,
    targetGroupId: string,
    zone: DropZone,
  ) => void;
  // 그룹 전체(타이틀바 드래그)를 targetGroup 의 zone 위치로.
  moveGroupToGroup: (
    projectId: string,
    sourceGroupId: string,
    targetGroupId: string,
    zone: DropZone,
  ) => void;
  // 분할 비율 조절(리사이저 드래그).
  resizeSplit: (projectId: string, splitId: string, sizes: number[]) => void;

  // pane 레벨(특정 터미널 뷰 안에서)
  splitPane: (
    projectId: string,
    viewId: string,
    paneId: string,
    dir: "row" | "col",
  ) => void;
  closePane: (projectId: string, viewId: string, paneId: string) => void;
  setFocusedPane: (projectId: string, viewId: string, paneId: string) => void;
}

let nextProjectId = 2; // 첫 프로젝트는 t1
let nextViewId = 2; // 첫 뷰는 v1
let nextPaneId = 2; // 첫 pane 은 p1
let nextGroupId = 2; // 첫 그룹은 g1
let nextSplitId = 1;

const newViewId = () => `v${nextViewId++}`;
const newPaneId = () => `p${nextPaneId++}`;
const newGroupId = () => `g${nextGroupId++}`;
const newSplitId = () => `s${nextSplitId++}`;

const leaf = (id: string): PaneNode => ({ type: "leaf", id });

const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

// 새 터미널 뷰(빈 단일 pane).
function newTerminalView(): View {
  const paneId = newPaneId();
  return {
    id: newViewId(),
    kind: "terminal",
    title: "터미널",
    layout: leaf(paneId),
    focusedPaneId: paneId,
  };
}

function makeGroup(view: View): ViewGroup {
  return { id: newGroupId(), views: [view], activeViewId: view.id };
}

const equalSizes = (n: number): number[] => Array(n).fill(1 / n);

// ── 그룹 트리 헬퍼 ────────────────────────────────────────────────────────────

export function allGroups(node: GroupNode, acc: ViewGroup[] = []): ViewGroup[] {
  if (node.type === "leaf") acc.push(node.group);
  else for (const c of node.children) allGroups(c, acc);
  return acc;
}

export function allViews(node: GroupNode): View[] {
  return allGroups(node).flatMap((g) => g.views);
}

function findGroupOfView(
  node: GroupNode,
  viewId: string,
): ViewGroup | undefined {
  return allGroups(node).find((g) => g.views.some((v) => v.id === viewId));
}

function hasGroup(node: GroupNode, groupId: string): boolean {
  return allGroups(node).some((g) => g.id === groupId);
}

function findGroup(node: GroupNode, groupId: string): ViewGroup | undefined {
  return allGroups(node).find((g) => g.id === groupId);
}

// 특정 그룹의 ViewGroup 을 변환.
function mapGroupNode(
  node: GroupNode,
  groupId: string,
  fn: (g: ViewGroup) => ViewGroup,
): GroupNode {
  if (node.type === "leaf") {
    return node.group.id === groupId
      ? { type: "leaf", group: fn(node.group) }
      : node;
  }
  return {
    ...node,
    children: node.children.map((c) => mapGroupNode(c, groupId, fn)),
  };
}

// 뷰가 어느 그룹에 있든 변환(종류 보존).
function mapViewNode(
  node: GroupNode,
  viewId: string,
  fn: (v: View) => View,
): GroupNode {
  if (node.type === "leaf") {
    if (!node.group.views.some((v) => v.id === viewId)) return node;
    return {
      type: "leaf",
      group: {
        ...node.group,
        views: node.group.views.map((v) => (v.id === viewId ? fn(v) : v)),
      },
    };
  }
  return {
    ...node,
    children: node.children.map((c) => mapViewNode(c, viewId, fn)),
  };
}

// split 노드 sizes 변환.
function mapSplitNode(
  node: GroupNode,
  splitId: string,
  sizes: number[],
): GroupNode {
  if (node.type === "leaf") return node;
  if (node.id === splitId && sizes.length === node.children.length) {
    return { ...node, sizes };
  }
  return {
    ...node,
    children: node.children.map((c) => mapSplitNode(c, splitId, sizes)),
  };
}

// 뷰 제거. 그룹이 비면 leaf 제거, 자식 하나 남는 split 은 붕괴. 전체가 비면 tree=null.
function removeView(
  node: GroupNode,
  viewId: string,
): { tree: GroupNode | null; removed: View | null } {
  if (node.type === "leaf") {
    const found = node.group.views.find((v) => v.id === viewId);
    if (!found) return { tree: node, removed: null };
    const views = node.group.views.filter((v) => v.id !== viewId);
    if (views.length === 0) return { tree: null, removed: found };
    let activeViewId = node.group.activeViewId;
    if (activeViewId === viewId) {
      const idx = node.group.views.findIndex((v) => v.id === viewId);
      activeViewId = (views[idx] ?? views[idx - 1] ?? views[0]).id;
    }
    return {
      tree: { type: "leaf", group: { ...node.group, views, activeViewId } },
      removed: found,
    };
  }
  let removed: View | null = null;
  const children: GroupNode[] = [];
  for (const c of node.children) {
    const r = removeView(c, viewId);
    if (r.removed) removed = r.removed;
    if (r.tree !== null) children.push(r.tree);
  }
  if (children.length === 0) return { tree: null, removed };
  if (children.length === 1) return { tree: children[0], removed };
  const sizes =
    children.length === node.children.length
      ? node.sizes
      : equalSizes(children.length);
  return { tree: { ...node, children, sizes }, removed };
}

// 그룹(leaf) 하나를 통째로 제거. 빈 split 붕괴는 removeView 와 동일.
function removeGroup(
  node: GroupNode,
  groupId: string,
): { tree: GroupNode | null; removed: ViewGroup | null } {
  if (node.type === "leaf") {
    return node.group.id === groupId
      ? { tree: null, removed: node.group }
      : { tree: node, removed: null };
  }
  let removed: ViewGroup | null = null;
  const children: GroupNode[] = [];
  for (const c of node.children) {
    const r = removeGroup(c, groupId);
    if (r.removed) removed = r.removed;
    if (r.tree !== null) children.push(r.tree);
  }
  if (children.length === 0) return { tree: null, removed };
  if (children.length === 1) return { tree: children[0], removed };
  const sizes =
    children.length === node.children.length
      ? node.sizes
      : equalSizes(children.length);
  return { tree: { ...node, children, sizes }, removed };
}

// targetGroup 을 newGroup 과 분할(side 방향). 이미 같은 방향 split 의 직속 자식이면 형제로 삽입.
function splitAtGroup(
  node: GroupNode,
  targetGroupId: string,
  side: "left" | "right" | "top" | "bottom",
  fresh: ViewGroup,
): GroupNode {
  const dir: "row" | "col" =
    side === "left" || side === "right" ? "row" : "col";
  const before = side === "left" || side === "top";
  if (node.type === "leaf") {
    if (node.group.id !== targetGroupId) return node;
    const target: GroupNode = { type: "leaf", group: node.group };
    const freshNode: GroupNode = { type: "leaf", group: fresh };
    const children = before ? [freshNode, target] : [target, freshNode];
    return { type: "split", id: newSplitId(), dir, children, sizes: equalSizes(2) };
  }
  if (node.dir === dir) {
    const idx = node.children.findIndex(
      (c) => c.type === "leaf" && c.group.id === targetGroupId,
    );
    if (idx !== -1) {
      const children = [...node.children];
      children.splice(before ? idx : idx + 1, 0, {
        type: "leaf",
        group: fresh,
      });
      return { ...node, children, sizes: equalSizes(children.length) };
    }
  }
  return {
    ...node,
    children: node.children.map((c) =>
      splitAtGroup(c, targetGroupId, side, fresh),
    ),
  };
}

// 활성 그룹이 사라졌으면 첫 그룹으로 보정.
function normalizeActiveGroup(t: ProjectTab): ProjectTab {
  const groups = allGroups(t.layout);
  if (groups.some((g) => g.id === t.activeGroupId)) return t;
  return { ...t, activeGroupId: groups[0]?.id ?? t.activeGroupId };
}

// ── pane 트리 헬퍼(터미널 뷰 내부) ────────────────────────────────────────────

export function collectLeafIds(node: PaneNode, acc: string[] = []): string[] {
  if (node.type === "leaf") acc.push(node.id);
  else for (const c of node.children) collectLeafIds(c, acc);
  return acc;
}

// 모든 프로젝트·모든 터미널 뷰의 pane leaf id 를 수집(호스트 폐기 diff 용).
export function collectAllLeafIds(tabs: ProjectTab[]): string[] {
  const acc: string[] = [];
  for (const t of tabs) {
    for (const v of allViews(t.layout)) {
      if (v.kind === "terminal") collectLeafIds(v.layout, acc);
    }
  }
  return acc;
}

// paneId 가 속한 프로젝트(spawn 옵션 root/program 결정용).
export function projectOfPane(
  tabs: ProjectTab[],
  paneId: string,
): ProjectTab | undefined {
  for (const t of tabs) {
    for (const v of allViews(t.layout)) {
      if (v.kind === "terminal" && collectLeafIds(v.layout).includes(paneId)) {
        return t;
      }
    }
  }
  return undefined;
}

function splitInTree(
  node: PaneNode,
  paneId: string,
  dir: "row" | "col",
  newId: string,
): PaneNode {
  if (node.type === "leaf") {
    if (node.id !== paneId) return node;
    return { type: "split", dir, children: [leaf(paneId), leaf(newId)] };
  }
  if (node.dir === dir) {
    const idx = node.children.findIndex(
      (c) => c.type === "leaf" && c.id === paneId,
    );
    if (idx !== -1) {
      const children = [...node.children];
      children.splice(idx + 1, 0, leaf(newId));
      return { ...node, children };
    }
  }
  return {
    ...node,
    children: node.children.map((c) => splitInTree(c, paneId, dir, newId)),
  };
}

function removeInTree(node: PaneNode, paneId: string): PaneNode | null {
  if (node.type === "leaf") {
    return node.id === paneId ? null : node;
  }
  const children: PaneNode[] = [];
  for (const c of node.children) {
    const r = removeInTree(c, paneId);
    if (r !== null) children.push(r);
  }
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { ...node, children };
}

// ── 공용 ─────────────────────────────────────────────────────────────────────

function mapProject(
  tabs: ProjectTab[],
  projectId: string,
  fn: (t: ProjectTab) => ProjectTab,
): ProjectTab[] {
  return tabs.map((t) => (t.id === projectId ? fn(t) : t));
}

function firstProject(): ProjectTab {
  const v = newTerminalView();
  const g = makeGroup(v);
  return {
    id: "t1",
    title: "1",
    sidebarOpen: true,
    layout: { type: "leaf", group: g },
    activeGroupId: g.id,
    program: "terminal",
    initialPaneId: v.kind === "terminal" ? v.focusedPaneId : "",
  };
}

function makeProject(id: string, opts: NewProjectOpts, index: number): ProjectTab {
  const v = newTerminalView();
  const g = makeGroup(v);
  const alias =
    opts.alias.trim() || (opts.root ? baseName(opts.root) : String(index));
  return {
    id,
    title: alias,
    sidebarOpen: true,
    layout: { type: "leaf", group: g },
    activeGroupId: g.id,
    root: opts.root,
    program: opts.program,
    initialPaneId: v.kind === "terminal" ? v.focusedPaneId : "",
  };
}

export const useSessions = create<SessionsStore>((set) => ({
  tabs: [firstProject()],
  activeId: "t1",

  addProject: (opts) =>
    set((s) => {
      const id = `t${nextProjectId++}`;
      return {
        tabs: [...s.tabs, makeProject(id, opts, s.tabs.length + 1)],
        activeId: id,
      };
    }),

  closeTab: (id) =>
    set((s) => {
      if (s.tabs.length <= 1) return s; // 마지막 프로젝트는 닫지 않음
      const idx = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      let activeId = s.activeId;
      if (activeId === id) {
        activeId = (tabs[idx] ?? tabs[idx - 1] ?? tabs[0]).id;
      }
      return { tabs, activeId };
    }),

  setActive: (id) => set({ activeId: id }),

  renameTab: (id, title) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)),
    })),

  toggleSidebar: (id) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id ? { ...t, sidebarOpen: !t.sidebarOpen } : t,
      ),
    })),

  addTerminalView: (projectId, groupId) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) => {
        const target = groupId ?? t.activeGroupId;
        const v = newTerminalView();
        return {
          ...t,
          layout: mapGroupNode(t.layout, target, (g) => ({
            ...g,
            views: [...g.views, v],
            activeViewId: v.id,
          })),
          activeGroupId: target,
        };
      }),
    })),

  openFileView: (projectId, path) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) => {
        // 이미 열린 같은 파일이면 그 그룹/뷰를 활성화(재사용).
        const existing = allViews(t.layout).find(
          (v) => v.kind === "file" && v.path === path,
        );
        if (existing) {
          const grp = findGroupOfView(t.layout, existing.id);
          if (!grp) return t;
          return {
            ...t,
            layout: mapGroupNode(t.layout, grp.id, (g) => ({
              ...g,
              activeViewId: existing.id,
            })),
            activeGroupId: grp.id,
          };
        }
        const v: View = {
          id: newViewId(),
          kind: "file",
          title: baseName(path),
          path,
          mode: "code",
        };
        return {
          ...t,
          layout: mapGroupNode(t.layout, t.activeGroupId, (g) => ({
            ...g,
            views: [...g.views, v],
            activeViewId: v.id,
          })),
        };
      }),
    })),

  closeView: (projectId, viewId) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) => {
        if (allViews(t.layout).length <= 1) return t; // 최소 1개 뷰 유지
        const { tree } = removeView(t.layout, viewId);
        if (!tree) return t;
        return normalizeActiveGroup({ ...t, layout: tree });
      }),
    })),

  setActiveView: (projectId, viewId) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) => {
        const grp = findGroupOfView(t.layout, viewId);
        if (!grp) return t;
        return {
          ...t,
          layout: mapGroupNode(t.layout, grp.id, (g) => ({
            ...g,
            activeViewId: viewId,
          })),
          activeGroupId: grp.id,
        };
      }),
    })),

  setActiveGroup: (projectId, groupId) =>
    set((s) => {
      const proj = s.tabs.find((t) => t.id === projectId);
      // 이미 활성 그룹이면 상태 변경 없음(본문 클릭마다 불필요한 재렌더 방지).
      if (!proj || proj.activeGroupId === groupId || !hasGroup(proj.layout, groupId)) {
        return s;
      }
      return {
        tabs: mapProject(s.tabs, projectId, (t) => ({
          ...t,
          activeGroupId: groupId,
        })),
      };
    }),

  setFileMode: (projectId, viewId, mode) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) => ({
        ...t,
        layout: mapViewNode(t.layout, viewId, (v) =>
          v.kind === "file" ? { ...v, mode } : v,
        ),
      })),
    })),

  setFileDirty: (projectId, viewId, dirty) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) => ({
        ...t,
        layout: mapViewNode(t.layout, viewId, (v) =>
          v.kind === "file" ? { ...v, dirty } : v,
        ),
      })),
    })),

  moveViewToGroup: (projectId, viewId, targetGroupId, zone) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) => {
        const src = findGroupOfView(t.layout, viewId);
        if (!src) return t;
        const view = src.views.find((v) => v.id === viewId);
        if (!view) return t;

        if (zone === "center") {
          if (src.id === targetGroupId) return t; // 같은 그룹 → 무시
          const { tree } = removeView(t.layout, viewId);
          if (!tree || !hasGroup(tree, targetGroupId)) return t;
          return normalizeActiveGroup({
            ...t,
            layout: mapGroupNode(tree, targetGroupId, (g) => ({
              ...g,
              views: [...g.views, view],
              activeViewId: view.id,
            })),
            activeGroupId: targetGroupId,
          });
        }

        // 분할: src 에서 떼고 target 옆에 새 그룹으로.
        if (allViews(t.layout).length <= 1) return t; // 유일 뷰는 분할 불가
        const { tree } = removeView(t.layout, viewId);
        if (!tree || !hasGroup(tree, targetGroupId)) return t; // target 이 사라졌으면 무시
        const fresh = makeGroup(view);
        return normalizeActiveGroup({
          ...t,
          layout: splitAtGroup(tree, targetGroupId, zone, fresh),
          activeGroupId: fresh.id,
        });
      }),
    })),

  moveGroupToGroup: (projectId, sourceGroupId, targetGroupId, zone) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) => {
        if (sourceGroupId === targetGroupId) return t;
        if (allGroups(t.layout).length <= 1) return t; // 유일 그룹은 이동 불가
        const source = findGroup(t.layout, sourceGroupId);
        if (!source) return t;
        const { tree } = removeGroup(t.layout, sourceGroupId);
        if (!tree || !hasGroup(tree, targetGroupId)) return t;

        if (zone === "center") {
          // target 으로 source 의 모든 탭을 병합(그룹 합치기).
          return normalizeActiveGroup({
            ...t,
            layout: mapGroupNode(tree, targetGroupId, (g) => ({
              ...g,
              views: [...g.views, ...source.views],
              activeViewId: source.activeViewId,
            })),
            activeGroupId: targetGroupId,
          });
        }
        // 그룹 통째로 target 옆에 재배치(같은 id·뷰 유지 → 본문 remount 없음).
        return normalizeActiveGroup({
          ...t,
          layout: splitAtGroup(tree, targetGroupId, zone, source),
          activeGroupId: source.id,
        });
      }),
    })),

  resizeSplit: (projectId, splitId, sizes) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) => ({
        ...t,
        layout: mapSplitNode(t.layout, splitId, sizes),
      })),
    })),

  splitPane: (projectId, viewId, paneId, dir) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) => ({
        ...t,
        layout: mapViewNode(t.layout, viewId, (v) => {
          if (v.kind !== "terminal") return v;
          const newId = newPaneId();
          return {
            ...v,
            layout: splitInTree(v.layout, paneId, dir, newId),
            focusedPaneId: newId,
          };
        }),
      })),
    })),

  closePane: (projectId, viewId, paneId) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) => ({
        ...t,
        layout: mapViewNode(t.layout, viewId, (v) => {
          if (v.kind !== "terminal") return v;
          if (collectLeafIds(v.layout).length <= 1) return v;
          const next = removeInTree(v.layout, paneId);
          if (next === null) return v;
          const remaining = collectLeafIds(next);
          const focusedPaneId = remaining.includes(v.focusedPaneId)
            ? v.focusedPaneId
            : remaining[0];
          return { ...v, layout: next, focusedPaneId };
        }),
      })),
    })),

  setFocusedPane: (projectId, viewId, paneId) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) => ({
        ...t,
        layout: mapViewNode(t.layout, viewId, (v) =>
          v.kind === "terminal" ? { ...v, focusedPaneId: paneId } : v,
        ),
      })),
    })),
}));
