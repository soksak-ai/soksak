import { create } from "zustand";
import { useSettings } from "./settings";

// 3단 구조:
//   - 최상단 탭 = 프로젝트(ProjectTab): 자체 사이드바(파일트리) + 컨텐츠 탭들
//   - 컨텐츠(ContentArea) = 그룹 트리(GroupNode): 에디터 그룹처럼 좌/우/상/하 재귀 분할.
//       각 leaf = ViewGroup(자체 헤더 + 활성 뷰). 드래그/명령으로 분할·이동·병합.
//   - 뷰(View) = 터미널(내부 PaneTree 분할 가능) / 파일 / 브라우저.
// 비활성 프로젝트/컨텐츠/뷰는 언마운트하지 않고 숨겨 세션(PTY/에디터/웹뷰)을 유지한다.
//
// 설계 원칙(AI 명령 인터페이스의 기초):
//   - 모든 변이 액션은 CmdResult 를 반환한다 — 생성된 id/변경 후 상태(검증 가능).
//   - 조용한 실패 금지 — 수행 불가는 구조화 에러({code, message}).
//   - 대상 지정은 활성 컨텐츠 한정이 아니라 프로젝트 전체에서 검색(임의 위치 타기팅).
//   - 요청 의도가 이미 충족된 상태면 idempotent 성공(ok)으로 처리.

// ── 결과 타입 ────────────────────────────────────────────────────────────────

export type CmdErrCode =
  | "TARGET_NOT_FOUND"
  | "LAST_ITEM"
  | "INVALID_PARAMS"
  // 플러그인 활성화에 사용자 동의가 필요(원격 enable 거부 — 플러그인 스펙 §0-5).
  | "CONSENT_REQUIRED";

export type CmdErr = { ok: false; code: CmdErrCode; message: string };
export type CmdOk<T extends object = object> = { ok: true } & T;
export type CmdResult<T extends object = object> = CmdOk<T> | CmdErr;

export const ok = <T extends object>(data: T): CmdOk<T> => ({
  ok: true,
  ...data,
});
export const err = (code: CmdErrCode, message: string): CmdErr => ({
  ok: false,
  code,
  message,
});

