import { create } from "zustand";
import { useSettings } from "./settings";
import {
  autorunCommandOf,
  getRegisteredProgram,
} from "../plugins/programRegistry";
import { localize } from "../i18n";
import {
  type SplitTree,
  splitLeaf,
  insertBeside,
  removeLeaf,
  leavesOf,
  resizeSplitTree,
  findSplitTree,
  mapLeaves,
} from "./splitTree";
import {
  type SidebarLayout,
  type SidebarDrop,
  initialSidebarLayout,
  reconcileSidebarLayout,
  moveSidebarView as moveSidebarViewT,
  hasSidebarView,
} from "./sidebarLayout";

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
  | "CONSENT_REQUIRED"
  // 플러그인 삭제가 의존자 cascade 를 유발 — 동의(cascade:true) 없이는 차단(고아 방지).
  | "CASCADE_REQUIRED"
  // DOM 주소가 노출 노드(data-node)에 없음 — 임의 selector 추측 금지, 노출된 것만 접근(ui.tree).
  | "NOT_EXPOSED";

// data = 코드별 부가 정보(선택). 예: CONSENT_REQUIRED 의 미동의 체인(연속 동의 팝업용).
export type CmdErr = { ok: false; code: CmdErrCode; message: string; data?: unknown };
export type CmdOk<T extends object = object> = { ok: true } & T;
export type CmdResult<T extends object = object> = CmdOk<T> | CmdErr;

export const ok = <T extends object>(data: T): CmdOk<T> => ({
  ok: true,
  ...data,
});
export const err = (code: CmdErrCode, message: string, data?: unknown): CmdErr => ({
  ok: false,
  code,
  message,
  ...(data !== undefined ? { data } : {}),
});

// ── 모델 타입 ────────────────────────────────────────────────────────────────

// 재귀 pane 트리. leaf = 터미널 하나, split = 자식들의 행/열 묶음.
// 터미널 뷰 내부 pane 트리 = 제네릭 SplitTree(leaf 값 = paneId). split/remove/resize/직렬화는
// splitTree.ts 단일 추상(뷰 그룹 GroupNode 와 동일 코드 — 중복 없음). leaf.value 가 paneId.
export type PaneNode = SplitTree<string>;

// 뷰가 코어에 상시 보고하는 상태(R1) — code=기계 식별자, message=사람 표시.
// blocking code(STATUS_BLOCKING)는 닫기 가드를 발동(R2). 회수는 뷰 종속(R4) — 뷰 삭제=status 삭제.
export interface ViewStatus {
  code: string;
  message?: string;
}

// 콘텐츠 뷰: 터미널(분할 가능), 파일(CodeMirror/프리뷰), 브라우저(child webview).
export type View =
  | {
      id: string;
      kind: "terminal";
      title: string;
      layout: PaneNode;
      focusedPaneId: string;
      // 이 pane 의 셸이 뜨면 1회 자동 실행할 셸 명령(에이전트류 프로그램 —
      // 명령 문자열은 programRegistry 가 resolve, ensure 설치 래핑 포함).
      // pasteOnly: 복원된 터미널(A6)은 명령을 자동 실행하지 않고 프롬프트에 붙여넣기만 한다
      // (엔터는 사용자가) — live PTY 는 복원 불가라 "같은 명령 재실행"을 강요하지 않는다(부작용 회피).
      autorun?: { paneId: string; command: string; pasteOnly?: boolean };
      status?: ViewStatus;
    }
  | {
      id: string;
      kind: "file";
      title: string;
      path: string; // 절대 경로
      mode: "code" | "preview";
      // 미저장은 status.code "dirty" 로 표현(R5) — 별도 dirty 플래그 없음(이중진실 금지).
      status?: ViewStatus;
    }
  | {
      id: string;
      kind: "browser";
      title: string;
      url: string;
      status?: ViewStatus;
    }
  // 플러그인 뷰(콘텐츠 배치) — 전역 키 "<pluginId>.<view>" 의 provider 를
  // PluginViewHost 가 그린다. 닫기/이동/드래그는 일반 뷰와 동일(view id 제네릭).
  | {
      id: string;
      kind: "plugin";
      title: string;
      pluginId: string;
      view: string; // 플러그인 내 뷰 id
      status?: ViewStatus;
    };

// 에디터 그룹: 탭(뷰) 묶음 + 활성 뷰. 그룹 트리의 leaf.
export interface ViewGroup {
  id: string;
  views: View[];
  activeViewId: string;
}

