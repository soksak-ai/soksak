// 명령 카탈로그 — soksak 전 기능을 command 로 등록한다(단일 진실).
// 타기팅 규칙(모든 명령 공통):
//   - 대상 id 를 명시하면 그 위치(프로젝트 전체에서 검색), 생략하면 호출자 컨텍스트
//     (SOKSAK_PANE → 그 pane 이 속한 뷰/패널/컨텐츠/프로젝트) 또는 활성 체인.
//   - 모든 변이는 결과(새 id/변경 후 상태)를 반환 — 호출자가 응답만으로 검증 가능.

import { invoke } from "@tauri-apps/api/core";
import {
  allGroups,
  collectLeafIds,
  useSessions,
  BROWSER_HOME,
  type ContentArea,
  type DropZone,
  type GroupNode,
  type Program,
  type ProjectTab,
  type Side,
  type View,
  type ViewGroup,
} from "../state/sessions";
import { useSettings } from "../state/settings";
import { useBookmarks } from "../state/bookmarks";
import { useUi } from "../state/ui";
import {
  focusHost,
  getCwdOfHost,
  readHostBuffer,
  sendInputToHost,
} from "../terminal/paneHosts";
import { computeLayout } from "../components/GroupArea";
import { getFileView, saveFileView } from "./fileViewBridge";
import { catalogJson, register, type CommandContext } from "./registry";

// ── 공통 에러/헬퍼 ───────────────────────────────────────────────────────────

const notFound = (what: string) => ({
  ok: false as const,
  code: "TARGET_NOT_FOUND" as const,
  message: what,
});

interface Location {
  project: ProjectTab;
  content: ContentArea;
  group: ViewGroup;
  view: View;
}

// paneId 가 속한 위치를 전 프로젝트에서 검색.
function locatePane(paneId: string): Location | null {
  const s = useSessions.getState();
  for (const project of s.tabs) {
    for (const content of project.contents) {
      for (const group of allGroups(content.layout)) {
        for (const view of group.views) {
          if (
            view.kind === "terminal" &&
            collectLeafIds(view.layout).includes(paneId)
          ) {
            return { project, content, group, view };
          }
        }
      }
    }
  }
  return null;
}

// viewId 가 속한 위치를 전 프로젝트에서 검색.
function locateView(viewId: string): Location | null {
  const s = useSessions.getState();
  for (const project of s.tabs) {
    for (const content of project.contents) {
      for (const group of allGroups(content.layout)) {
        const view = group.views.find((v) => v.id === viewId);
        if (view) return { project, content, group, view };
      }
    }
  }
  return null;
}

// groupId 가 속한 위치(view = 그 그룹의 활성 뷰).
function locateGroup(groupId: string): Location | null {
  const s = useSessions.getState();
  for (const project of s.tabs) {
    for (const content of project.contents) {
      const group = allGroups(content.layout).find((g) => g.id === groupId);
      if (group) {
        const view =
          group.views.find((v) => v.id === group.activeViewId) ??
          group.views[0];
        return { project, content, group, view };
      }
    }
  }
  return null;
}

// 활성 체인(활성 프로젝트 → 활성 컨텐츠 → 활성 그룹 → 활성 뷰).
function activeChain(): Location | null {
  const s = useSessions.getState();
  const project = s.tabs.find((t) => t.id === s.activeId);
  if (!project) return null;
  const content =
    project.contents.find((c) => c.id === project.activeContentId) ??
    project.contents[0];
  if (!content) return null;
  const group =
    allGroups(content.layout).find((g) => g.id === content.activeGroupId) ??
    allGroups(content.layout)[0];
  if (!group) return null;
  const view =
    group.views.find((v) => v.id === group.activeViewId) ?? group.views[0];
  return { project, content, group, view };
}

// 호출 컨텍스트 해석: SOKSAK_PANE 우선, 없으면 활성 체인.
function resolveCtx(ctx: CommandContext): Location | null {
  if (ctx.pane) {
    const loc = locatePane(ctx.pane);
    if (loc) return loc;
  }
  return activeChain();
}

// 대상 프로젝트: 명시 id > 컨텍스트.
function resolveProject(
  params: Record<string, unknown>,
  ctx: CommandContext,
): ProjectTab | null {
  const id = params.project as string | undefined;
  if (id) {
    return useSessions.getState().tabs.find((t) => t.id === id) ?? null;
  }
  return resolveCtx(ctx)?.project ?? null;
}

// 대상 그룹: 명시 id(전 프로젝트 검색) > 컨텍스트 그룹.
function resolveGroup(
  params: Record<string, unknown>,
  ctx: CommandContext,
): Location | null {
  const id = params.group as string | undefined;
  if (id) return locateGroup(id);
  return resolveCtx(ctx);
}

// 대상 pane: 명시 > 컨텍스트 pane > 컨텍스트 뷰의 포커스 pane.
function resolvePane(
  params: Record<string, unknown>,
  ctx: CommandContext,
): { paneId: string; loc: Location } | null {
  const explicit = params.pane as string | undefined;
  if (explicit) {
    const loc = locatePane(explicit);
    return loc ? { paneId: explicit, loc } : null;
  }
  if (ctx.pane) {
    const loc = locatePane(ctx.pane);
    if (loc) return { paneId: ctx.pane, loc };
  }
  const loc = activeChain();
  if (!loc) return null;
  if (loc.view.kind === "terminal") {
    return { paneId: loc.view.focusedPaneId, loc };
  }
  // 활성 뷰가 터미널이 아니면 같은 컨텐츠의 첫 터미널.
  for (const g of allGroups(loc.content.layout)) {
    for (const v of g.views) {
      if (v.kind === "terminal") {
        return { paneId: v.focusedPaneId, loc: { ...loc, group: g, view: v } };
      }
    }
  }
  return null;
}

// 대상 브라우저 뷰: 명시 view id > 컨텍스트(활성 뷰가 브라우저) > 같은 컨텐츠의 첫 브라우저.
function resolveBrowser(
  params: Record<string, unknown>,
  ctx: CommandContext,
): (Location & { url: string }) | null {
  const id = params.view as string | undefined;
  if (id) {
    const loc = locateView(id);
    return loc && loc.view.kind === "browser"
      ? { ...loc, url: loc.view.url }
      : null;
  }
  const loc = resolveCtx(ctx);
  if (!loc) return null;
  if (loc.view.kind === "browser") return { ...loc, url: loc.view.url };
  for (const g of allGroups(loc.content.layout)) {
    for (const v of g.views) {
      if (v.kind === "browser") {
        return { ...loc, group: g, view: v, url: v.url };
      }
    }
  }
  return null;
}