// ── 모델 타입 ────────────────────────────────────────────────────────────────

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
      // 이 pane 의 셸이 뜨면 1회 자동 실행할 프로그램(claude/codex 뷰).
      autorun?: { paneId: string; program: "claude" | "codex" };
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
    }
  // 플러그인 뷰(콘텐츠 배치) — 전역 키 "<pluginId>.<view>" 의 provider 를
  // PluginViewHost 가 그린다. 닫기/이동/드래그는 일반 뷰와 동일(view id 제네릭).
  | {
      id: string;
      kind: "plugin";
      title: string;
      pluginId: string;
      view: string; // 플러그인 내 뷰 id
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

export type Side = "left" | "right" | "top" | "bottom";

// 컨텐츠가 처음 열 때 띄우는 프로그램(첫 화면).
export type Program = "terminal" | "claude" | "codex" | "browser";

// 브라우저 뷰 기본 시작 페이지(설정 homeUrl).
export function browserHome(): string {
  return useSettings.getState().homeUrl;
}

// 컨텐츠 탭: 한 프로젝트 안의 독립 콘텐츠 영역(분할 그리드). 프로젝트당 여러 개 + 전환.
// 프로그램 자동 실행은 터미널 뷰의 autorun 이 담당(뷰 단위로 일반화).
export interface ContentArea {
  id: string;
  title: string; // 1,2,3,… (이름변경 가능)
  // 이 컨텐츠의 첫 화면 프로그램(생성 시 확정: 명시 선택 > 프로젝트 설정 > 전역 설정).
  program: Program;
  layout: GroupNode; // 그룹(분할) 트리
  activeGroupId: string;
}

export interface ProjectTab {
  id: string;
  title: string; // 별칭
  sidebarOpen: boolean;
  // 우측 플러그인 사이드바: 열림 + 활성 뷰("<pluginId>.<viewId>" | "manager" | null).
  rightOpen: boolean;
  rightView: string | null;
  // 좌측 사이드바 활성 탭: "files"(파일 트리) 또는 플러그인 뷰 전역 키(좌측 호스팅).
  leftTab: string;
  // 프로젝트 루트 디렉토리(터미널 시작 위치). 미지정이면 앱 실행 디렉토리.
  root?: string;
  // 프로젝트의 첫 화면(미지정이면 전역 설정 defaultProgram 사용 — 프로젝트 설정이 우선).
  program?: Program;
  // 프로젝트의 터미널 셸(미지정이면 전역 설정 shell → 시스템 $SHELL).
  shell?: string;
  // 컨텐츠 탭들 + 활성.
  contents: ContentArea[];
  activeContentId: string;
}

export interface NewProjectOpts {
  alias: string;
  root?: string;
  program?: Program; // undefined = 전역 설정 따름
  shell?: string; // undefined = 전역 설정 따름
}

// 첫 화면 결정: 명시 선택 > 프로젝트 설정 > 전역 설정.
function effectiveProgram(explicit?: Program, project?: Program): Program {
  return explicit ?? project ?? useSettings.getState().defaultProgram;
}

// ── 액션 결과 형태 ──────────────────────────────────────────────────────────

// 새 뷰 생성 결과(터미널이면 paneId 포함).
export interface NewViewIds {
  viewId: string;
  paneId?: string;
}

interface SessionsStore {
  tabs: ProjectTab[]; // 프로젝트들
  activeId: string;

  // 프로젝트 레벨
  addProject: (
    opts: NewProjectOpts,
  ) => CmdResult<{ projectId: string; contentId: string; groupId: string } & NewViewIds>;
  closeTab: (id: string) => CmdResult<{ activeProjectId: string }>;
  setActive: (id: string) => CmdResult;
  renameTab: (id: string, title: string) => CmdResult;
  toggleSidebar: (id: string) => CmdResult<{ sidebarOpen: boolean }>;
  // 우측 플러그인 사이드바. open 명시 시 그 상태로(멱등), 생략 시 토글.
  toggleRightSidebar: (
    id: string,
    open?: boolean,
  ) => CmdResult<{ rightOpen: boolean }>;
  setRightView: (
    id: string,
    view: string | null,
  ) => CmdResult<{ rightView: string | null }>;
  setLeftTab: (id: string, tab: string) => CmdResult<{ leftTab: string }>;

  // 컨텐츠 탭 레벨. program 명시 시 그 프로그램으로(+메뉴), 아니면 프로젝트>전역 설정.
  addContent: (
    projectId: string,
    program?: Program,
  ) => CmdResult<{ contentId: string; groupId: string } & NewViewIds>;
  closeContent: (
    projectId: string,
    contentId: string,
  ) => CmdResult<{ activeContentId: string }>;
  setActiveContent: (projectId: string, contentId: string) => CmdResult;
  renameContent: (
    projectId: string,
    contentId: string,
    title: string,
  ) => CmdResult;

  // 콘텐츠 뷰/그룹 레벨. 그룹에 프로그램별 새 뷰 탭(터미널/claude/codex/브라우저).
  addViewToGroup: (
    projectId: string,
    program: Program,
    groupId?: string,
    opts?: { url?: string },
  ) => CmdResult<{ groupId: string } & NewViewIds>;
  // 그룹(패널) 통째 닫기 — 안의 모든 뷰 제거(마지막 그룹이면 거부).
  closeGroup: (
    projectId: string,
    groupId: string,
  ) => CmdResult<{ activeGroupId: string }>;
  openFileView: (
    projectId: string,
    path: string,
  ) => CmdResult<{ viewId: string; groupId: string; existing: boolean }>;
  // 플러그인 뷰를 콘텐츠 탭으로(중복 판정 키 = pluginId+view, openFileView 대칭).
  openPluginView: (
    projectId: string,
    pluginId: string,
    view: string,
    title: string,
  ) => CmdResult<{ viewId: string; groupId: string; existing: boolean }>;
  closeView: (
    projectId: string,
    viewId: string,
  ) => CmdResult<{ activeGroupId: string; activeViewId: string }>;
  setActiveView: (projectId: string, viewId: string) => CmdResult;
  setActiveGroup: (projectId: string, groupId: string) => CmdResult;
  setFileMode: (
    projectId: string,
    viewId: string,
    mode: "code" | "preview",
  ) => CmdResult;
  setFileDirty: (projectId: string, viewId: string, dirty: boolean) => CmdResult;
  // 브라우저 뷰 URL 동기화(네비게이션 이벤트/URL 바 입력).
  setBrowserUrl: (projectId: string, viewId: string, url: string) => CmdResult;
  setBrowserTitle: (
    projectId: string,
    viewId: string,
    title: string,
  ) => CmdResult;
  // 드래그/명령 분할·이동: viewId 를 targetGroup 의 zone 위치로.
  moveViewToGroup: (
    projectId: string,
    viewId: string,
    targetGroupId: string,
    zone: DropZone,
  ) => CmdResult<{ groupId: string }>;
  // 그룹 전체(타이틀바 드래그/명령)를 targetGroup 의 zone 위치로. center=병합.
  moveGroupToGroup: (
    projectId: string,
    sourceGroupId: string,
    targetGroupId: string,
    zone: DropZone,
  ) => CmdResult<{ groupId: string }>;
  // 분할 비율 조절(리사이저 드래그/명령).
  resizeSplit: (
    projectId: string,
    splitId: string,
    sizes: number[],
  ) => CmdResult;
  // targetGroup 옆에 새 뷰 그룹을 분할 생성(split 버튼 / title 모드 ⌘T / 명령).
  splitWithNewView: (
    projectId: string,
    targetGroupId: string,
    side: Side,
    program?: Program,
  ) => CmdResult<{ groupId: string } & NewViewIds>;

  // pane 레벨(특정 터미널 뷰 안에서)
  splitPane: (
    projectId: string,
    viewId: string,
    paneId: string,
    dir: "row" | "col",
  ) => CmdResult<{ paneId: string }>;
  closePane: (
    projectId: string,
    viewId: string,
    paneId: string,
  ) => CmdResult<{ focusedPaneId: string }>;
  setFocusedPane: (
    projectId: string,
    viewId: string,
    paneId: string,
  ) => CmdResult;
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

// 새 터미널 뷰(빈 단일 pane). claude/codex 면 그 pane 에서 1회 자동 실행.
function newTerminalView(program?: Program): View {
  const paneId = newPaneId();
  const autorun =
    program === "claude" || program === "codex"
      ? { paneId, program }
      : undefined;
  return {
    id: newViewId(),
    kind: "terminal",
    title: "터미널",
    layout: leaf(paneId),
    focusedPaneId: paneId,
    ...(autorun ? { autorun } : {}),
  };
}

function makeGroup(view: View): ViewGroup {
  return { id: newGroupId(), views: [view], activeViewId: view.id };
}

// 새 브라우저 뷰(url 미지정 시 홈).
function newBrowserView(url?: string): View {
  return {
    id: newViewId(),
    kind: "browser",
    title: "브라우저",
    url: url ?? browserHome(),
  };
}

// 프로그램에 맞는 새 뷰(브라우저 → 브라우저 뷰, 그 외 → 터미널 뷰[+autorun]).
function newViewFor(program: Program, opts?: { url?: string }): View {
  return program === "browser"
    ? newBrowserView(opts?.url)
    : newTerminalView(program);
}

// 뷰의 새 id 묶음(터미널이면 paneId 포함) — 생성 명령 응답용.
function idsOfView(v: View): NewViewIds {
  return v.kind === "terminal"
    ? { viewId: v.id, paneId: v.focusedPaneId }
    : { viewId: v.id };
}

// 새 컨텐츠 영역(단일 그룹 + 첫 화면 뷰).
function makeContent(title: string, program: Program): ContentArea {
  const g = makeGroup(newViewFor(program));
  return {
    id: newContentId(),
    title,
    program,
    layout: { type: "leaf", group: g },
    activeGroupId: g.id,
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

// split 노드 sizes 변환. 적용했으면 true.
function findSplit(node: GroupNode, splitId: string): boolean {
  if (node.type === "leaf") return false;
  if (node.id === splitId) return true;
  return node.children.some((c) => findSplit(c, splitId));
}

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

// targetGroup 을 fresh 그룹과 분할(side 방향). 이미 같은 방향 split 의 직속 자식이면
// 형제로 삽입(중첩 회피).
function splitAtGroup(
  node: GroupNode,
  targetGroupId: string,
  side: Side,
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
    return {
      type: "split",
      id: newSplitId(),
      dir,
      children,
      sizes: equalSizes(2),
    };
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

// paneId 의 spawn 정보: cwd=프로젝트 root, shell=프로젝트>전역 설정,
// program=그 pane 이 뷰의 autorun 대상일 때만.
export function paneSpawnInfo(
  tabs: ProjectTab[],
  paneId: string,
): { cwd?: string; shell?: string; program?: Program } {
  for (const t of tabs) {
    for (const c of t.contents) {
      for (const v of allViews(c.layout)) {
        if (v.kind === "terminal" && collectLeafIds(v.layout).includes(paneId)) {
          const shell = t.shell || useSettings.getState().shell || undefined;
          return {
            cwd: t.root,
            shell,
            program:
              v.autorun?.paneId === paneId ? v.autorun.program : undefined,
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

// ── 검색/변환 헬퍼 ───────────────────────────────────────────────────────────

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

// 그룹/뷰가 속한 컨텐츠를 프로젝트 전체에서 검색(임의 위치 타기팅).
function contentOfGroup(
  t: ProjectTab,
  groupId: string,
): ContentArea | undefined {
  return t.contents.find((c) => hasGroup(c.layout, groupId));
}

function contentOfView(
  t: ProjectTab,
  viewId: string,
): ContentArea | undefined {
  return t.contents.find((c) =>
    allViews(c.layout).some((v) => v.id === viewId),
  );
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
    rightOpen: false,
    rightView: null,
    leftTab: "files",
    program: "terminal",
    contents: [c],
    activeContentId: c.id,
  };
}

function makeProject(
  id: string,
  opts: NewProjectOpts,
  index: number,
): ProjectTab {
  const c = makeContent("1", effectiveProgram(undefined, opts.program));
  const alias =
    opts.alias.trim() || (opts.root ? baseName(opts.root) : String(index));
  return {
    id,
    title: alias,
    sidebarOpen: true,
    rightOpen: false,
    rightView: null,
    leftTab: "files",
    root: opts.root,
    program: opts.program,
    shell: opts.shell,
    contents: [c],
    activeContentId: c.id,
  };
}

// 자주 쓰는 에러.
const noProject = (id: string): CmdErr =>
  err("TARGET_NOT_FOUND", `프로젝트 없음: ${id}`);

export const useSessions = create<SessionsStore>((set, get) => ({
  tabs: [firstProject()],
  activeId: "t1",

  addProject: (opts) => {
    const id = `t${nextProjectId++}`;
    const t = makeProject(id, opts, get().tabs.length + 1);
    set((s) => ({ tabs: [...s.tabs, t], activeId: id }));
    const c = t.contents[0];
    const g = allGroups(c.layout)[0];
    return ok({
      projectId: id,
      contentId: c.id,
      groupId: g.id,
      ...idsOfView(g.views[0]),
    });
  },

  closeTab: (id) => {
    let r: CmdResult<{ activeProjectId: string }> = noProject(id);
    set((s) => {
      if (!s.tabs.some((t) => t.id === id)) return s;
      if (s.tabs.length <= 1) {
        r = err("LAST_ITEM", "마지막 프로젝트는 닫을 수 없음");
        return s;
      }
      const idx = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      let activeId = s.activeId;
      if (activeId === id) {
        activeId = (tabs[idx] ?? tabs[idx - 1] ?? tabs[0]).id;
      }
      r = ok({ activeProjectId: activeId });
      return { tabs, activeId };
    });
    return r;
  },

  setActive: (id) => {
    let r: CmdResult = noProject(id);
    set((s) => {
      if (!s.tabs.some((t) => t.id === id)) return s;
      r = ok({});
      return s.activeId === id ? s : { activeId: id };
    });
    return r;
  },

  renameTab: (id, title) => {
    let r: CmdResult = noProject(id);
    set((s) => {
      if (!s.tabs.some((t) => t.id === id)) return s;
      r = ok({});
      return { tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)) };
    });
    return r;
  },

  toggleSidebar: (id) => {
    let r: CmdResult<{ sidebarOpen: boolean }> = noProject(id);
    set((s) => {
      const t = s.tabs.find((x) => x.id === id);
      if (!t) return s;
      r = ok({ sidebarOpen: !t.sidebarOpen });
      return {
        tabs: s.tabs.map((x) =>
          x.id === id ? { ...x, sidebarOpen: !x.sidebarOpen } : x,
        ),
      };
    });
    return r;
  },

  toggleRightSidebar: (id, open) => {
    let r: CmdResult<{ rightOpen: boolean }> = noProject(id);
    set((s) => {
      const t = s.tabs.find((x) => x.id === id);
      if (!t) return s;
      const rightOpen = open ?? !t.rightOpen;
      r = ok({ rightOpen });
      if (rightOpen === t.rightOpen) return s; // 멱등
      return {
        tabs: s.tabs.map((x) => (x.id === id ? { ...x, rightOpen } : x)),
      };
    });
    return r;
  },

  setRightView: (id, view) => {
    let r: CmdResult<{ rightView: string | null }> = noProject(id);
    set((s) => {
      const t = s.tabs.find((x) => x.id === id);
      if (!t) return s;
      r = ok({ rightView: view });
      if (t.rightView === view) return s;
      return {
        tabs: s.tabs.map((x) => (x.id === id ? { ...x, rightView: view } : x)),
      };
    });
    return r;
  },

  setLeftTab: (id, tab) => {
    let r: CmdResult<{ leftTab: string }> = noProject(id);
    set((s) => {
      const t = s.tabs.find((x) => x.id === id);
      if (!t) return s;
      r = ok({ leftTab: tab });
      if (t.leftTab === tab) return s;
      return {
        tabs: s.tabs.map((x) => (x.id === id ? { ...x, leftTab: tab } : x)),
      };
    });
    return r;
  },

  addContent: (projectId, program) => {
    let r: CmdResult<{ contentId: string; groupId: string } & NewViewIds> =
      noProject(projectId);
    set((s) => {
      const t = s.tabs.find((x) => x.id === projectId);
      if (!t) return s;
      const nextNum =
        Math.max(0, ...t.contents.map((c) => parseInt(c.title, 10) || 0)) + 1;
      const c = makeContent(String(nextNum), effectiveProgram(program, t.program));
      const g = allGroups(c.layout)[0];
      r = ok({ contentId: c.id, groupId: g.id, ...idsOfView(g.views[0]) });
      return {
        tabs: mapProject(s.tabs, projectId, (x) => ({
          ...x,
          contents: [...x.contents, c],
          activeContentId: c.id,
        })),
      };
    });
    return r;
  },

  closeContent: (projectId, contentId) => {
    let r: CmdResult<{ activeContentId: string }> = noProject(projectId);
    set((s) => {
      const t = s.tabs.find((x) => x.id === projectId);
      if (!t) return s;
      const idx = t.contents.findIndex((c) => c.id === contentId);
      if (idx === -1) {
        r = err("TARGET_NOT_FOUND", `컨텐츠 없음: ${contentId}`);
        return s;
      }
      if (t.contents.length <= 1) {
        r = err("LAST_ITEM", "마지막 컨텐츠는 닫을 수 없음");
        return s;
      }
      const contents = t.contents.filter((c) => c.id !== contentId);
      let activeContentId = t.activeContentId;
      if (activeContentId === contentId) {
        activeContentId = (contents[idx] ?? contents[idx - 1] ?? contents[0]).id;
      }
      r = ok({ activeContentId });
      return {
        tabs: mapProject(s.tabs, projectId, (x) => ({
          ...x,
          contents,
          activeContentId,
        })),
      };
    });
    return r;
  },

  setActiveContent: (projectId, contentId) => {
    let r: CmdResult = noProject(projectId);
    set((s) => {
      const t = s.tabs.find((x) => x.id === projectId);
      if (!t) return s;
      if (!t.contents.some((c) => c.id === contentId)) {
        r = err("TARGET_NOT_FOUND", `컨텐츠 없음: ${contentId}`);
        return s;
      }
      r = ok({});
      if (t.activeContentId === contentId) return s; // 이미 활성(불필요 재렌더 방지)
      return {
        tabs: mapProject(s.tabs, projectId, (x) => ({
          ...x,
          activeContentId: contentId,
        })),
      };
    });
    return r;
  },

  renameContent: (projectId, contentId, title) => {
    let r: CmdResult = noProject(projectId);
    set((s) => {
      const t = s.tabs.find((x) => x.id === projectId);
      if (!t) return s;
      if (!t.contents.some((c) => c.id === contentId)) {
        r = err("TARGET_NOT_FOUND", `컨텐츠 없음: ${contentId}`);
        return s;
      }
      r = ok({});
      return {
        tabs: mapProject(s.tabs, projectId, (x) =>
          mapContent(x, contentId, (c) => ({ ...c, title })),
        ),
      };
    });
    return r;
  },

  addViewToGroup: (projectId, program, groupId, opts) => {
    let r: CmdResult<{ groupId: string } & NewViewIds> = noProject(projectId);
    set((s) => {
      const t = s.tabs.find((x) => x.id === projectId);
      if (!t) return s;
      // 대상 그룹: 명시 id(전체 컨텐츠에서 검색) 또는 활성 컨텐츠의 활성 그룹.
      const content = groupId
        ? contentOfGroup(t, groupId)
        : activeContentOf(t);
      if (!content) {
        r = err("TARGET_NOT_FOUND", `그룹 없음: ${groupId ?? "(활성)"}`);
        return s;
      }
      const target = groupId ?? content.activeGroupId;
      const v = newViewFor(program, opts);
      r = ok({ groupId: target, ...idsOfView(v) });
      return {
        tabs: mapProject(s.tabs, projectId, (x) =>
          mapContent(x, content.id, (c) => ({
            ...c,
            layout: mapGroupNode(c.layout, target, (g) => ({
              ...g,
              views: [...g.views, v],
              activeViewId: v.id,
            })),
            activeGroupId: target,
          })),
        ),
      };
    });
    return r;
  },

  openFileView: (projectId, path) => {
    let r: CmdResult<{ viewId: string; groupId: string; existing: boolean }> =
      noProject(projectId);
    set((s) => {
      const t = s.tabs.find((x) => x.id === projectId);
      if (!t) return s;
      const content = activeContentOf(t);
      if (!content) return s;
      // 이미 열린 같은 파일이면 그 그룹/뷰를 활성화(재사용).
      const existing = allViews(content.layout).find(
        (v) => v.kind === "file" && v.path === path,
      );
      if (existing) {
        const grp = findGroupOfView(content.layout, existing.id);
        if (!grp) return s;
        r = ok({ viewId: existing.id, groupId: grp.id, existing: true });
        return {
          tabs: mapProject(s.tabs, projectId, (x) =>
            mapContent(x, content.id, (c) => ({
              ...c,
              layout: mapGroupNode(c.layout, grp.id, (g) => ({
                ...g,
                activeViewId: existing.id,
              })),
              activeGroupId: grp.id,
            })),
          ),
        };
      }
      const v: View = {
        id: newViewId(),
        kind: "file",
        title: baseName(path),
        path,
        mode: "code",
      };
      r = ok({ viewId: v.id, groupId: content.activeGroupId, existing: false });
      return {
        tabs: mapProject(s.tabs, projectId, (x) =>
          mapContent(x, content.id, (c) => ({
            ...c,
            layout: mapGroupNode(c.layout, c.activeGroupId, (g) => ({
              ...g,
              views: [...g.views, v],
              activeViewId: v.id,
            })),
          })),
        ),
      };
    });
    return r;
  },

  openPluginView: (projectId, pluginId, view, title) => {
    let r: CmdResult<{ viewId: string; groupId: string; existing: boolean }> =
      noProject(projectId);
    set((s) => {
      const t = s.tabs.find((x) => x.id === projectId);
      if (!t) return s;
      const content = activeContentOf(t);
      if (!content) return s;
      // 같은 플러그인 뷰가 이미 열려 있으면 그 그룹/뷰를 활성화(재사용).
      const existing = allViews(content.layout).find(
        (v) => v.kind === "plugin" && v.pluginId === pluginId && v.view === view,
      );
      if (existing) {
        const grp = findGroupOfView(content.layout, existing.id);
        if (!grp) return s;
        r = ok({ viewId: existing.id, groupId: grp.id, existing: true });
        return {
          tabs: mapProject(s.tabs, projectId, (x) =>
            mapContent(x, content.id, (c) => ({
              ...c,
              layout: mapGroupNode(c.layout, grp.id, (g) => ({
                ...g,
                activeViewId: existing.id,
              })),
              activeGroupId: grp.id,
            })),
          ),
        };
      }
      const v: View = {
        id: newViewId(),
        kind: "plugin",
        title,
        pluginId,
        view,
      };
      r = ok({ viewId: v.id, groupId: content.activeGroupId, existing: false });
      return {
        tabs: mapProject(s.tabs, projectId, (x) =>
          mapContent(x, content.id, (c) => ({
            ...c,
            layout: mapGroupNode(c.layout, c.activeGroupId, (g) => ({
              ...g,
              views: [...g.views, v],
              activeViewId: v.id,
            })),
          })),
        ),
      };
    });
    return r;
  },

  closeView: (projectId, viewId) => {
    let r: CmdResult<{ activeGroupId: string; activeViewId: string }> =
      noProject(projectId);
    set((s) => {
      const t = s.tabs.find((x) => x.id === projectId);
      if (!t) return s;
      const content = contentOfView(t, viewId);
      if (!content) {
        r = err("TARGET_NOT_FOUND", `뷰 없음: ${viewId}`);
        return s;
      }
      if (allViews(content.layout).length <= 1) {
        r = err("LAST_ITEM", "컨텐츠의 마지막 뷰는 닫을 수 없음");
        return s;
      }
      const { tree } = removeView(content.layout, viewId);
      if (!tree) return s;
      const next = normalizeActiveGroupC({ ...content, layout: tree });
      const activeGroup = findGroup(next.layout, next.activeGroupId);
      r = ok({
        activeGroupId: next.activeGroupId,
        activeViewId: activeGroup?.activeViewId ?? "",
      });
      return {
        tabs: mapProject(s.tabs, projectId, (x) =>
          mapContent(x, content.id, () => next),
        ),
      };
    });
    return r;
  },

  setActiveView: (projectId, viewId) => {
    let r: CmdResult = noProject(projectId);
    set((s) => {
      const t = s.tabs.find((x) => x.id === projectId);
      if (!t) return s;
      const content = contentOfView(t, viewId);
      if (!content) {
        r = err("TARGET_NOT_FOUND", `뷰 없음: ${viewId}`);
        return s;
      }
      const grp = findGroupOfView(content.layout, viewId);
      if (!grp) return s;
      r = ok({});
      return {
        tabs: mapProject(s.tabs, projectId, (x) =>
          mapContent(x, content.id, (c) => ({
            ...c,
            layout: mapGroupNode(c.layout, grp.id, (g) => ({
              ...g,
              activeViewId: viewId,
            })),
            activeGroupId: grp.id,
          })),
        ),
      };
    });
    return r;
  },

  setActiveGroup: (projectId, groupId) => {
    let r: CmdResult = noProject(projectId);
    set((s) => {
      const t = s.tabs.find((x) => x.id === projectId);
      if (!t) return s;
      const content = contentOfGroup(t, groupId);
      if (!content) {
        r = err("TARGET_NOT_FOUND", `그룹 없음: ${groupId}`);
        return s;
      }
      r = ok({});
      // 이미 활성이면 상태 변경 없음(본문 클릭마다 불필요한 재렌더 방지).
      if (
        content.id === t.activeContentId &&
        content.activeGroupId === groupId
      ) {
        return s;
      }
      return {
        tabs: mapProject(s.tabs, projectId, (x) => ({
          ...mapContent(x, content.id, (c) => ({
            ...c,
            activeGroupId: groupId,
          })),
          activeContentId: content.id,
        })),
      };
    });
    return r;
  },

  setFileMode: (projectId, viewId, mode) => {
    let r: CmdResult = noProject(projectId);
    set((s) => {
      const t = s.tabs.find((x) => x.id === projectId);
      if (!t) return s;
      if (!contentOfView(t, viewId)) {
        r = err("TARGET_NOT_FOUND", `뷰 없음: ${viewId}`);
        return s;
      }
      r = ok({});
      return {
        tabs: mapProject(s.tabs, projectId, (x) =>
          mapViewEverywhere(x, viewId, (v) =>
            v.kind === "file" ? { ...v, mode } : v,
          ),
        ),
      };
    });
    return r;
  },

  setFileDirty: (projectId, viewId, dirty) => {
    let r: CmdResult = noProject(projectId);
    set((s) => {
      const t = s.tabs.find((x) => x.id === projectId);
      if (!t) return s;
      if (!contentOfView(t, viewId)) {
        r = err("TARGET_NOT_FOUND", `뷰 없음: ${viewId}`);
        return s;
      }
      r = ok({});
      return {
        tabs: mapProject(s.tabs, projectId, (x) =>
          mapViewEverywhere(x, viewId, (v) =>
            v.kind === "file" ? { ...v, dirty } : v,
          ),
        ),
      };
    });
    return r;
  },

  setBrowserUrl: (projectId, viewId, url) => {
    let r: CmdResult = noProject(projectId);
    set((s) => {
      const t = s.tabs.find((x) => x.id === projectId);
      if (!t) return s;
      if (!contentOfView(t, viewId)) {
        r = err("TARGET_NOT_FOUND", `뷰 없음: ${viewId}`);
        return s;
      }
      r = ok({});
      return {
        tabs: mapProject(s.tabs, projectId, (x) =>
          mapViewEverywhere(x, viewId, (v) =>
            v.kind === "browser" ? { ...v, url } : v,
          ),
        ),
      };
    });
    return r;
  },

  // 브라우저 뷰의 탭/타이틀 제목(문서 <title>). 빈 문자열은 무시.
  setBrowserTitle: (projectId, viewId, title) => {
    const trimmed = title.trim();
    let r: CmdResult = noProject(projectId);
    set((s) => {
      const t = s.tabs.find((x) => x.id === projectId);
      if (!t) return s;
      if (!contentOfView(t, viewId)) {
        r = err("TARGET_NOT_FOUND", `뷰 없음: ${viewId}`);
        return s;
      }
      r = ok({});
      if (!trimmed) return s;
      return {
        tabs: mapProject(s.tabs, projectId, (x) =>
          mapViewEverywhere(x, viewId, (v) =>
            v.kind === "browser" ? { ...v, title: trimmed } : v,
          ),
        ),
      };
    });
    return r;
  },

  moveViewToGroup: (projectId, viewId, targetGroupId, zone) => {
    let r: CmdResult<{ groupId: string }> = noProject(projectId);
    set((s) => {
      const t = s.tabs.find((x) => x.id === projectId);
      if (!t) return s;
      const content = contentOfView(t, viewId);
      if (!content) {
        r = err("TARGET_NOT_FOUND", `뷰 없음: ${viewId}`);
        return s;
      }
      // 같은 컨텐츠 안의 대상 그룹만 허용(컨텐츠 간 이동은 별도 개념).
      if (!hasGroup(content.layout, targetGroupId)) {
        r = err("TARGET_NOT_FOUND", `대상 그룹 없음(같은 컨텐츠 내): ${targetGroupId}`);
        return s;
      }
      const src = findGroupOfView(content.layout, viewId);
      if (!src) return s;
      const view = src.views.find((v) => v.id === viewId);
      if (!view) return s;

      if (zone === "center") {
        if (src.id === targetGroupId) {
          r = ok({ groupId: targetGroupId }); // 이미 그 그룹 — idempotent
          return s;
        }
        const { tree } = removeView(content.layout, viewId);
        if (!tree || !hasGroup(tree, targetGroupId)) return s;
        r = ok({ groupId: targetGroupId });
        return {
          tabs: mapProject(s.tabs, projectId, (x) =>
            mapContent(x, content.id, (c) =>
              normalizeActiveGroupC({
                ...c,
                layout: mapGroupNode(tree, targetGroupId, (g) => ({
                  ...g,
                  views: [...g.views, view],
                  activeViewId: view.id,
                })),
                activeGroupId: targetGroupId,
              }),
            ),
          ),
        };
      }

      // 분할: src 에서 떼고 target 옆에 새 그룹으로.
      if (allViews(content.layout).length <= 1) {
        r = err("LAST_ITEM", "유일한 뷰는 분할할 수 없음");
        return s;
      }
      const { tree } = removeView(content.layout, viewId);
      if (!tree || !hasGroup(tree, targetGroupId)) return s;
      const fresh = makeGroup(view);
      r = ok({ groupId: fresh.id });
      return {
        tabs: mapProject(s.tabs, projectId, (x) =>
          mapContent(x, content.id, (c) =>
            normalizeActiveGroupC({
              ...c,
              layout: splitAtGroup(tree, targetGroupId, zone, fresh),
              activeGroupId: fresh.id,
            }),
          ),
        ),
      };
    });
    return r;
  },

  closeGroup: (projectId, groupId) => {
    let r: CmdResult<{ activeGroupId: string }> = noProject(projectId);
    set((s) => {
      const t = s.tabs.find((x) => x.id === projectId);
      if (!t) return s;
      const content = contentOfGroup(t, groupId);
      if (!content) {
        r = err("TARGET_NOT_FOUND", `그룹 없음: ${groupId}`);
        return s;
      }
      if (allGroups(content.layout).length <= 1) {
        r = err("LAST_ITEM", "컨텐츠의 마지막 패널은 닫을 수 없음(컨텐츠 닫기를 사용)");
        return s;
      }
      const { tree } = removeGroup(content.layout, groupId);
      if (!tree) return s;
      const next = normalizeActiveGroupC({ ...content, layout: tree });
      r = ok({ activeGroupId: next.activeGroupId });
      return {
        tabs: mapProject(s.tabs, projectId, (x) =>
          mapContent(x, content.id, () => next),
        ),
      };
    });
    return r;
  },

  moveGroupToGroup: (projectId, sourceGroupId, targetGroupId, zone) => {
    let r: CmdResult<{ groupId: string }> = noProject(projectId);
    set((s) => {
      const t = s.tabs.find((x) => x.id === projectId);
      if (!t) return s;
      const content = contentOfGroup(t, sourceGroupId);
      if (!content) {
        r = err("TARGET_NOT_FOUND", `그룹 없음: ${sourceGroupId}`);
        return s;
      }
      if (sourceGroupId === targetGroupId) {
        r = ok({ groupId: targetGroupId }); // idempotent
        return s;
      }
      if (!hasGroup(content.layout, targetGroupId)) {
        r = err("TARGET_NOT_FOUND", `대상 그룹 없음(같은 컨텐츠 내): ${targetGroupId}`);
        return s;
      }
      if (allGroups(content.layout).length <= 1) {
        r = err("LAST_ITEM", "유일한 그룹은 이동할 수 없음");
        return s;
      }
      const source = findGroup(content.layout, sourceGroupId);
      if (!source) return s;
      const { tree } = removeGroup(content.layout, sourceGroupId);
      if (!tree || !hasGroup(tree, targetGroupId)) return s;

      if (zone === "center") {
        // target 으로 source 의 모든 탭을 병합(그룹 합치기).
        r = ok({ groupId: targetGroupId });
        return {
          tabs: mapProject(s.tabs, projectId, (x) =>
            mapContent(x, content.id, (c) =>
              normalizeActiveGroupC({
                ...c,
                layout: mapGroupNode(tree, targetGroupId, (g) => ({
                  ...g,
                  views: [...g.views, ...source.views],
                  activeViewId: source.activeViewId,
                })),
                activeGroupId: targetGroupId,
              }),
            ),
          ),
        };
      }
      // 그룹 통째로 target 옆에 재배치(같은 id·뷰 유지 → 본문 remount 없음).
      r = ok({ groupId: source.id });
      return {
        tabs: mapProject(s.tabs, projectId, (x) =>
          mapContent(x, content.id, (c) =>
            normalizeActiveGroupC({
              ...c,
              layout: splitAtGroup(tree, targetGroupId, zone, source),
              activeGroupId: source.id,
            }),
          ),
        ),
      };
    });
    return r;
  },

  resizeSplit: (projectId, splitId, sizes) => {
    let r: CmdResult = noProject(projectId);
    set((s) => {
      const t = s.tabs.find((x) => x.id === projectId);
      if (!t) return s;
      const content = t.contents.find((c) => findSplit(c.layout, splitId));
      if (!content) {
        r = err("TARGET_NOT_FOUND", `분할 없음: ${splitId}`);
        return s;
      }
      r = ok({});
      return {
        tabs: mapProject(s.tabs, projectId, (x) =>
          mapContent(x, content.id, (c) => ({
            ...c,
            layout: mapSplitNode(c.layout, splitId, sizes),
          })),
        ),
      };
    });
    return r;
  },

  splitWithNewView: (projectId, targetGroupId, side, program) => {
    let r: CmdResult<{ groupId: string } & NewViewIds> = noProject(projectId);
    set((s) => {
      const t = s.tabs.find((x) => x.id === projectId);
      if (!t) return s;
      const content = contentOfGroup(t, targetGroupId);
      if (!content) {
        r = err("TARGET_NOT_FOUND", `그룹 없음: ${targetGroupId}`);
        return s;
      }
      const v = newViewFor(program ?? "terminal");
      const fresh = makeGroup(v);
      r = ok({ groupId: fresh.id, ...idsOfView(v) });
      return {
        tabs: mapProject(s.tabs, projectId, (x) =>
          mapContent(x, content.id, (c) =>
            normalizeActiveGroupC({
              ...c,
              layout: splitAtGroup(c.layout, targetGroupId, side, fresh),
              activeGroupId: fresh.id,
            }),
          ),
        ),
      };
    });
    return r;
  },

  splitPane: (projectId, viewId, paneId, dir) => {
    let r: CmdResult<{ paneId: string }> = noProject(projectId);
    set((s) => {
      const t = s.tabs.find((x) => x.id === projectId);
      if (!t) return s;
      const content = contentOfView(t, viewId);
      const view = content
        ? allViews(content.layout).find((v) => v.id === viewId)
        : undefined;
      if (!view || view.kind !== "terminal") {
        r = err("TARGET_NOT_FOUND", `터미널 뷰 없음: ${viewId}`);
        return s;
      }
      if (!collectLeafIds(view.layout).includes(paneId)) {
        r = err("TARGET_NOT_FOUND", `pane 없음: ${paneId}`);
        return s;
      }
      const newId = newPaneId();
      r = ok({ paneId: newId });
      return {
        tabs: mapProject(s.tabs, projectId, (x) =>
          mapViewEverywhere(x, viewId, (v) => {
            if (v.kind !== "terminal") return v;
            return {
              ...v,
              layout: splitInTree(v.layout, paneId, dir, newId),
              focusedPaneId: newId,
            };
          }),
        ),
      };
    });
    return r;
  },

  closePane: (projectId, viewId, paneId) => {
    let r: CmdResult<{ focusedPaneId: string }> = noProject(projectId);
    set((s) => {
      const t = s.tabs.find((x) => x.id === projectId);
      if (!t) return s;
      const content = contentOfView(t, viewId);
      const view = content
        ? allViews(content.layout).find((v) => v.id === viewId)
        : undefined;
      if (!view || view.kind !== "terminal") {
        r = err("TARGET_NOT_FOUND", `터미널 뷰 없음: ${viewId}`);
        return s;
      }
      if (!collectLeafIds(view.layout).includes(paneId)) {
        r = err("TARGET_NOT_FOUND", `pane 없음: ${paneId}`);
        return s;
      }
      if (collectLeafIds(view.layout).length <= 1) {
        r = err("LAST_ITEM", "마지막 pane 은 닫을 수 없음(뷰 닫기를 사용)");
        return s;
      }
      const next = removeInTree(view.layout, paneId);
      if (next === null) return s;
      const remaining = collectLeafIds(next);
      const focusedPaneId = remaining.includes(view.focusedPaneId)
        ? view.focusedPaneId
        : remaining[0];
      r = ok({ focusedPaneId });
      return {
        tabs: mapProject(s.tabs, projectId, (x) =>
          mapViewEverywhere(x, viewId, (v) =>
            v.kind === "terminal" ? { ...v, layout: next, focusedPaneId } : v,
          ),
        ),
      };
    });
    return r;
  },

  setFocusedPane: (projectId, viewId, paneId) => {
    let r: CmdResult = noProject(projectId);
    set((s) => {
      const t = s.tabs.find((x) => x.id === projectId);
      if (!t) return s;
      if (!contentOfView(t, viewId)) {
        r = err("TARGET_NOT_FOUND", `뷰 없음: ${viewId}`);
        return s;
      }
      r = ok({});
      return {
        tabs: mapProject(s.tabs, projectId, (x) =>
          mapViewEverywhere(x, viewId, (v) =>
            v.kind === "terminal" ? { ...v, focusedPaneId: paneId } : v,
          ),
        ),
      };
    });
    return r;
  },
}));