// 그룹 재귀 트리. leaf = 그룹 하나, split = 행/열로 묶인 그룹들(sizes = 분할 비율).
// 컨텐츠의 그룹(분할) 트리 = 제네릭 SplitTree(leaf 값 = ViewGroup). split/remove/resize/find 는
// splitTree.ts 단일 추상(PaneNode 와 동일 코드 — 중복 없음). leaf.value 가 ViewGroup.
export type GroupNode = SplitTree<ViewGroup>;

// 드롭 위치(드래그 분할 방향). center=이동, 나머지=해당 방향으로 분할.
export type DropZone = "center" | "left" | "right" | "top" | "bottom";

export type Side = "left" | "right" | "top" | "bottom";

// 컨텐츠가 처음 열 때 띄우는 프로그램(첫 화면). 내장 "terminal"·"browser"(코어
// 능력) + 플러그인 등록 프로그램 id(programRegistry). 미등록 id 는 터미널 폴백.
export type Program = string;

// 브라우저 뷰 기본 시작 페이지(설정 homeUrl).
export function browserHome(): string {
  return useSettings.getState().homeUrl;
}

// 컨텐츠 탭: 한 프로젝트 안의 독립 콘텐츠 영역(분할 그리드). 프로젝트당 여러 개 + 전환.
// 프로그램 자동 실행은 터미널 뷰의 autorun 이 담당(뷰 단위로 일반화).
export interface ContentArea {
  id: string;
  title: string; // 1,2,3,… (이름변경 가능)
  layout: GroupNode; // 그룹(분할) 트리
  activeGroupId: string;
  // 최대화된 뷰(컨텐츠 영역 전체 차지). 레이아웃 트리는 불변 — 표시 오버라이드만.
  // undefined = 보통. 뷰가 사라지면 normalize 가 해제한다.
  maximizedViewId?: string;
}

export interface ProjectTab {
  id: string;
  title: string; // 별칭
  sidebarOpen: boolean;
  // 우측 플러그인 사이드바: 열림 + 활성 뷰("<pluginId>.<viewId>" | "manager" | null).
  rightOpen: boolean;
  rightView: string | null;
  // 좌측 사이드바 레이아웃(B2) — SplitTree<SidebarGroup>. 등록된 sidebar-left 뷰의 배치(탭 묶음 +
  // 세로 분할 + 활성). 콘텐츠 영역과 동일한 drag-merge. 등록 변화와 reconcile(LeftSidebarHost).
  leftLayout: SidebarLayout;
  // 프로젝트 루트 디렉토리(P1 루트 필수 — workspace.ts 헌법). 정체성 = 이
  // 경로(P4). 터미널 시작 위치이자 파일트리/git 의 기준.
  root: string;
  // 프로젝트의 터미널 셸(미지정이면 전역 설정 shell → 시스템 $SHELL).
  shell?: string;
  // 프로젝트 식별 색(레일 칩/탭 강조). 미지정이면 테마 기본.
  color?: string;
  // 컨텐츠 탭들 + 활성.
  contents: ContentArea[];
  activeContentId: string;
}

export interface NewProjectOpts {
  alias: string;
  root: string; // P1 — 호출부가 검증·정규화(validateProjectRoot)까지 마친 경로
  shell?: string; // undefined = 전역 설정 따름
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
  // 부트 1회: 기본 루트로 첫 프로젝트(t1/"P1") 생성 — main.tsx 전용(P3).
  bootstrapFirstProject: (root: string) => void;
  // 영속된 레이아웃 복원(A5) — main.tsx 부트가 직렬화 스냅샷을 deserialize 해 통째 주입.
  // bootstrap 과 배타: 복원본이 있으면 이걸, 없으면 bootstrap. reseed 는 호출부(persistence)가.
  restoreProjects: (tabs: ProjectTab[], activeId: string) => void;
  addProject: (
    opts: NewProjectOpts,
  ) => CmdResult<
    { projectId: string; contentId: string; groupId: string; existing?: true } & Partial<NewViewIds>
  >;
  closeTab: (id: string) => CmdResult<{ activeProjectId: string }>;
  setActive: (id: string) => CmdResult;
  renameTab: (id: string, title: string) => CmdResult;
  // 프로젝트 식별 색 설정(null = 제거).
  setProjectColor: (id: string, color: string | null) => CmdResult;
  // 프로젝트 설정 일괄 변경(undefined = 유지, null = 제거→기본). root 는 불변.
  updateProject: (
    id: string,
    patch: {
      title?: string;
      shell?: string | null;
      color?: string | null;
    },
  ) => CmdResult;
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
  // 좌측 사이드바 활성 탭 — viewKey 가 든 leaf 그룹의 활성을 그것으로. (기존 setLeftTab 대체.)
  setLeftTab: (id: string, viewKey: string) => CmdResult<{ leftTab: string }>;
  // 등록 sidebar-left 뷰와 reconcile(LeftSidebarHost 가 렌더 시 호출). 변화 시에만 set.
  reconcileSidebar: (id: string, registeredKeys: string[]) => void;
  // 사이드바 뷰 drag-merge(into=탭 합류, split=세로 분리).
  moveSidebarView: (id: string, viewKey: string, drop: SidebarDrop) => CmdResult;
  // 사이드바 split 비율 조절(핸들 드래그/명령).
  resizeSidebar: (id: string, splitId: string, sizes: number[]) => CmdResult;

