import { create } from "zustand";
import { useSettings } from "./settings";

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

// 콘텐츠 뷰: 터미널(분할 가능), 파일(CodeMirror/프리뷰), 브라우저(child webview).
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
    }
  | {
      id: string;
      kind: "browser";
      title: string;
      url: string;
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

// 컨텐츠가 처음 열 때 띄우는 프로그램(첫 화면).
export type Program = "terminal" | "claude" | "codex" | "browser";

// 브라우저 뷰 기본 시작 페이지.
export const BROWSER_HOME = "https://www.google.com";

// 컨텐츠 탭: 한 프로젝트 안의 독립 콘텐츠 영역(분할 그리드). 프로젝트당 여러 개 + 전환.
export interface ContentArea {
  id: string;
  title: string; // 1,2,3,… (이름변경 가능)
  // 이 컨텐츠의 첫 화면 프로그램(생성 시 확정: 명시 선택 > 프로젝트 설정 > 전역 설정).
  program: Program;
  layout: GroupNode; // 그룹(분할) 트리
  activeGroupId: string;
  // 프로그램 자동 실행 pane(터미널형 프로그램일 때 첫 pane 에서 1회).
  initialPaneId: string;
}

export interface ProjectTab {
  id: string;
  title: string; // 별칭
  sidebarOpen: boolean;
  // 프로젝트 루트 디렉토리(터미널 시작 위치). 미지정이면 앱 실행 디렉토리.
  root?: string;
  // 프로젝트의 첫 화면(미지정이면 전역 설정 defaultProgram 사용 — 프로젝트 설정이 우선).
  program?: Program;
  // 컨텐츠 탭들 + 활성.
  contents: ContentArea[];
  activeContentId: string;
}

export interface NewProjectOpts {
  alias: string;
  root?: string;
  program?: Program; // undefined = 전역 설정 따름
}

// 첫 화면 결정: 명시 선택 > 프로젝트 설정 > 전역 설정.
function effectiveProgram(explicit?: Program, project?: Program): Program {
  return explicit ?? project ?? useSettings.getState().defaultProgram;
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

  // 컨텐츠 탭 레벨. program 명시 시 그 프로그램으로(+메뉴), 아니면 프로젝트>전역 설정.
  addContent: (projectId: string, program?: Program) => void;
  closeContent: (projectId: string, contentId: string) => void;
  setActiveContent: (projectId: string, contentId: string) => void;
  renameContent: (projectId: string, contentId: string, title: string) => void;

  // 콘텐츠 뷰/그룹 레벨
  addTerminalView: (projectId: string, groupId?: string) => void;
  openFileView: (projectId: string, path: string) => void;
  closeView: (projectId: string, viewId: string) => void;
  setActiveView: (projectId: string, viewId: string) => void;
  setActiveGroup: (projectId: string, groupId: string) => void;
  setFileMode: (projectId: string, viewId: string, mode: "code" | "preview") => void;
  setFileDirty: (projectId: string, viewId: string, dirty: boolean) => void;
  // 브라우저 뷰 URL 동기화(네비게이션 이벤트/URL 바 입력).
  setBrowserUrl: (projectId: string, viewId: string, url: string) => void;
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
  // targetGroup 옆에 새 터미널 그룹을 분할 생성(split 버튼 / title 모드 ⌘T).
  splitNewTerminal: (
    projectId: string,
    targetGroupId: string,
    side: "left" | "right" | "top" | "bottom",
  ) => void;

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
let nextContentId = 2; // 첫 컨텐츠는 c1

const newViewId = () => `v${nextViewId++}`;
const newPaneId = () => `p${nextPaneId++}`;
const newGroupId = () => `g${nextGroupId++}`;
const newSplitId = () => `s${nextSplitId++}`;
const newContentId = () => `c${nextContentId++}`;

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

// 새 브라우저 뷰.
function newBrowserView(): View {
  return {
    id: newViewId(),
    kind: "browser",
    title: "브라우저",
    url: BROWSER_HOME,
  };
}

// 새 컨텐츠 영역(단일 그룹 + 첫 화면 뷰). 터미널형이면 첫 pane 에서 프로그램 자동 실행,
// 브라우저면 브라우저 뷰로 시작.
function makeContent(title: string, program: Program): ContentArea {
  const v = program === "browser" ? newBrowserView() : newTerminalView();
  const g = makeGroup(v);
  return {
    id: newContentId(),
    title,
    program,
    layout: { type: "leaf", group: g },
    activeGroupId: g.id,
    initialPaneId: v.kind === "terminal" ? v.focusedPaneId : "",
  };
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
function normalizeActiveGroupC(c: ContentArea): ContentArea {
  const groups = allGroups(c.layout);
  if (groups.some((g) => g.id === c.activeGroupId)) return c;
  return { ...c, activeGroupId: groups[0]?.id ?? c.activeGroupId };
}

// ── pane 트리 헬퍼(터미널 뷰 내부) ────────────────────────────────────────────

export function collectLeafIds(node: PaneNode, acc: string[] = []): string[] {
  if (node.type === "leaf") acc.push(node.id);
  else for (const c of node.children) collectLeafIds(c, acc);
  return acc;
}

// 모든 프로젝트·모든 컨텐츠·모든 터미널 뷰의 pane leaf id 를 수집(호스트 폐기 diff 용).
export function collectAllLeafIds(tabs: ProjectTab[]): string[] {
  const acc: string[] = [];
  for (const t of tabs) {
    for (const c of t.contents) {
      for (const v of allViews(c.layout)) {
        if (v.kind === "terminal") collectLeafIds(v.layout, acc);
      }
    }
  }
  return acc;
}

// paneId 의 spawn 정보: cwd=프로젝트 root, program=그 컨텐츠의 첫 pane 일 때만 자동 실행
// (컨텐츠 생성 시 확정된 content.program — claude/codex 만 명령 실행 대상).
export function paneSpawnInfo(
  tabs: ProjectTab[],
  paneId: string,
): { cwd?: string; program?: Program } {
  for (const t of tabs) {
    for (const c of t.contents) {
      for (const v of allViews(c.layout)) {
        if (v.kind === "terminal" && collectLeafIds(v.layout).includes(paneId)) {
          const isInitial = paneId === c.initialPaneId;
          const runnable = c.program === "claude" || c.program === "codex";
          return {
            cwd: t.root,
            program: isInitial && runnable ? c.program : undefined,
          };
        }
      }
    }
  }
  return {};
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

function activeContentOf(t: ProjectTab): ContentArea | undefined {
  return t.contents.find((c) => c.id === t.activeContentId);
}

// 활성 컨텐츠 영역을 변환(그룹/뷰/분할 액션은 활성 컨텐츠 대상).
function mapActiveContent(
  t: ProjectTab,
  fn: (c: ContentArea) => ContentArea,
): ProjectTab {
  return {
    ...t,
    contents: t.contents.map((c) => (c.id === t.activeContentId ? fn(c) : c)),
  };
}

function mapContent(
  t: ProjectTab,
  contentId: string,
  fn: (c: ContentArea) => ContentArea,
): ProjectTab {
  return {
    ...t,
    contents: t.contents.map((c) => (c.id === contentId ? fn(c) : c)),
  };
}

// 뷰를 어느 컨텐츠에 있든 변환(숨은 컨텐츠의 마운트된 뷰도 대상 — dirty/mode/focus 등).
function mapViewEverywhere(
  t: ProjectTab,
  viewId: string,
  fn: (v: View) => View,
): ProjectTab {
  return {
    ...t,
    contents: t.contents.map((c) => ({
      ...c,
      layout: mapViewNode(c.layout, viewId, fn),
    })),
  };
}

function firstProject(): ProjectTab {
  const c = makeContent("1", "terminal");
  return {
    id: "t1",
    title: "1",
    sidebarOpen: true,
    program: "terminal",
    contents: [c],
    activeContentId: c.id,
  };
}

function makeProject(id: string, opts: NewProjectOpts, index: number): ProjectTab {
  const c = makeContent("1", effectiveProgram(undefined, opts.program));
  const alias =
    opts.alias.trim() || (opts.root ? baseName(opts.root) : String(index));
  return {
    id,
    title: alias,
    sidebarOpen: true,
    root: opts.root,
    program: opts.program,
    contents: [c],
    activeContentId: c.id,
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

  addContent: (projectId, program) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) => {
        const nextNum =
          Math.max(0, ...t.contents.map((c) => parseInt(c.title, 10) || 0)) + 1;
        const c = makeContent(
          String(nextNum),
          effectiveProgram(program, t.program),
        );
        return { ...t, contents: [...t.contents, c], activeContentId: c.id };
      }),
    })),

  closeContent: (projectId, contentId) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) => {
        if (t.contents.length <= 1) return t; // 최소 1개 컨텐츠 유지
        const idx = t.contents.findIndex((c) => c.id === contentId);
        if (idx === -1) return t;
        const contents = t.contents.filter((c) => c.id !== contentId);
        let activeContentId = t.activeContentId;
        if (activeContentId === contentId) {
          activeContentId = (contents[idx] ?? contents[idx - 1] ?? contents[0]).id;
        }
        return { ...t, contents, activeContentId };
      }),
    })),

  setActiveContent: (projectId, contentId) =>
    set((s) => {
      const proj = s.tabs.find((t) => t.id === projectId);
      if (
        !proj ||
        proj.activeContentId === contentId ||
        !proj.contents.some((c) => c.id === contentId)
      ) {
        return s;
      }
      return {
        tabs: mapProject(s.tabs, projectId, (t) => ({
          ...t,
          activeContentId: contentId,
        })),
      };
    }),

  renameContent: (projectId, contentId, title) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) =>
        mapContent(t, contentId, (c) => ({ ...c, title })),
      ),
    })),

  addTerminalView: (projectId, groupId) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) =>
        mapActiveContent(t, (c) => {
          const target = groupId ?? c.activeGroupId;
          const v = newTerminalView();
          return {
            ...c,
            layout: mapGroupNode(c.layout, target, (g) => ({
              ...g,
              views: [...g.views, v],
              activeViewId: v.id,
            })),
            activeGroupId: target,
          };
        }),
      ),
    })),

  openFileView: (projectId, path) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) =>
        mapActiveContent(t, (c) => {
          // 이미 열린 같은 파일이면 그 그룹/뷰를 활성화(재사용).
          const existing = allViews(c.layout).find(
            (v) => v.kind === "file" && v.path === path,
          );
          if (existing) {
            const grp = findGroupOfView(c.layout, existing.id);
            if (!grp) return c;
            return {
              ...c,
              layout: mapGroupNode(c.layout, grp.id, (g) => ({
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
            ...c,
            layout: mapGroupNode(c.layout, c.activeGroupId, (g) => ({
              ...g,
              views: [...g.views, v],
              activeViewId: v.id,
            })),
          };
        }),
      ),
    })),

  closeView: (projectId, viewId) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) =>
        mapActiveContent(t, (c) => {
          if (allViews(c.layout).length <= 1) return c; // 최소 1개 뷰 유지
          const { tree } = removeView(c.layout, viewId);
          if (!tree) return c;
          return normalizeActiveGroupC({ ...c, layout: tree });
        }),
      ),
    })),

  setActiveView: (projectId, viewId) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) =>
        mapActiveContent(t, (c) => {
          const grp = findGroupOfView(c.layout, viewId);
          if (!grp) return c;
          return {
            ...c,
            layout: mapGroupNode(c.layout, grp.id, (g) => ({
              ...g,
              activeViewId: viewId,
            })),
            activeGroupId: grp.id,
          };
        }),
      ),
    })),

  setActiveGroup: (projectId, groupId) =>
    set((s) => {
      const proj = s.tabs.find((t) => t.id === projectId);
      const c = proj ? activeContentOf(proj) : undefined;
      // 이미 활성 그룹이면 상태 변경 없음(본문 클릭마다 불필요한 재렌더 방지).
      if (!proj || !c || c.activeGroupId === groupId || !hasGroup(c.layout, groupId)) {
        return s;
      }
      return {
        tabs: mapProject(s.tabs, projectId, (t) =>
          mapActiveContent(t, (ct) => ({ ...ct, activeGroupId: groupId })),
        ),
      };
    }),

  setFileMode: (projectId, viewId, mode) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) =>
        mapViewEverywhere(t, viewId, (v) =>
          v.kind === "file" ? { ...v, mode } : v,
        ),
      ),
    })),

  setFileDirty: (projectId, viewId, dirty) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) =>
        mapViewEverywhere(t, viewId, (v) =>
          v.kind === "file" ? { ...v, dirty } : v,
        ),
      ),
    })),

  setBrowserUrl: (projectId, viewId, url) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) =>
        mapViewEverywhere(t, viewId, (v) =>
          v.kind === "browser" ? { ...v, url } : v,
        ),
      ),
    })),

  moveViewToGroup: (projectId, viewId, targetGroupId, zone) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) =>
        mapActiveContent(t, (c) => {
          const src = findGroupOfView(c.layout, viewId);
          if (!src) return c;
          const view = src.views.find((v) => v.id === viewId);
          if (!view) return c;

          if (zone === "center") {
            if (src.id === targetGroupId) return c; // 같은 그룹 → 무시
            const { tree } = removeView(c.layout, viewId);
            if (!tree || !hasGroup(tree, targetGroupId)) return c;
            return normalizeActiveGroupC({
              ...c,
              layout: mapGroupNode(tree, targetGroupId, (g) => ({
                ...g,
                views: [...g.views, view],
                activeViewId: view.id,
              })),
              activeGroupId: targetGroupId,
            });
          }

          // 분할: src 에서 떼고 target 옆에 새 그룹으로.
          if (allViews(c.layout).length <= 1) return c; // 유일 뷰는 분할 불가
          const { tree } = removeView(c.layout, viewId);
          if (!tree || !hasGroup(tree, targetGroupId)) return c;
          const fresh = makeGroup(view);
          return normalizeActiveGroupC({
            ...c,
            layout: splitAtGroup(tree, targetGroupId, zone, fresh),
            activeGroupId: fresh.id,
          });
        }),
      ),
    })),

  moveGroupToGroup: (projectId, sourceGroupId, targetGroupId, zone) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) =>
        mapActiveContent(t, (c) => {
          if (sourceGroupId === targetGroupId) return c;
          if (allGroups(c.layout).length <= 1) return c; // 유일 그룹은 이동 불가
          const source = findGroup(c.layout, sourceGroupId);
          if (!source) return c;
          const { tree } = removeGroup(c.layout, sourceGroupId);
          if (!tree || !hasGroup(tree, targetGroupId)) return c;

          if (zone === "center") {
            // target 으로 source 의 모든 탭을 병합(그룹 합치기).
            return normalizeActiveGroupC({
              ...c,
              layout: mapGroupNode(tree, targetGroupId, (g) => ({
                ...g,
                views: [...g.views, ...source.views],
                activeViewId: source.activeViewId,
              })),
              activeGroupId: targetGroupId,
            });
          }
          // 그룹 통째로 target 옆에 재배치(같은 id·뷰 유지 → 본문 remount 없음).
          return normalizeActiveGroupC({
            ...c,
            layout: splitAtGroup(tree, targetGroupId, zone, source),
            activeGroupId: source.id,
          });
        }),
      ),
    })),

  resizeSplit: (projectId, splitId, sizes) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) =>
        mapActiveContent(t, (c) => ({
          ...c,
          layout: mapSplitNode(c.layout, splitId, sizes),
        })),
      ),
    })),

  splitNewTerminal: (projectId, targetGroupId, side) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) =>
        mapActiveContent(t, (c) => {
          if (!hasGroup(c.layout, targetGroupId)) return c;
          const v = newTerminalView();
          const fresh = makeGroup(v);
          return normalizeActiveGroupC({
            ...c,
            layout: splitAtGroup(c.layout, targetGroupId, side, fresh),
            activeGroupId: fresh.id,
          });
        }),
      ),
    })),

  splitPane: (projectId, viewId, paneId, dir) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) =>
        mapViewEverywhere(t, viewId, (v) => {
          if (v.kind !== "terminal") return v;
          const newId = newPaneId();
          return {
            ...v,
            layout: splitInTree(v.layout, paneId, dir, newId),
            focusedPaneId: newId,
          };
        }),
      ),
    })),

  closePane: (projectId, viewId, paneId) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) =>
        mapViewEverywhere(t, viewId, (v) => {
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
      ),
    })),

  setFocusedPane: (projectId, viewId, paneId) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) =>
        mapViewEverywhere(t, viewId, (v) =>
          v.kind === "terminal" ? { ...v, focusedPaneId: paneId } : v,
        ),
      ),
    })),
}));
