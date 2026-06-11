import { create } from "zustand";

// 2단 구조:
//   - 최상단 탭 = 프로젝트(ProjectTab): 자체 사이드바(파일트리) + 콘텐츠 영역
//   - 콘텐츠 영역 = 뷰 탭(View): 여러 터미널 뷰(각자 PaneTree 분할) + 파일 뷰
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

// 프로젝트가 처음 열 때 띄우는 프로그램.
export type Program = "terminal" | "claude" | "codex";

export interface ProjectTab {
  id: string;
  title: string; // 별칭
  sidebarOpen: boolean;
  views: View[];
  activeViewId: string;
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

  // 콘텐츠 뷰 레벨
  addTerminalView: (projectId: string) => void;
  openFileView: (projectId: string, path: string) => void;
  closeView: (projectId: string, viewId: string) => void;
  setActiveView: (projectId: string, viewId: string) => void;
  setFileMode: (projectId: string, viewId: string, mode: "code" | "preview") => void;
  setFileDirty: (projectId: string, viewId: string, dirty: boolean) => void;

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

const newViewId = () => `v${nextViewId++}`;
const newPaneId = () => `p${nextPaneId++}`;

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

// 트리에서 leaf id 를 모두 수집.
export function collectLeafIds(node: PaneNode, acc: string[] = []): string[] {
  if (node.type === "leaf") {
    acc.push(node.id);
  } else {
    for (const c of node.children) collectLeafIds(c, acc);
  }
  return acc;
}

// 모든 프로젝트·모든 터미널 뷰의 pane leaf id 를 수집(호스트 폐기 diff 용).
export function collectAllLeafIds(tabs: ProjectTab[]): string[] {
  const acc: string[] = [];
  for (const t of tabs) {
    for (const v of t.views) {
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
    for (const v of t.views) {
      if (v.kind === "terminal" && collectLeafIds(v.layout).includes(paneId)) {
        return t;
      }
    }
  }
  return undefined;
}

// leaf paneId 를 split{dir,[해당 leaf, 새 leaf]} 로 교체. 부모가 이미 같은 dir 인
// split 이면 그 자리에 새 leaf 를 이어 붙인다(중첩 회피).
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

// leaf paneId 를 제거. 자식이 하나만 남는 split 은 그 자식으로 붕괴. 루트가 자기 자신이면 null.
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

// 한 프로젝트의 views 를 변환하는 헬퍼(다른 프로젝트는 그대로).
function mapProject(
  tabs: ProjectTab[],
  projectId: string,
  fn: (t: ProjectTab) => ProjectTab,
): ProjectTab[] {
  return tabs.map((t) => (t.id === projectId ? fn(t) : t));
}

// 한 뷰를 변환(뷰 종류 보존).
function mapView(views: View[], viewId: string, fn: (v: View) => View): View[] {
  return views.map((v) => (v.id === viewId ? fn(v) : v));
}

function firstProject(): ProjectTab {
  const v = newTerminalView();
  return {
    id: "t1",
    title: "1",
    sidebarOpen: true,
    views: [v],
    activeViewId: v.id,
    program: "terminal",
    initialPaneId: v.kind === "terminal" ? v.focusedPaneId : "",
  };
}

export const useSessions = create<SessionsStore>((set) => ({
  tabs: [firstProject()],
  activeId: "t1",

  addProject: (opts) =>
    set((s) => {
      const id = `t${nextProjectId++}`;
      const v = newTerminalView();
      const alias =
        opts.alias.trim() ||
        (opts.root ? baseName(opts.root) : String(s.tabs.length + 1));
      return {
        tabs: [
          ...s.tabs,
          {
            id,
            title: alias,
            sidebarOpen: true,
            views: [v],
            activeViewId: v.id,
            root: opts.root,
            program: opts.program,
            initialPaneId: v.kind === "terminal" ? v.focusedPaneId : "",
          },
        ],
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

  addTerminalView: (projectId) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) => {
        const v = newTerminalView();
        return { ...t, views: [...t.views, v], activeViewId: v.id };
      }),
    })),

  openFileView: (projectId, path) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) => {
        // 이미 열린 같은 파일이면 그 뷰를 활성화(재사용).
        const existing = t.views.find(
          (v) => v.kind === "file" && v.path === path,
        );
        if (existing) return { ...t, activeViewId: existing.id };
        const v: View = {
          id: newViewId(),
          kind: "file",
          title: baseName(path),
          path,
          mode: "code",
        };
        return { ...t, views: [...t.views, v], activeViewId: v.id };
      }),
    })),

  closeView: (projectId, viewId) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) => {
        if (t.views.length <= 1) return t; // 최소 1개 뷰 유지
        const idx = t.views.findIndex((v) => v.id === viewId);
        if (idx === -1) return t;
        const views = t.views.filter((v) => v.id !== viewId);
        let activeViewId = t.activeViewId;
        if (activeViewId === viewId) {
          activeViewId = (views[idx] ?? views[idx - 1] ?? views[0]).id;
        }
        return { ...t, views, activeViewId };
      }),
    })),

  setActiveView: (projectId, viewId) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) => ({
        ...t,
        activeViewId: viewId,
      })),
    })),

  setFileMode: (projectId, viewId, mode) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) => ({
        ...t,
        views: mapView(t.views, viewId, (v) =>
          v.kind === "file" ? { ...v, mode } : v,
        ),
      })),
    })),

  setFileDirty: (projectId, viewId, dirty) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) => ({
        ...t,
        views: mapView(t.views, viewId, (v) =>
          v.kind === "file" ? { ...v, dirty } : v,
        ),
      })),
    })),

  splitPane: (projectId, viewId, paneId, dir) =>
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (t) => ({
        ...t,
        views: mapView(t.views, viewId, (v) => {
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
        views: mapView(t.views, viewId, (v) => {
          if (v.kind !== "terminal") return v;
          if (collectLeafIds(v.layout).length <= 1) return v; // 마지막 pane 유지
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
        views: mapView(t.views, viewId, (v) =>
          v.kind === "terminal" ? { ...v, focusedPaneId: paneId } : v,
        ),
      })),
    })),
}));