  // 컨텐츠 탭 레벨. program 명시 시 그 프로그램으로(+메뉴), 아니면 프로젝트>전역 설정.
  addContent: (
    projectId: string,
    program?: Program,
  ) => CmdResult<{ contentId: string; groupId: string } & Partial<NewViewIds>>;
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
  // opts.command = 터미널 자동 실행 명령 직접 지정(내부용 — 프로그램 resolve 우회.
  // 플러그인 활성화 시 설치 터미널 등 호스트 흐름 전용, 원격 명령엔 비노출).
  addViewToGroup: (
    projectId: string,
    program: Program,
    groupId?: string,
    opts?: { url?: string; command?: string },
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
  // 뷰 최대화 — 컨텐츠 영역 전체를 한 뷰가 차지(분할 트리 불변, 표시만). 복원=원래 분할.
  maximizeView: (
    projectId: string,
    viewId: string,
  ) => CmdResult<{ viewId: string }>;
  restoreView: (projectId: string) => CmdResult<{ viewId: string | null }>;
  setFileMode: (
    projectId: string,
    viewId: string,
    mode: "code" | "preview",
  ) => CmdResult;
  setFileDirty: (projectId: string, viewId: string, dirty: boolean) => CmdResult;
  // 뷰 status 보고(R1) — null 이면 회수(R4). 모든 뷰 kind 공통.
  setViewStatus: (
    projectId: string,
    viewId: string,
    status: ViewStatus | null,
  ) => CmdResult;
  // 브라우저 뷰 URL 동기화(네비게이션 이벤트/URL 바 입력).
  setBrowserUrl: (projectId: string, viewId: string, url: string) => CmdResult;
  setBrowserTitle: (
    projectId: string,
    viewId: string,
    title: string,
  ) => CmdResult;
  // 임의 뷰의 탭 제목 갱신(콘텐츠 플러그인이 동적 제목 — 예: 브라우저 페이지 <title>). 빈 값은 무시.
  setViewTitle: (projectId: string, viewId: string, title: string) => void;
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
  // pane split 비율 조절(핸들 드래그/명령) — GroupNode resizeSplit 의 pane 판(동일 추상).
  resizePane: (
    projectId: string,
    viewId: string,
    splitId: string,
    sizes: number[],
  ) => CmdResult;
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
// split id 생성기(복원 시 workspaceSnapshot.deserialize 에 주입 — A2 는 split id 를 재생성한다).
export const nextSplitIdGen = (): string => newSplitId();

// 복원된 트리의 보존 id 위로 카운터를 올린다(신규 생성이 보존 id 와 충돌하지 않게). prefix 별로
// "<prefix><n>" 의 n 최대치를 찾아 next* 를 max+1 로. 모든 tabs 를 스캔한다. A5 복원 후 1회 호출.
export function reseedIdCounters(tabs: ProjectTab[]): void {
  let maxT = 1,
    maxV = 1,
    maxP = 1,
    maxG = 1,
    maxS = 0,
    maxC = 1;
  const num = (id: string, prefix: string): number => {
    if (!id.startsWith(prefix)) return 0;
    const n = Number(id.slice(prefix.length));
    return Number.isFinite(n) ? n : 0;
  };
  const scanSplit = (node: GroupNode): void => {
    if (node.type === "split") {
      maxS = Math.max(maxS, num(node.id, "s"));
      node.children.forEach(scanSplit);
    }
  };
  const scanPaneSplit = (node: PaneNode): void => {
    if (node.type === "split") {
      maxS = Math.max(maxS, num(node.id, "s"));
      node.children.forEach(scanPaneSplit);
    }
  };
  for (const t of tabs) {
    maxT = Math.max(maxT, num(t.id, "t"));
    for (const c of t.contents) {
      maxC = Math.max(maxC, num(c.id, "c"));
      scanSplit(c.layout);
      for (const g of allGroups(c.layout)) {
        maxG = Math.max(maxG, num(g.id, "g"));
        for (const v of g.views) {
          maxV = Math.max(maxV, num(v.id, "v"));
          if (v.kind === "terminal") {
            scanPaneSplit(v.layout);
            for (const pid of collectLeafIds(v.layout))
              maxP = Math.max(maxP, num(pid, "p"));
          }
        }
      }
    }
  }
  nextProjectId = maxT + 1;
  nextViewId = maxV + 1;
  nextPaneId = maxP + 1;
  nextGroupId = maxG + 1;
  nextSplitId = maxS + 1;
  nextContentId = maxC + 1;
}

// 다음 생성될 id 미리보기(비파괴) — reseed 검증·진단용. 카운터를 증가시키지 않는다.
export function newIds(): {
  project: string;
  view: string;
  pane: string;
  group: string;
  split: string;
  content: string;
} {
  return {
    project: `t${nextProjectId}`,
    view: `v${nextViewId}`,
    pane: `p${nextPaneId}`,
    group: `g${nextGroupId}`,
    split: `s${nextSplitId}`,
    content: `c${nextContentId}`,
  };
}

const leaf = (id: string): PaneNode => splitLeaf(id);

const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

// 새 터미널 뷰(빈 단일 pane). command 가 있으면 그 pane 에서 1회 자동 실행.
function newTerminalView(command?: string): View {
  const paneId = newPaneId();
  return {
    id: newViewId(),
    kind: "terminal",
    // 기본 title 은 영어(state.tree 로 AI 에 노출되는 표면). UI 탭 라벨은 kind 로 t() 지역화(ViewTabs).
    title: "Terminal",
    layout: leaf(paneId),
    focusedPaneId: paneId,
    ...(command ? { autorun: { paneId, command } } : {}),
  };
}

function makeGroup(view?: View): ViewGroup {
  // view 생략 = 빈 그룹(빈 탭) — 첫 화면 자동 실행 없음(순수 스켈레톤). +메뉴로 뷰를 추가한다.
  return view
    ? { id: newGroupId(), views: [view], activeViewId: view.id }
    : { id: newGroupId(), views: [], activeViewId: "" };
}

// 새 브라우저 뷰(url 미지정 시 홈).
function newBrowserView(url?: string): View {
  return {
    id: newViewId(),
    kind: "browser",
    // 기본 title 은 영어(state.tree AI 표면). UI 탭 라벨은 kind 로 t() 지역화(ViewTabs).
    title: "Browser",
    url: url ?? browserHome(),
  };
}

// 새 플러그인 뷰(콘텐츠 배치) — kind=view 프로그램이 자기 contributes.views 중 하나를 연다.
// PluginViewHost 가 "<pluginId>.<view>" provider 를 그린다. 코어는 plugin-agnostic — 어떤
// 플러그인이든 동일 경로(특정 플러그인 락인 0).
function newPluginViewFor(pluginId: string, view: string, title: string): View {
  return { id: newViewId(), kind: "plugin", title, pluginId, view };
}

// 프로그램 → 새 뷰. 내장 프로그램 개념은 없다(§2.6) — 등록 프로그램의 spec 으로
// resolve(kind 에 따라 터미널[+autorun] 또는 브라우저). 미등록 id 는 능력명
// ("browser" — 코어 명령 browser.open 등의 직접 경로)이면 그 능력, 아니면
// 터미널 뷰 폴백(아이콘 셋의 lucide 폴백과 동형 — 플러그인 비활성에도 상태
// 유실 없음).
function newViewFor(
  program: Program,
  opts?: { url?: string; command?: string },
): View {
  const reg = getRegisteredProgram(program);
  if (reg) {
    if (reg.decl.kind === "browser") return newBrowserView(opts?.url ?? reg.decl.url);
    if (reg.decl.kind === "view" && reg.decl.view)
      return newPluginViewFor(reg.pluginId, reg.decl.view, localize(reg.decl.title));
    return newTerminalView(opts?.command ?? autorunCommandOf(reg.decl));
  }
  if (program === "browser") return newBrowserView(opts?.url);
  return newTerminalView(opts?.command);
}

// 뷰의 새 id 묶음(터미널이면 paneId 포함) — 생성 명령 응답용.
function idsOfView(v: View): NewViewIds {
  return v.kind === "terminal"
    ? { viewId: v.id, paneId: v.focusedPaneId }
    : { viewId: v.id };
}

// 새 컨텐츠 영역. program 생략 = 빈 그룹(빈 탭, 첫 화면 자동실행 없음 — 순수 스켈레톤).
// program 지정(+메뉴로 새 콘텐츠 탭) = 그 프로그램 뷰로 시작.
function makeContent(title: string, program?: Program): ContentArea {
  const g = program ? makeGroup(newViewFor(program)) : makeGroup();
  return {
    id: newContentId(),
    title,
    layout: splitLeaf(g),
    activeGroupId: g.id,
  };
}


// ── 그룹 트리 헬퍼 ────────────────────────────────────────────────────────────

export function allGroups(node: GroupNode, acc: ViewGroup[] = []): ViewGroup[] {
  acc.push(...leavesOf(node)); // leaf 값(ViewGroup) = SplitTree leavesOf
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

// ── GroupNode 연산 = 제네릭 SplitTree 위임(단일 진실, PaneNode 와 동일 코드). ──────────
// 순회·구조 조작(map/find/resize/remove/insert)은 splitTree.ts 하나뿐이다. 여기는 leaf
// (ViewGroup) 술어·변환만 제공한다.

// 특정 그룹의 ViewGroup 을 변환.
function mapGroupNode(
  node: GroupNode,
  groupId: string,
  fn: (g: ViewGroup) => ViewGroup,
): GroupNode {
  return mapLeaves(node, (g) => (g.id === groupId ? fn(g) : g));
}

// 뷰가 어느 그룹에 있든 변환(종류 보존).
function mapViewNode(
  node: GroupNode,
  viewId: string,
  fn: (v: View) => View,
): GroupNode {
  return mapLeaves(node, (g) =>
    g.views.some((v) => v.id === viewId)
      ? { ...g, views: g.views.map((v) => (v.id === viewId ? fn(v) : v)) }
      : g,
  );
}

// split 노드 존재 여부 / sizes 변환 — 제네릭 위임.
const findSplit = (node: GroupNode, splitId: string): boolean =>
  findSplitTree(node, splitId);
const mapSplitNode = (
  node: GroupNode,
  splitId: string,
  sizes: number[],
): GroupNode => resizeSplitTree(node, splitId, sizes);

// 뷰 제거: (1) 그 뷰를 가진 그룹에서 뷰만 빼고 활성 보정(mapLeaves), (2) 빈 그룹 leaf 를
// removeLeaf 로 붕괴. split 정리(붕괴·sizes 재정규화)는 removeLeaf 단일 구현 재사용.
function removeView(
  node: GroupNode,
  viewId: string,
): { tree: GroupNode | null; removed: View | null } {
  let removed: View | null = null;
  const mapped = mapLeaves(node, (g) => {
    const found = g.views.find((v) => v.id === viewId);
    if (!found) return g;
    removed = found;
    const views = g.views.filter((v) => v.id !== viewId);
    let activeViewId = g.activeViewId;
    if (activeViewId === viewId) {
      const idx = g.views.findIndex((v) => v.id === viewId);
      activeViewId = (views[idx] ?? views[idx - 1] ?? views[0])?.id ?? "";
    }
    return { ...g, views, activeViewId };
  });
  if (!removed) return { tree: node, removed: null };
  const { tree } = removeLeaf(mapped, (g) => g.views.length === 0);
  return { tree, removed };
}

// 그룹(leaf) 하나를 통째로 제거 = removeLeaf(그 group id 매칭, 붕괴 포함).
function removeGroup(
  node: GroupNode,
  groupId: string,
): { tree: GroupNode | null; removed: ViewGroup | null } {
  return removeLeaf(node, (g) => g.id === groupId);
}

// targetGroup 을 fresh 그룹과 분할(side 방향) = insertBeside(같은 dir 형제면 중첩 회피).
function splitAtGroup(
  node: GroupNode,
  targetGroupId: string,
  side: Side,
  fresh: ViewGroup,
): GroupNode {
  const dir: "row" | "col" =
    side === "left" || side === "right" ? "row" : "col";
  const before = side === "left" || side === "top";
  return insertBeside(
    node,
    (g) => g.id === targetGroupId,
    dir,
    before,
    fresh,
    newSplitId,
  );
}

// 활성 그룹이 사라졌으면 첫 그룹으로 보정 + 최대화 뷰가 사라졌으면 최대화 해제.
function normalizeActiveGroupC(c: ContentArea): ContentArea {
  const groups = allGroups(c.layout);
  const next =
    c.maximizedViewId &&
    !groups.some((g) => g.views.some((v) => v.id === c.maximizedViewId))
      ? { ...c, maximizedViewId: undefined }
      : c;
  if (groups.some((g) => g.id === next.activeGroupId)) return next;
  return { ...next, activeGroupId: groups[0]?.id ?? next.activeGroupId };
}

// ── pane 트리 헬퍼(터미널 뷰 내부) ────────────────────────────────────────────

export function collectLeafIds(node: PaneNode, acc: string[] = []): string[] {
  acc.push(...leavesOf(node)); // leaf 값(paneId) = SplitTree leavesOf
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
// command=그 pane 이 뷰의 autorun 대상일 때만(1회 자동 실행 셸 명령).
export function paneSpawnInfo(
  tabs: ProjectTab[],
  paneId: string,
): { cwd?: string; shell?: string; command?: string; pasteOnly?: boolean } {
  for (const t of tabs) {
    for (const c of t.contents) {
      for (const v of allViews(c.layout)) {
        if (v.kind === "terminal" && collectLeafIds(v.layout).includes(paneId)) {
          const shell = t.shell || useSettings.getState().shell || undefined;
          const isAutorunPane = v.autorun?.paneId === paneId;
          return {
            cwd: t.root,
            shell,
            command: isAutorunPane ? v.autorun?.command : undefined,
            // 복원 터미널(A6): 명령을 실행 대신 프롬프트에 붙여넣기만.
            ...(isAutorunPane && v.autorun?.pasteOnly ? { pasteOnly: true } : {}),
          };
        }
      }
    }
  }
  return {};
}

// paneId 를 가진 터미널 뷰의 {projectId, viewId}(M5 — terminal status 브리지용). 없으면 null.
export function paneToView(
  tabs: ProjectTab[],
  paneId: string,
): { projectId: string; viewId: string } | null {
  for (const t of tabs)
    for (const c of t.contents)
      for (const v of allViews(c.layout))
        if (v.kind === "terminal" && collectLeafIds(v.layout).includes(paneId))
          return { projectId: t.id, viewId: v.id };
  return null;
}

// pane 분할/제거 = 제네릭 SplitTree 연산(중복 구현 없음). newId 는 새 pane id(leaf 값),
// 새 split 노드 id 는 newSplitId. before=false → 기존(splitInTree)과 동일하게 뒤에 삽입.
function splitInTree(
  node: PaneNode,
  paneId: string,
  dir: "row" | "col",
  newId: string,
): PaneNode {
  return insertBeside(node, (v) => v === paneId, dir, false, newId, newSplitId);
}

function removeInTree(node: PaneNode, paneId: string): PaneNode | null {
  return removeLeaf(node, (v) => v === paneId).tree;
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

function makeProject(id: string, opts: NewProjectOpts): ProjectTab {
  const c = makeContent("1");
  const alias = opts.alias.trim() || baseName(opts.root);
  return {
    id,
    title: alias,
    sidebarOpen: true,
    rightOpen: false,
    rightView: null,
    leftLayout: initialSidebarLayout([]),
    root: opts.root,
    shell: opts.shell,
    contents: [c],
    activeContentId: c.id,
  };
}

// 자주 쓰는 에러.
const noProject = (id: string): CmdErr =>
  err("TARGET_NOT_FOUND", `프로젝트 없음: ${id}`);

export const useSessions = create<SessionsStore>((set, get) => ({
  // 부트(main.tsx)가 기본 루트(~/.soksak/projects/project1)를 준비한 뒤
  // bootstrapFirstProject 로 첫 프로젝트를 만든다(P3) — 렌더 전이므로
  // 프로젝트 0개 상태는 화면에 나타나지 않는다(부트 실패만의 예외 상태).
  tabs: [],
  activeId: "",

  bootstrapFirstProject: (root) => {
    if (get().tabs.length > 0) return; // 멱등 — 부트 1회 전용
    // 자동 project1 은 "P1", 사용자 지정 기본 프로젝트는 폴더명이 표시명.
    const alias = baseName(root) === "project1" ? "P1" : "";
    const t = makeProject("t1", { alias, root });
    set({ tabs: [t], activeId: "t1" });
  },

  restoreProjects: (tabs, activeId) => {
    if (get().tabs.length > 0) return; // 멱등 — 부트 1회 전용(bootstrap 과 배타)
    if (tabs.length === 0) return; // 빈 복원본은 무시(부트가 bootstrap 으로 폴백)
    const active = tabs.some((t) => t.id === activeId) ? activeId : tabs[0].id;
    set({ tabs, activeId: active });
  },

  addProject: (opts) => {
    // P5 중복 금지 — 같은 루트(정규화는 호출부 책임)의 프로젝트가 있으면
    // 그 프로젝트를 활성화하고 existing 으로 알린다(openFileView 패턴).
    const dup = get().tabs.find((t) => t.root === opts.root);
    if (dup) {
      set({ activeId: dup.id });
      const c = dup.contents.find((x) => x.id === dup.activeContentId)!;
      const g = allGroups(c.layout)[0];
      const v = g.views[0];
      return ok({
        projectId: dup.id,
        contentId: c.id,
        groupId: g.id,
        ...(v ? idsOfView(v) : {}),
        existing: true,
      });
    }
    const id = `t${nextProjectId++}`;
    const t = makeProject(id, opts);
    set((s) => ({ tabs: [...s.tabs, t], activeId: id }));
    const c = t.contents[0];
    const g = allGroups(c.layout)[0];
    const v = g.views[0];
    return ok({
      projectId: id,
      contentId: c.id,
      groupId: g.id,
      ...(v ? idsOfView(v) : {}),
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

  setProjectColor: (id, color) => {
    let r: CmdResult = noProject(id);
    set((s) => {
      if (!s.tabs.some((t) => t.id === id)) return s;
      r = ok({});
      return {
        tabs: s.tabs.map((t) =>
          t.id === id ? { ...t, color: color ?? undefined } : t,
        ),
      };
    });
    return r;
  },

  updateProject: (id, patch) => {
    let r: CmdResult = noProject(id);
    set((s) => {
      if (!s.tabs.some((t) => t.id === id)) return s;
      r = ok({});
      return {
        tabs: s.tabs.map((t) => {
          if (t.id !== id) return t;
          const next = { ...t };
          // 빈 제목은 무시(제목은 항상 비어 있지 않다는 불변식 유지).
          if (patch.title !== undefined && patch.title.trim()) {
            next.title = patch.title.trim();
          }
          if (patch.shell !== undefined) {
            next.shell = patch.shell ?? undefined;
          }
          if (patch.color !== undefined) {
            next.color = patch.color ?? undefined;
          }
          return next;
        }),
      };
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

  setLeftTab: (id, viewKey) => {
    let r: CmdResult<{ leftTab: string }> = noProject(id);
    set((s) => {
      const t = s.tabs.find((x) => x.id === id);
      if (!t) return s;
      if (!hasSidebarView(t.leftLayout, viewKey)) {
        r = err("TARGET_NOT_FOUND", `사이드바 뷰 없음: ${viewKey}`);
        return s;
      }
      r = ok({ leftTab: viewKey });
      // viewKey 가 든 leaf 그룹의 활성만 그것으로(다른 leaf 는 불변).
      const leftLayout = mapLeaves(t.leftLayout, (g) =>
        g.viewKeys.includes(viewKey) && g.activeViewKey !== viewKey
          ? { ...g, activeViewKey: viewKey }
          : g,
      );
      return {
        tabs: s.tabs.map((x) => (x.id === id ? { ...x, leftLayout } : x)),
      };
    });
    return r;
  },

  reconcileSidebar: (id, registeredKeys) => {
    set((s) => {
      const t = s.tabs.find((x) => x.id === id);
      if (!t) return s;
      const next = reconcileSidebarLayout(t.leftLayout, registeredKeys);
      if (next === t.leftLayout) return s; // 변화 없음(참조 보존 — 무한 reconcile 방지)
      return {
        tabs: s.tabs.map((x) => (x.id === id ? { ...x, leftLayout: next } : x)),
      };
    });
  },

  moveSidebarView: (id, viewKey, drop) => {
    let r: CmdResult = noProject(id);
    set((s) => {
      const t = s.tabs.find((x) => x.id === id);
      if (!t) return s;
      if (!hasSidebarView(t.leftLayout, viewKey)) {
        r = err("TARGET_NOT_FOUND", `사이드바 뷰 없음: ${viewKey}`);
        return s;
      }
      const leftLayout = moveSidebarViewT(t.leftLayout, viewKey, drop, newSplitId);
      r = ok({});
      return {
        tabs: s.tabs.map((x) => (x.id === id ? { ...x, leftLayout } : x)),
      };
    });
    return r;
  },

  resizeSidebar: (id, splitId, sizes) => {
    let r: CmdResult = noProject(id);
    set((s) => {
      const t = s.tabs.find((x) => x.id === id);
      if (!t) return s;
      if (!findSplitTree(t.leftLayout, splitId)) {
        r = err("TARGET_NOT_FOUND", `사이드바 split 없음: ${splitId}`);
        return s;
      }
      r = ok({});
      const leftLayout = resizeSplitTree(t.leftLayout, splitId, sizes);
      return {
        tabs: s.tabs.map((x) => (x.id === id ? { ...x, leftLayout } : x)),
      };
    });
    return r;
  },

  addContent: (projectId, program) => {
    let r: CmdResult<
      { contentId: string; groupId: string } & Partial<NewViewIds>
    > = noProject(projectId);
    set((s) => {
      const t = s.tabs.find((x) => x.id === projectId);
      if (!t) return s;
      const nextNum =
        Math.max(0, ...t.contents.map((c) => parseInt(c.title, 10) || 0)) + 1;
      const c = makeContent(String(nextNum), program);
      const g = allGroups(c.layout)[0];
      const v = g.views[0];
      r = ok({ contentId: c.id, groupId: g.id, ...(v ? idsOfView(v) : {}) });
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
      // 마지막 뷰를 닫으면 빈 그룹(빈 탭)으로 — 컨텐츠/그룹은 유지(순수 스켈레톤: 빈 탭이
      // 정당한 상태). 단일 그룹이면 그 그룹을 비우고, 분할 중이면 removeView 가 그룹을 접는다.
      const grp = findGroupOfView(content.layout, viewId);
      if (grp && content.layout.type === "leaf" && grp.views.length <= 1) {
        const next = normalizeActiveGroupC({
          ...content,
          layout: splitLeaf({ ...grp, views: [], activeViewId: "" }),
        });
        r = ok({ activeGroupId: next.activeGroupId, activeViewId: "" });
        return {
          tabs: mapProject(s.tabs, projectId, (x) =>
            mapContent(x, content.id, () => next),
          ),
        };
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

  maximizeView: (projectId, viewId) => {
    let r: CmdResult<{ viewId: string }> = noProject(projectId);
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
      r = ok({ viewId });
      return {
        tabs: mapProject(s.tabs, projectId, (x) => ({
          ...mapContent(x, content.id, (c) => ({
            ...c,
            maximizedViewId: viewId,
            // 최대화 뷰 = 그 그룹의 활성 뷰 + 활성 그룹(표시·입력 일치).
            layout: mapGroupNode(c.layout, grp.id, (g) => ({
              ...g,
              activeViewId: viewId,
            })),
            activeGroupId: grp.id,
          })),
          activeContentId: content.id,
        })),
      };
    });
    return r;
  },

  restoreView: (projectId) => {
    let r: CmdResult<{ viewId: string | null }> = noProject(projectId);
    set((s) => {
      const t = s.tabs.find((x) => x.id === projectId);
      if (!t) return s;
      const content = t.contents.find((c) => c.id === t.activeContentId);
      if (!content) return s;
      r = ok({ viewId: content.maximizedViewId ?? null });
      if (!content.maximizedViewId) return s;
      return {
        tabs: mapProject(s.tabs, projectId, (x) =>
          mapContent(x, content.id, (c) => ({
            ...c,
            maximizedViewId: undefined,
          })),
        ),
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

  // file 미저장은 status.code "dirty" 로 단일화(R5 — 이중진실 제거). setViewStatus 위임.
  setFileDirty: (projectId, viewId, dirty) =>
    get().setViewStatus(projectId, viewId, dirty ? { code: "dirty" } : null),

  // 뷰 status 보고/회수(R1·R4) — 모든 뷰 공통. null=필드 소멸. setFileDirty 와 동형.
  setViewStatus: (projectId, viewId, status) => {
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
          mapViewEverywhere(x, viewId, (v) => ({
            ...v,
            status: status ?? undefined,
          })),
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
  // 임의 뷰 kind 의 탭 제목 갱신(콘텐츠 플러그인 동적 제목). setBrowserTitle 의 generic 판.
  setViewTitle: (projectId, viewId, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    set((s) => ({
      tabs: mapProject(s.tabs, projectId, (x) =>
        mapViewEverywhere(x, viewId, (v) => ({ ...v, title: trimmed })),
      ),
    }));
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

  resizePane: (projectId, viewId, splitId, sizes) => {
    let r: CmdResult = noProject(projectId);
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
      if (!findSplitTree(view.layout, splitId)) {
        r = err("TARGET_NOT_FOUND", `pane split 없음: ${splitId}`);
        return s;
      }
      r = ok({});
      return {
        tabs: mapProject(s.tabs, projectId, (x) =>
          mapViewEverywhere(x, viewId, (v) =>
            v.kind === "terminal"
              ? { ...v, layout: resizeSplitTree(v.layout, splitId, sizes) }
              : v,
          ),
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