// ── 직렬화(state.tree) ──────────────────────────────────────────────────────

function serializeView(v: View) {
  if (v.kind === "terminal") {
    return {
      id: v.id,
      kind: v.kind,
      title: v.title,
      panes: collectLeafIds(v.layout),
      focusedPaneId: v.focusedPaneId,
    };
  }
  if (v.kind === "file") {
    return {
      id: v.id,
      kind: v.kind,
      title: v.title,
      path: v.path,
      mode: v.mode,
      dirty: v.dirty ?? false,
    };
  }
  return { id: v.id, kind: v.kind, title: v.title, url: v.url };
}

// 그룹 트리(분할 구조 — splitId/dir/sizes 는 panel.resize 의 대상).
function serializeLayout(node: GroupNode): object {
  if (node.type === "leaf") return { panel: node.group.id };
  return {
    split: { id: node.id, dir: node.dir, sizes: node.sizes },
    children: node.children.map(serializeLayout),
  };
}

function serializeContent(c: ContentArea, activeContentId: string) {
  const { cells } = computeLayout(c.layout);
  return {
    id: c.id,
    title: c.title,
    program: c.program,
    active: c.id === activeContentId,
    activeGroupId: c.activeGroupId,
    layout: serializeLayout(c.layout),
    panels: cells.map(({ group, rect }) => ({
      id: group.id,
      rect: {
        left: Math.round(rect.left * 10) / 10,
        top: Math.round(rect.top * 10) / 10,
        width: Math.round(rect.width * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
      },
      active: group.id === c.activeGroupId,
      activeViewId: group.activeViewId,
      views: group.views.map(serializeView),
    })),
  };
}

function serializeTree() {
  const s = useSessions.getState();
  return {
    activeProjectId: s.activeId,
    projects: s.tabs.map((t) => ({
      id: t.id,
      title: t.title,
      root: t.root ?? null,
      program: t.program ?? null,
      sidebarOpen: t.sidebarOpen,
      active: t.id === s.activeId,
      activeContentId: t.activeContentId,
      contents: t.contents.map((c) => serializeContent(c, t.activeContentId)),
    })),
  };
}

// ── 브라우저 eval 합성 ───────────────────────────────────────────────────────

const browserLabel = (viewId: string) => `b-${viewId}`;

// js 본문을 async 로 실행하고 JSON 문자열 결과를 받는다(Rust browser_eval 은
// WKWebView callAsyncJavaScript 네이티브 콜백 — CSP/IPC 권한 무관).
async function evalInBrowser(viewId: string, body: string): Promise<unknown> {
  const wrapped = `const __r = await (async () => { ${body} })(); return JSON.stringify(__r === undefined ? null : __r);`;
  const raw = await invoke<string>("browser_eval", {
    label: browserLabel(viewId),
    js: wrapped,
  });
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const sel = (s: string) => JSON.stringify(s);

// ── 파라미터 조각(재사용) ────────────────────────────────────────────────────

const P = {
  project: {
    type: "string",
    description: "대상 프로젝트 id(생략=호출 컨텍스트의 프로젝트)",
  },
  content: { type: "string", description: "대상 컨텐츠 id" },
  group: {
    type: "string",
    description: "대상 패널(그룹) id(생략=호출 컨텍스트의 패널)",
  },
  view: { type: "string", description: "대상 뷰 id(생략=호출 컨텍스트의 뷰)" },
  pane: {
    type: "string",
    description: "대상 pane id(생략=호출 컨텍스트의 pane, $SOKSAK_PANE)",
  },
  program: {
    type: "string",
    description: "프로그램",
    enum: ["terminal", "claude", "codex", "browser"],
  },
  side: {
    type: "string",
    description: "분할 방향",
    enum: ["left", "right", "top", "bottom"],
  },
  zone: {
    type: "string",
    description: "놓을 위치(center=이동/병합, 그 외=그 방향으로 분할)",
    enum: ["center", "left", "right", "top", "bottom"],
  },
} satisfies Record<string, import("./registry").ParamSpec>;

// ── 등록 ─────────────────────────────────────────────────────────────────────

export function registerCatalog(): void {
  const S = () => useSessions.getState();

  // ----- state -----
  register("state.tree", {
    description:
      "전체 구조 스냅샷(주소록): 프로젝트→컨텐츠→패널(rect %)→뷰→pane 의 모든 id 와 활성 상태",
    params: {},
    returns: "{ activeProjectId, projects[] } — panels[].rect 는 컨텐츠 영역 기준 %",
    examples: ["sok state.tree"],
    handler: () => serializeTree(),
  });

  register("state.commands", {
    description: "전체 명령 카탈로그(파라미터 스키마·반환·에러·예시) — 매뉴얼의 원천",
    params: {},
    returns: "{ commands: [{name,description,params,returns,errors,examples}] }",
    examples: ["sok commands"],
    handler: () => ({ commands: catalogJson() }),
  });

  register("state.context", {
    description:
      "호출자 위치: $SOKSAK_PANE 이 속한 프로젝트/컨텐츠/패널/뷰(터미널 밖이면 활성 체인)",
    params: { pane: P.pane },
    returns: "{ projectId, contentId, groupId, viewId, paneId? }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ["sok state.context"],
    handler: (p, ctx) => {
      const loc = p.pane
        ? locatePane(p.pane as string)
        : resolveCtx(ctx);
      if (!loc) return notFound("컨텍스트를 해석할 수 없음");
      return {
        projectId: loc.project.id,
        contentId: loc.content.id,
        groupId: loc.group.id,
        viewId: loc.view.id,
        paneId:
          (p.pane as string) ??
          ctx.pane ??
          (loc.view.kind === "terminal" ? loc.view.focusedPaneId : undefined),
      };
    },
  });

  // ----- project -----
  register("project.list", {
    description: "프로젝트 목록(id/제목/root/활성)",
    params: {},
    returns: "{ projects: [{id,title,root,active}] }",
    examples: ["sok project.list"],
    handler: () => ({
      projects: S().tabs.map((t) => ({
        id: t.id,
        title: t.title,
        root: t.root ?? null,
        active: t.id === S().activeId,
      })),
    }),
  });

  register("project.create", {
    description: "새 프로젝트(루트 폴더 + 첫 화면 프로그램 + 셸)",
    params: {
      root: { type: "string", description: "프로젝트 루트 디렉토리(절대경로)" },
      alias: { type: "string", description: "탭 별칭(생략=폴더명)" },
      program: { ...P.program, description: "첫 화면(생략=전역 설정)" },
      shell: { type: "string", description: "터미널 셸 경로(생략=전역 설정→$SHELL)" },
    },
    returns: "{ projectId, contentId, groupId, viewId, paneId? }",
    examples: ['sok project.create \'{"root":"/Users/me/work","program":"claude"}\''],
    handler: (p) =>
      S().addProject({
        alias: (p.alias as string) ?? "",
        root: p.root as string | undefined,
        program: p.program as Program | undefined,
        shell: p.shell as string | undefined,
      }),
  });

  register("project.close", {
    description: "프로젝트 닫기(마지막 프로젝트는 거부)",
    params: { project: { ...P.project, required: true } },
    returns: "{ activeProjectId }",
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['sok project.close \'{"project":"t2"}\''],
    handler: (p) => S().closeTab(p.project as string),
  });

  register("project.activate", {
    description: "프로젝트 전환",
    params: { project: { ...P.project, required: true } },
    returns: "{}",
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok project.activate \'{"project":"t2"}\''],
    handler: (p) => S().setActive(p.project as string),
  });

  register("project.rename", {
    description: "프로젝트 이름 변경",
    params: {
      project: { ...P.project, required: true },
      title: { type: "string", description: "새 이름", required: true },
    },
    returns: "{}",
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok project.rename \'{"project":"t1","title":"백엔드"}\''],
    handler: (p) => S().renameTab(p.project as string, p.title as string),
  });

  register("project.sidebar.toggle", {
    description: "파일트리 사이드바 토글",
    params: { project: P.project },
    returns: "{ sidebarOpen }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ["sok project.sidebar.toggle"],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      return S().toggleSidebar(t.id);
    },
  });

  // ----- content -----
  register("content.list", {
    description: "프로젝트의 컨텐츠 탭 목록",
    params: { project: P.project },
    returns: "{ contents: [{id,title,program,active}] }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ["sok content.list"],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      return {
        contents: t.contents.map((c) => ({
          id: c.id,
          title: c.title,
          program: c.program,
          active: c.id === t.activeContentId,
        })),
      };
    },
  });

  register("content.create", {
    description: "새 컨텐츠 탭(프로그램: 명시 > 프로젝트 설정 > 전역 설정)",
    params: { project: P.project, program: P.program },
    returns: "{ contentId, groupId, viewId, paneId? }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok content.create \'{"program":"browser"}\''],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      return S().addContent(t.id, p.program as Program | undefined);
    },
  });

  register("content.close", {
    description: "컨텐츠 탭 닫기(마지막 컨텐츠는 거부)",
    params: {
      project: P.project,
      content: { ...P.content, required: true },
    },
    returns: "{ activeContentId }",
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['sok content.close \'{"content":"c2"}\''],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      return S().closeContent(t.id, p.content as string);
    },
  });

  register("content.activate", {
    description: "컨텐츠 탭 전환",
    params: {
      project: P.project,
      content: { ...P.content, required: true },
    },
    returns: "{}",
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok content.activate \'{"content":"c2"}\''],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      return S().setActiveContent(t.id, p.content as string);
    },
  });

  register("content.rename", {
    description: "컨텐츠 탭 이름 변경",
    params: {
      project: P.project,
      content: { ...P.content, required: true },
      title: { type: "string", description: "새 이름", required: true },
    },
    returns: "{}",
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok content.rename \'{"content":"c1","title":"빌드"}\''],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      return S().renameContent(t.id, p.content as string, p.title as string);
    },
  });

  // ----- panel(그룹) -----
  register("panel.list", {
    description: "컨텐츠의 패널(분할창) 목록 + rect(%) + 분할 트리",
    params: { project: P.project, content: P.content },
    returns: "{ activeGroupId, layout, panels[] }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ["sok panel.list"],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      const c = p.content
        ? t.contents.find((x) => x.id === p.content)
        : (resolveCtx(ctx)?.content ??
          t.contents.find((x) => x.id === t.activeContentId));
      if (!c) return notFound(`컨텐츠 없음: ${p.content}`);
      const out = serializeContent(c, t.activeContentId);
      return {
        activeGroupId: out.activeGroupId,
        layout: out.layout,
        panels: out.panels,
      };
    },
  });

  register("panel.split", {
    description: "패널 분할 — 대상 패널 옆에 새 패널(프로그램 지정 가능)",
    params: {
      project: P.project,
      group: P.group,
      side: { ...P.side, required: true },
      program: { ...P.program, default: "terminal" },
    },
    returns: "{ groupId(새 패널), viewId, paneId? }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok panel.split \'{"side":"right"}\'', 'sok panel.split \'{"side":"bottom","program":"browser"}\''],
    handler: (p, ctx) => {
      const loc = resolveGroup(p, ctx);
      if (!loc) return notFound("대상 패널 없음");
      return S().splitWithNewView(
        loc.project.id,
        loc.group.id,
        p.side as Side,
        p.program as Program,
      );
    },
  });

  register("panel.merge", {
    description: "패널 병합 — src 패널의 모든 탭을 dst 패널로(빈 자리는 자동 정리)",
    params: {
      project: P.project,
      src: { type: "string", description: "원본 패널 id", required: true },
      dst: { type: "string", description: "대상 패널 id", required: true },
    },
    returns: "{ groupId(병합된 패널) }",
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['sok panel.merge \'{"src":"g2","dst":"g1"}\''],
    handler: (p, ctx) => {
      const loc = locateGroup(p.src as string) ?? resolveGroup(p, ctx);
      if (!loc) return notFound(`패널 없음: ${p.src}`);
      return S().moveGroupToGroup(
        loc.project.id,
        p.src as string,
        p.dst as string,
        "center",
      );
    },
  });

  register("panel.move", {
    description: "패널 재배치 — src 패널 통째를 dst 패널의 zone 위치로",
    params: {
      project: P.project,
      src: { type: "string", description: "원본 패널 id", required: true },
      dst: { type: "string", description: "대상 패널 id", required: true },
      zone: { ...P.zone, required: true },
    },
    returns: "{ groupId }",
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['sok panel.move \'{"src":"g2","dst":"g1","zone":"left"}\''],
    handler: (p) => {
      const loc = locateGroup(p.src as string);
      if (!loc) return notFound(`패널 없음: ${p.src}`);
      return S().moveGroupToGroup(
        loc.project.id,
        p.src as string,
        p.dst as string,
        p.zone as DropZone,
      );
    },
  });

  register("panel.close", {
    description: "패널 닫기(안의 모든 탭 제거, 마지막 패널은 거부)",
    params: { group: { ...P.group, required: true } },
    returns: "{ activeGroupId }",
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['sok panel.close \'{"group":"g2"}\''],
    handler: (p) => {
      const loc = locateGroup(p.group as string);
      if (!loc) return notFound(`패널 없음: ${p.group}`);
      return S().closeGroup(loc.project.id, p.group as string);
    },
  });

  register("panel.focus", {
    description: "패널 활성화(포커스)",
    params: { group: { ...P.group, required: true } },
    returns: "{}",
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok panel.focus \'{"group":"g2"}\''],
    handler: (p) => {
      const loc = locateGroup(p.group as string);
      if (!loc) return notFound(`패널 없음: ${p.group}`);
      const r = S().setActiveGroup(loc.project.id, p.group as string);
      if (r.ok && loc.view.kind === "terminal") focusHost(loc.view.focusedPaneId);
      return r;
    },
  });

  register("panel.resize", {
    description:
      "분할 비율 조절 — splitId(state.tree 의 layout.split.id)와 children 수만큼의 비율(합 1)",
    params: {
      project: P.project,
      split: { type: "string", description: "분할 노드 id(예: s1)", required: true },
      sizes: {
        type: "number[]",
        description: "자식 비율 배열(합 1, 예: [0.7,0.3])",
        required: true,
      },
    },
    returns: "{}",
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: ['sok panel.resize \'{"split":"s1","sizes":[0.7,0.3]}\''],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      return S().resizeSplit(t.id, p.split as string, p.sizes as number[]);
    },
  });

  // ----- view(탭) -----
  register("view.list", {
    description: "패널의 뷰(탭) 목록",
    params: { group: P.group },
    returns: "{ groupId, activeViewId, views[] }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ["sok view.list"],
    handler: (p, ctx) => {
      const loc = resolveGroup(p, ctx);
      if (!loc) return notFound("패널 없음");
      return {
        groupId: loc.group.id,
        activeViewId: loc.group.activeViewId,
        views: loc.group.views.map(serializeView),
      };
    },
  });

  register("view.open", {
    description: "패널에 새 뷰 탭(터미널/claude/codex/브라우저[url])",
    params: {
      group: P.group,
      program: { ...P.program, required: true },
      url: { type: "string", description: "브라우저 시작 URL(program=browser)" },
    },
    returns: "{ groupId, viewId, paneId? }",
    errors: ["TARGET_NOT_FOUND"],
    examples: [
      'sok view.open \'{"program":"claude"}\'',
      'sok view.open \'{"program":"browser","url":"https://example.com"}\'',
    ],
    handler: (p, ctx) => {
      const loc = resolveGroup(p, ctx);
      if (!loc) return notFound("패널 없음");
      return S().addViewToGroup(
        loc.project.id,
        p.program as Program,
        loc.group.id,
        { url: p.url as string | undefined },
      );
    },
  });

  register("view.close", {
    description: "뷰(탭) 닫기 — 패널의 마지막 뷰면 패널도 정리(컨텐츠 마지막 뷰는 거부)",
    params: { view: { ...P.view, required: true } },
    returns: "{ activeGroupId, activeViewId }",
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['sok view.close \'{"view":"v3"}\''],
    handler: (p) => {
      const loc = locateView(p.view as string);
      if (!loc) return notFound(`뷰 없음: ${p.view}`);
      return S().closeView(loc.project.id, p.view as string);
    },
  });

  register("view.activate", {
    description: "뷰(탭) 활성화",
    params: { view: { ...P.view, required: true } },
    returns: "{}",
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok view.activate \'{"view":"v3"}\''],
    handler: (p) => {
      const loc = locateView(p.view as string);
      if (!loc) return notFound(`뷰 없음: ${p.view}`);
      return S().setActiveView(loc.project.id, p.view as string);
    },
  });

  register("view.move", {
    description: "뷰(탭)를 dst 패널의 zone 위치로(center=이동, 그 외=분할해 새 패널)",
    params: {
      view: { ...P.view, required: true },
      dst: { type: "string", description: "대상 패널 id", required: true },
      zone: { ...P.zone, required: true },
    },
    returns: "{ groupId(이동/생성된 패널) }",
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['sok view.move \'{"view":"v3","dst":"g1","zone":"right"}\''],
    handler: (p) => {
      const loc = locateView(p.view as string);
      if (!loc) return notFound(`뷰 없음: ${p.view}`);
      return S().moveViewToGroup(
        loc.project.id,
        p.view as string,
        p.dst as string,
        p.zone as DropZone,
      );
    },
  });

  // ----- pane(터미널 내부 분할) -----
  register("pane.list", {
    description: "터미널 뷰의 pane 목록",
    params: { view: P.view, pane: P.pane },
    returns: "{ viewId, panes[], focusedPaneId }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ["sok pane.list"],
    handler: (p, ctx) => {
      const loc = p.view
        ? locateView(p.view as string)
        : (resolvePane(p, ctx)?.loc ?? null);
      if (!loc || loc.view.kind !== "terminal")
        return notFound("터미널 뷰 없음");
      return {
        viewId: loc.view.id,
        panes: collectLeafIds(loc.view.layout),
        focusedPaneId: loc.view.focusedPaneId,
      };
    },
  });

  register("pane.split", {
    description: "터미널 pane 분할(row=좌우, col=상하)",
    params: {
      pane: P.pane,
      dir: {
        type: "string",
        description: "분할 방향",
        enum: ["row", "col"],
        required: true,
      },
    },
    returns: "{ paneId(새 pane) }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok pane.split \'{"dir":"row"}\''],
    handler: (p, ctx) => {
      const r = resolvePane(p, ctx);
      if (!r) return notFound("pane 없음");
      return S().splitPane(r.loc.project.id, r.loc.view.id, r.paneId, p.dir as "row" | "col");
    },
  });

  register("pane.close", {
    description: "터미널 pane 닫기(마지막 pane 은 거부 — view.close 사용)",
    params: { pane: { ...P.pane, required: true } },
    returns: "{ focusedPaneId }",
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['sok pane.close \'{"pane":"p3"}\''],
    handler: (p) => {
      const loc = locatePane(p.pane as string);
      if (!loc) return notFound(`pane 없음: ${p.pane}`);
      return S().closePane(loc.project.id, loc.view.id, p.pane as string);
    },
  });

  register("pane.focus", {
    description: "터미널 pane 포커스",
    params: { pane: { ...P.pane, required: true } },
    returns: "{}",
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok pane.focus \'{"pane":"p3"}\''],
    handler: (p) => {
      const loc = locatePane(p.pane as string);
      if (!loc) return notFound(`pane 없음: ${p.pane}`);
      const r = S().setFocusedPane(loc.project.id, loc.view.id, p.pane as string);
      if (r.ok) focusHost(p.pane as string);
      return r;
    },
  });

  // ----- term(터미널 입출력 — AI 의 눈과 손) -----
  register("term.read", {
    description:
      "터미널 화면+스크롤백 텍스트 읽기(TUI 는 현재 화면). 실행 결과 확인용",
    params: {
      pane: P.pane,
      lines: { type: "number", description: "끝에서 N 줄만(생략=전체)" },
    },
    returns: "{ paneId, text }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ["sok term.read", 'sok term.read \'{"lines":50}\''],
    handler: (p, ctx) => {
      const r = resolvePane(p, ctx);
      if (!r) return notFound("pane 없음");
      const text = readHostBuffer(r.paneId, p.lines as number | undefined);
      if (text === undefined) return notFound(`터미널 준비 안 됨: ${r.paneId}`);
      return { paneId: r.paneId, text };
    },
  });

  register("term.send", {
    description:
      "터미널에 raw 키 입력 주입(TUI 조작). JSON 이스케이프로 제어키 전달: \\r=Enter, \\u0003=^C, \\u001b[A=↑",
    params: {
      pane: P.pane,
      text: { type: "string", description: "주입할 바이트(이스케이프 허용)", required: true },
    },
    returns: "{ paneId }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok term.send \'{"text":"ls\\r"}\'', 'sok term.send \'{"text":"\\u0003"}\''],
    handler: (p, ctx) => {
      const r = resolvePane(p, ctx);
      if (!r) return notFound("pane 없음");
      if (!sendInputToHost(r.paneId, p.text as string))
        return notFound(`터미널 준비 안 됨: ${r.paneId}`);
      return { paneId: r.paneId };
    },
  });

  register("term.exec", {
    description: "터미널에서 명령 실행(text + Enter). 결과는 term.read 로 확인",
    params: {
      pane: P.pane,
      cmd: { type: "string", description: "실행할 셸 명령", required: true },
    },
    returns: "{ paneId }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok term.exec \'{"cmd":"git status"}\''],
    handler: (p, ctx) => {
      const r = resolvePane(p, ctx);
      if (!r) return notFound("pane 없음");
      if (!sendInputToHost(r.paneId, `${p.cmd as string}\r`))
        return notFound(`터미널 준비 안 됨: ${r.paneId}`);
      return { paneId: r.paneId };
    },
  });

  register("term.cwd", {
    description: "터미널의 현재 작업 디렉토리(셸 통합 기반)",
    params: { pane: P.pane },
    returns: "{ paneId, cwd|null }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ["sok term.cwd"],
    handler: (p, ctx) => {
      const r = resolvePane(p, ctx);
      if (!r) return notFound("pane 없음");
      return { paneId: r.paneId, cwd: getCwdOfHost(r.paneId) ?? null };
    },
  });

  // ----- browser -----
  register("browser.open", {
    description: "브라우저 열기 — 패널 탭(where=panel) 또는 독립 OS 창(where=window)",
    params: {
      url: { type: "string", description: "시작 URL", default: BROWSER_HOME },
      where: {
        type: "string",
        description: "여는 위치",
        enum: ["panel", "window"],
        default: "panel",
      },
      group: P.group,
    },
    returns: "panel: { groupId, viewId } / window: {}",
    errors: ["TARGET_NOT_FOUND", "INTERNAL"],
    examples: ['sok browser.open \'{"url":"https://example.com"}\''],
    handler: async (p, ctx) => {
      if (p.where === "window") {
        await invoke("browser_open_window", { url: p.url as string });
        return {};
      }
      const loc = resolveGroup(p, ctx);
      if (!loc) return notFound("패널 없음");
      return S().addViewToGroup(loc.project.id, "browser", loc.group.id, {
        url: p.url as string,
      });
    },
  });

  register("browser.navigate", {
    description: "브라우저 뷰를 URL 로 이동",
    params: {
      view: P.view,
      url: { type: "string", description: "이동할 URL", required: true },
    },
    returns: "{ viewId, url }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok browser.navigate \'{"url":"https://news.ycombinator.com"}\''],
    handler: async (p, ctx) => {
      const b = resolveBrowser(p, ctx);
      if (!b) return notFound("브라우저 뷰 없음");
      S().setBrowserUrl(b.project.id, b.view.id, p.url as string);
      await invoke("browser_navigate", {
        label: browserLabel(b.view.id),
        url: p.url as string,
      });
      return { viewId: b.view.id, url: p.url };
    },
  });

  register("browser.back", {
    description: "브라우저 이전 페이지",
    params: { view: P.view },
    returns: "{ viewId }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ["sok browser.back"],
    handler: async (p, ctx) => {
      const b = resolveBrowser(p, ctx);
      if (!b) return notFound("브라우저 뷰 없음");
      await invoke("browser_history", { label: browserLabel(b.view.id), delta: -1 });
      return { viewId: b.view.id };
    },
  });

  register("browser.forward", {
    description: "브라우저 다음 페이지",
    params: { view: P.view },
    returns: "{ viewId }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ["sok browser.forward"],
    handler: async (p, ctx) => {
      const b = resolveBrowser(p, ctx);
      if (!b) return notFound("브라우저 뷰 없음");
      await invoke("browser_history", { label: browserLabel(b.view.id), delta: 1 });
      return { viewId: b.view.id };
    },
  });

  register("browser.reload", {
    description: "브라우저 새로고침",
    params: { view: P.view },
    returns: "{ viewId, url }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ["sok browser.reload"],
    handler: async (p, ctx) => {
      const b = resolveBrowser(p, ctx);
      if (!b) return notFound("브라우저 뷰 없음");
      await invoke("browser_navigate", {
        label: browserLabel(b.view.id),
        url: b.url,
      });
      return { viewId: b.view.id, url: b.url };
    },
  });

  register("browser.eval", {
    description:
      "브라우저 페이지에서 임의 JS 실행(async 가능, return 값이 JSON 으로 반환됨)",
    params: {
      view: P.view,
      js: {
        type: "string",
        description: "실행할 JS 본문(예: return document.title)",
        required: true,
      },
    },
    returns: "{ viewId, result }",
    errors: ["TARGET_NOT_FOUND", "INTERNAL"],
    examples: ['sok browser.eval \'{"js":"return document.title"}\''],
    handler: async (p, ctx) => {
      const b = resolveBrowser(p, ctx);
      if (!b) return notFound("브라우저 뷰 없음");
      const result = await evalInBrowser(b.view.id, p.js as string);
      return { viewId: b.view.id, result };
    },
  });

  // ----- browser.dom -----
  register("browser.dom.text", {
    description: "페이지(또는 selector 요소)의 보이는 텍스트",
    params: {
      view: P.view,
      selector: { type: "string", description: "CSS selector(생략=본문 전체)" },
      maxLength: { type: "number", description: "최대 길이", default: 20000 },
    },
    returns: "{ viewId, text|null }",
    errors: ["TARGET_NOT_FOUND", "INTERNAL"],
    examples: ["sok browser.dom.text", 'sok browser.dom.text \'{"selector":"#main"}\''],
    handler: async (p, ctx) => {
      const b = resolveBrowser(p, ctx);
      if (!b) return notFound("브라우저 뷰 없음");
      const js = p.selector
        ? `const el = document.querySelector(${sel(p.selector as string)}); return el ? el.innerText.slice(0, ${p.maxLength}) : null;`
        : `return document.body.innerText.slice(0, ${p.maxLength});`;
      const text = await evalInBrowser(b.view.id, js);
      return { viewId: b.view.id, text };
    },
  });

  register("browser.dom.html", {
    description: "페이지(또는 selector 요소)의 HTML",
    params: {
      view: P.view,
      selector: { type: "string", description: "CSS selector(생략=문서 전체)" },
      maxLength: { type: "number", description: "최대 길이", default: 50000 },
    },
    returns: "{ viewId, html|null }",
    errors: ["TARGET_NOT_FOUND", "INTERNAL"],
    examples: ['sok browser.dom.html \'{"selector":"form"}\''],
    handler: async (p, ctx) => {
      const b = resolveBrowser(p, ctx);
      if (!b) return notFound("브라우저 뷰 없음");
      const js = p.selector
        ? `const el = document.querySelector(${sel(p.selector as string)}); return el ? el.outerHTML.slice(0, ${p.maxLength}) : null;`
        : `return document.documentElement.outerHTML.slice(0, ${p.maxLength});`;
      const html = await evalInBrowser(b.view.id, js);
      return { viewId: b.view.id, html };
    },
  });

  register("browser.dom.query", {
    description: "selector 매칭 요소 요약(태그/텍스트/속성) — 페이지 구조 파악용",
    params: {
      view: P.view,
      selector: { type: "string", description: "CSS selector", required: true },
      limit: { type: "number", description: "최대 개수", default: 20 },
    },
    returns: "{ viewId, count, elements[] }",
    errors: ["TARGET_NOT_FOUND", "INTERNAL"],
    examples: ['sok browser.dom.query \'{"selector":"a"}\''],
    handler: async (p, ctx) => {
      const b = resolveBrowser(p, ctx);
      if (!b) return notFound("브라우저 뷰 없음");
      const js = `
        const all = [...document.querySelectorAll(${sel(p.selector as string)})];
        return { count: all.length, elements: all.slice(0, ${p.limit}).map(e => ({
          tag: e.tagName.toLowerCase(),
          text: (e.innerText || "").trim().slice(0, 120) || undefined,
          id: e.id || undefined,
          class: (typeof e.className === "string" && e.className) || undefined,
          name: e.getAttribute("name") || undefined,
          href: e.getAttribute("href") || undefined,
          type: e.getAttribute("type") || undefined,
          value: e.value !== undefined ? String(e.value).slice(0, 120) : undefined,
        })) };`;
      const r = await evalInBrowser(b.view.id, js);
      return { viewId: b.view.id, ...(r as object) };
    },
  });

  register("browser.dom.click", {
    description: "selector 첫 매칭 요소 클릭",
    params: {
      view: P.view,
      selector: { type: "string", description: "CSS selector", required: true },
    },
    returns: "{ viewId, clicked }",
    errors: ["TARGET_NOT_FOUND", "INTERNAL"],
    examples: ['sok browser.dom.click \'{"selector":"button[type=submit]"}\''],
    handler: async (p, ctx) => {
      const b = resolveBrowser(p, ctx);
      if (!b) return notFound("브라우저 뷰 없음");
      const js = `const el = document.querySelector(${sel(p.selector as string)}); if (!el) return { clicked: false, reason: "selector 매칭 없음" }; el.click(); return { clicked: true };`;
      const r = await evalInBrowser(b.view.id, js);
      return { viewId: b.view.id, ...(r as object) };
    },
  });

  register("browser.dom.fill", {
    description: "입력 요소에 값 채우기(input/change 이벤트 발화 — React 폼 호환)",
    params: {
      view: P.view,
      selector: { type: "string", description: "CSS selector", required: true },
      text: { type: "string", description: "입력할 값", required: true },
    },
    returns: "{ viewId, filled }",
    errors: ["TARGET_NOT_FOUND", "INTERNAL"],
    examples: ['sok browser.dom.fill \'{"selector":"input[name=q]","text":"soksak"}\''],
    handler: async (p, ctx) => {
      const b = resolveBrowser(p, ctx);
      if (!b) return notFound("브라우저 뷰 없음");
      const js = `
        const el = document.querySelector(${sel(p.selector as string)});
        if (!el) return { filled: false, reason: "selector 매칭 없음" };
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(el, ${sel(String(p.text))}); else el.value = ${sel(String(p.text))};
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { filled: true };`;
      const r = await evalInBrowser(b.view.id, js);
      return { viewId: b.view.id, ...(r as object) };
    },
  });

  register("browser.dom.submit", {
    description: "폼 제출(selector=form 또는 폼 내부 요소)",
    params: {
      view: P.view,
      selector: { type: "string", description: "CSS selector", required: true },
    },
    returns: "{ viewId, submitted }",
    errors: ["TARGET_NOT_FOUND", "INTERNAL"],
    examples: ['sok browser.dom.submit \'{"selector":"form"}\''],
    handler: async (p, ctx) => {
      const b = resolveBrowser(p, ctx);
      if (!b) return notFound("브라우저 뷰 없음");
      const js = `
        const el = document.querySelector(${sel(p.selector as string)});
        if (!el) return { submitted: false, reason: "selector 매칭 없음" };
        const form = el instanceof HTMLFormElement ? el : el.closest("form");
        if (!form) return { submitted: false, reason: "form 없음" };
        form.requestSubmit ? form.requestSubmit() : form.submit();
        return { submitted: true };`;
      const r = await evalInBrowser(b.view.id, js);
      return { viewId: b.view.id, ...(r as object) };
    },
  });

  register("browser.dom.waitFor", {
    description: "selector 가 나타날 때까지 대기(동적 페이지 — MutationObserver)",
    params: {
      view: P.view,
      selector: { type: "string", description: "CSS selector", required: true },
      timeoutMs: { type: "number", description: "최대 대기(ms)", default: 5000 },
    },
    returns: "{ viewId, found }",
    errors: ["TARGET_NOT_FOUND", "INTERNAL"],
    examples: ['sok browser.dom.waitFor \'{"selector":".results"}\''],
    handler: async (p, ctx) => {
      const b = resolveBrowser(p, ctx);
      if (!b) return notFound("브라우저 뷰 없음");
      const js = `
        const find = () => document.querySelector(${sel(p.selector as string)});
        if (find()) return { found: true };
        return await new Promise((resolve) => {
          const obs = new MutationObserver(() => {
            if (find()) { obs.disconnect(); clearTimeout(timer); resolve({ found: true }); }
          });
          const timer = setTimeout(() => { obs.disconnect(); resolve({ found: false }); }, ${p.timeoutMs});
          obs.observe(document.documentElement, { childList: true, subtree: true });
        });`;
      const r = await evalInBrowser(b.view.id, js);
      return { viewId: b.view.id, ...(r as object) };
    },
  });

  // ----- bookmark -----
  register("bookmark.list", {
    description: "즐겨찾기 목록",
    params: {},
    returns: "{ bookmarks: [{url,title}] }",
    examples: ["sok bookmark.list"],
    handler: () => ({ bookmarks: useBookmarks.getState().list }),
  });

  register("bookmark.add", {
    description: "즐겨찾기 추가",
    params: {
      url: { type: "string", description: "URL", required: true },
      title: { type: "string", description: "표시 이름(생략=호스트)" },
    },
    returns: "{}",
    examples: ['sok bookmark.add \'{"url":"https://example.com"}\''],
    handler: (p) => {
      const url = p.url as string;
      const bm = useBookmarks.getState();
      if (!bm.has(url)) {
        const title =
          (p.title as string) ??
          (() => {
            try {
              return new URL(url).host;
            } catch {
              return url;
            }
          })();
        bm.toggle(url, title);
      }
      return {};
    },
  });

  register("bookmark.remove", {
    description: "즐겨찾기 제거",
    params: { url: { type: "string", description: "URL", required: true } },
    returns: "{}",
    examples: ['sok bookmark.remove \'{"url":"https://example.com"}\''],
    handler: (p) => {
      useBookmarks.getState().remove(p.url as string);
      return {};
    },
  });

  // ----- editor(파일 뷰) -----
  register("editor.open", {
    description: "파일을 에디터 뷰로 열기(이미 열려 있으면 그 탭 활성화)",
    params: {
      project: P.project,
      path: { type: "string", description: "파일 절대경로", required: true },
    },
    returns: "{ viewId, groupId, existing }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok editor.open \'{"path":"/Users/me/work/src/main.rs"}\''],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      return S().openFileView(t.id, p.path as string);
    },
  });

  register("editor.save", {
    description: "에디터 뷰 저장(⌘S 와 동일)",
    params: { view: { ...P.view, required: true } },
    returns: "{ saved, reason? }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok editor.save \'{"view":"v4"}\''],
    handler: async (p) => {
      const r = saveFileView(p.view as string);
      if (!r) return notFound(`열려 있는 에디터 뷰 없음: ${p.view}`);
      return await r;
    },
  });

  const FIND_OPTS = {
    caseSensitive: { type: "boolean", description: "대소문자 구분", default: false },
    regexp: { type: "boolean", description: "정규식 사용", default: false },
    wholeWord: { type: "boolean", description: "단어 단위 일치", default: false },
  } satisfies Record<string, import("./registry").ParamSpec>;

  register("editor.find", {
    description: "에디터 뷰에서 찾기(하이라이트 + 첫 매치 선택). 매치 수 반환",
    params: {
      view: { ...P.view, required: true },
      query: { type: "string", description: "찾을 문자열/패턴", required: true },
      ...FIND_OPTS,
    },
    returns: "{ matches }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok editor.find \'{"view":"v4","query":"TODO"}\''],
    handler: (p) => {
      const api = getFileView(p.view as string);
      if (!api) return notFound(`열려 있는 에디터 뷰 없음: ${p.view}`);
      return api.find(p.query as string, {
        caseSensitive: p.caseSensitive as boolean,
        regexp: p.regexp as boolean,
        wholeWord: p.wholeWord as boolean,
      });
    },
  });

  register("editor.replace", {
    description:
      "에디터 뷰에서 바꾸기(all=true 전체, 아니면 1건). 치환 수 반환 — 저장은 editor.save",
    params: {
      view: { ...P.view, required: true },
      query: { type: "string", description: "찾을 문자열/패턴", required: true },
      replacement: { type: "string", description: "바꿀 문자열", required: true },
      all: { type: "boolean", description: "모두 바꾸기", default: true },
      ...FIND_OPTS,
    },
    returns: "{ replaced }",
    errors: ["TARGET_NOT_FOUND"],
    examples: [
      'sok editor.replace \'{"view":"v4","query":"foo","replacement":"bar"}\'',
    ],
    handler: (p) => {
      const api = getFileView(p.view as string);
      if (!api) return notFound(`열려 있는 에디터 뷰 없음: ${p.view}`);
      return api.replace(p.query as string, p.replacement as string, {
        caseSensitive: p.caseSensitive as boolean,
        regexp: p.regexp as boolean,
        wholeWord: p.wholeWord as boolean,
        all: p.all as boolean,
      });
    },
  });

  register("editor.close", {
    description: "에디터 뷰 닫기(view.close 와 동일)",
    params: { view: { ...P.view, required: true } },
    returns: "{ activeGroupId, activeViewId }",
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['sok editor.close \'{"view":"v4"}\''],
    handler: (p) => {
      const loc = locateView(p.view as string);
      if (!loc) return notFound(`뷰 없음: ${p.view}`);
      return S().closeView(loc.project.id, p.view as string);
    },
  });

  // ----- explorer(파일 탐색기) -----
  register("explorer.list", {
    description:
      "디렉토리 직속 자식 나열(파일트리와 동일한 뷰). path 생략=프로젝트 root(없으면 HOME)",
    params: {
      project: P.project,
      path: { type: "string", description: "디렉토리 절대경로" },
    },
    returns: "{ root, children: [{name,dir}] }",
    errors: ["TARGET_NOT_FOUND", "INTERNAL"],
    examples: ["sok explorer.list", 'sok explorer.list \'{"path":"/tmp"}\''],
    handler: async (p, ctx) => {
      const t = resolveProject(p, ctx);
      const path = (p.path as string) ?? t?.root ?? null;
      return await invoke<{ root: string; children: object[] }>(
        "list_children",
        { path },
      );
    },
  });

  register("explorer.git", {
    description: "디렉토리의 git 변경 상태(파일트리 데코레이션과 동일)",
    params: {
      project: P.project,
      path: { type: "string", description: "git repo 디렉토리(생략=프로젝트 root)" },
    },
    returns: "{ entries: [{path,status}] } — repo 아니면 빈 목록",
    errors: ["TARGET_NOT_FOUND", "INTERNAL"],
    examples: ["sok explorer.git"],
    handler: async (p, ctx) => {
      const t = resolveProject(p, ctx);
      const path = (p.path as string) ?? t?.root;
      if (!path) return notFound("path 또는 프로젝트 root 필요");
      const entries = await invoke<object[]>("git_status", { path });
      return { entries };
    },
  });

  // ----- settings / theme -----
  const SETTING_KEYS = [
    "language",
    "projectTabPosition",
    "splitHeaderMode",
    "defaultProgram",
    "shell",
    "fontFamily",
    "fontSize",
    "cursorBlink",
    "cursorStyle",
    "scrollback",
  ] as const;

  register("settings.get", {
    description: "앱 설정 전체 조회",
    params: {},
    returns: `{ ${SETTING_KEYS.join(", ")}, bg }`,
    examples: ["sok settings.get"],
    handler: () => {
      const s = useSettings.getState();
      return {
        language: s.language,
        projectTabPosition: s.projectTabPosition,
        splitHeaderMode: s.splitHeaderMode,
        defaultProgram: s.defaultProgram,
        shell: s.shell,
        fontFamily: s.fontFamily,
        fontSize: s.fontSize,
        cursorBlink: s.cursorBlink,
        cursorStyle: s.cursorStyle,
        scrollback: s.scrollback,
        bg: useUi.getState().bg,
      };
    },
  });

  register("settings.set", {
    description: `설정 변경. key: ${SETTING_KEYS.join("|")}`,
    params: {
      key: {
        type: "string",
        description: "설정 키",
        enum: SETTING_KEYS,
        required: true,
      },
      value: {
        type: "json",
        description:
          "값 — language:ko|en, projectTabPosition:top|left, splitHeaderMode:title|tabs, defaultProgram:terminal|claude|codex|browser, fontFamily:string, fontSize:number, cursorBlink:boolean, cursorStyle:block|bar|underline, scrollback:number",
        required: true,
      },
    },
    returns: "{ key, value }",
    errors: ["INVALID_PARAMS"],
    examples: [
      'sok settings.set \'{"key":"fontSize","value":14}\'',
      'sok settings.set \'{"key":"splitHeaderMode","value":"tabs"}\'',
    ],
    handler: (p) => {
      const s = useSettings.getState();
      const key = p.key as (typeof SETTING_KEYS)[number];
      const v = p.value;
      const bad = (need: string) => ({
        ok: false as const,
        code: "INVALID_PARAMS" as const,
        message: `${key}: ${need} 이어야 함`,
      });
      switch (key) {
        case "language":
          if (v !== "ko" && v !== "en") return bad("ko|en");
          s.setLanguage(v);
          break;
        case "projectTabPosition":
          if (v !== "top" && v !== "left") return bad("top|left");
          s.setProjectTabPosition(v);
          break;
        case "splitHeaderMode":
          if (v !== "title" && v !== "tabs") return bad("title|tabs");
          s.setSplitHeaderMode(v);
          break;
        case "defaultProgram":
          if (v !== "terminal" && v !== "claude" && v !== "codex" && v !== "browser")
            return bad("terminal|claude|codex|browser");
          s.setDefaultProgram(v);
          break;
        case "shell":
          if (typeof v !== "string") return bad("string(셸 경로, ''=기본)");
          s.setShell(v);
          break;
        case "fontFamily":
          if (typeof v !== "string") return bad("string");
          s.setFontFamily(v);
          break;
        case "fontSize":
          if (typeof v !== "number") return bad("number");
          s.setFontSize(v);
          break;
        case "cursorBlink":
          if (typeof v !== "boolean") return bad("boolean");
          s.setCursorBlink(v);
          break;
        case "cursorStyle":
          if (v !== "block" && v !== "bar" && v !== "underline")
            return bad("block|bar|underline");
          s.setCursorStyle(v);
          break;
        case "scrollback":
          if (typeof v !== "number") return bad("number");
          s.setScrollback(v);
          break;
      }
      return { key, value: v };
    },
  });

  register("theme.set", {
    description: "배경색 변경(터미널/에디터/UI 전체가 따름. 글자색은 밝기로 자동)",
    params: {
      bg: { type: "string", description: "배경색(#rrggbb)", required: true },
    },
    returns: "{ bg }",
    errors: ["INVALID_PARAMS"],
    examples: ['sok theme.set \'{"bg":"#1e2030"}\''],
    handler: (p) => {
      const bg = p.bg as string;
      if (!/^#[0-9a-fA-F]{6}$/.test(bg)) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: "bg 는 #rrggbb 형식",
        };
      }
      useUi.getState().setBg(bg);
      return { bg };
    },
  });
}
