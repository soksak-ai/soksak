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
  browserHome,
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
import { useTheme } from "../state/theme";
import { useIconRegistry } from "../ui/icons/registry";
import {
  focusHost,
  getCwdOfHost,
  readHostBuffer,
  sendInputToHost,
} from "../terminal/paneHosts";
import { computeLayout } from "../components/GroupArea";
import { browserLabel } from "../lib/webviewLabels";
import { catalogJson, register, type CommandContext } from "./registry";
import { registerGitCatalog } from "./catalogGit";
import { registerPluginCatalog } from "./catalogPlugins";
import { registerUiCatalog } from "./catalogUi";
import { registerDomCatalog } from "./catalogDom";
import { registerDataCatalog } from "./catalogData";
import { registerSecretsCatalog } from "./catalogSecrets";
import { registerTurnCatalog } from "./catalogTurn";
import { registerNetworkCatalog } from "./catalogNetwork";
import { registerMediaCatalog } from "./catalogMedia";
import { registerClipboardCatalog } from "./catalogClipboard";
import { registerNotifyCatalog } from "./catalogNotify";
import { registerScheduleCatalog } from "./catalogSchedule";
import {
  ensureDefaultWorkspace,
  FOLDER_NAME_RE,
  validateProjectRoot,
} from "../lib/workspace";

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
// splitId 로 분할 노드를 프로젝트 전체에서 검색(panel.equalize 의 현재 비율 조회용).
function findSplitNode(
  t: ProjectTab,
  splitId: string,
): Extract<GroupNode, { type: "split" }> | null {
  const walk = (n: GroupNode): Extract<GroupNode, { type: "split" }> | null => {
    if (n.type === "leaf") return null;
    if (n.id === splitId) return n;
    for (const c of n.children) {
      const r = walk(c);
      if (r) return r;
    }
    return null;
  };
  for (const c of t.contents) {
    const r = walk(c.layout);
    if (r) return r;
  }
  return null;
}

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
      dirty: v.status?.code === "dirty",
    };
  }
  if (v.kind === "plugin") {
    return {
      id: v.id,
      kind: v.kind,
      title: v.title,
      plugin: v.pluginId,
      view: v.view,
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
    active: c.id === activeContentId,
    activeGroupId: c.activeGroupId,
    maximizedViewId: c.maximizedViewId ?? null,
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
      color: t.color ?? null,
      sidebarOpen: t.sidebarOpen,
      active: t.id === s.activeId,
      activeContentId: t.activeContentId,
      contents: t.contents.map((c) => serializeContent(c, t.activeContentId)),
    })),
  };
}

// ── 브라우저 eval 합성 ───────────────────────────────────────────────────────
// 브라우저 webview label 은 webviewLabels 단일 진실에서만 파생(창 네임스페이스 — 멀티 윈도우 충돌 방지).

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
    description: "Target project id (omit = caller's context project)",
  },
  content: { type: "string", description: "Target content tab id" },
  group: {
    type: "string",
    description: "Target panel (group) id (omit = caller's context panel)",
  },
  view: { type: "string", description: "Target view id (omit = caller's context view)" },
  pane: {
    type: "string",
    description: "Target pane id (omit = caller's context pane, $SOKSAK_PANE)",
  },
  program: {
    type: "string",
    description:
      "Program id — plugin-registered only (see program.list; no built-in default). Unregistered id falls back to terminal view",
  },
  side: {
    type: "string",
    description: "Split direction",
    enum: ["left", "right", "top", "bottom"],
  },
  zone: {
    type: "string",
    description: "Drop zone (center = move/merge; others = split in that direction)",
    enum: ["center", "left", "right", "top", "bottom"],
  },
} satisfies Record<string, import("./registry").ParamSpec>;

// ── 등록 ─────────────────────────────────────────────────────────────────────

export function registerCatalog(): void {
  const S = () => useSessions.getState();

  // ----- state -----
  // ui.measure / ui.tree / ui.input.* 는 catalogDom.ts(주소 기반) — selector 측정은 폐기(주소 체계로 전환).

  register("state.tree", {
    description:
      "Full layout snapshot (address book): all ids and active state across project → content → panel (rect %) → view → pane. Use to discover ids before targeting other commands.",
    params: {},
    returns: "{ activeProjectId, projects[] } — panels[].rect is % of the content area",
    examples: ["sok state.tree"],
    handler: () => serializeTree(),
  });

  register("state.commands", {
    description: "Full command catalog with parameter schemas, returns, errors, and examples — the source of truth for all available commands.",
    params: {},
    returns: "{ commands: [{name,description,params,returns,errors,examples}] }",
    examples: ["sok commands"],
    handler: () => ({ commands: catalogJson() }),
  });

  register("state.context", {
    description:
      "Resolve the caller's position: project/content/panel/view that $SOKSAK_PANE belongs to (falls back to active chain when called outside a terminal).",
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
    description: "List all projects with id, title, root path, and active state.",
    triggers: { ko: "프로젝트 목록 프로젝트 리스트 열린 프로젝트" },
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
    description:
      "Create a new project. When root is omitted, folder (slug) is required — creates and uses ~/.soksak/projects/<folder>. Home (~) and root (/) are forbidden as root. Duplicate root activates the existing project instead.",
    triggers: { ko: "프로젝트 만들기 새 프로젝트 프로젝트 생성 열기" },
    params: {
      root: { type: "string", description: "Project root directory (absolute path — home/root forbidden)" },
      folder: {
        type: "string",
        description:
          "Required when root is omitted — ^[a-z0-9][a-z0-9-]*$, used as ~/.soksak/projects/<folder>",
      },
      alias: { type: "string", description: "Tab alias (omit = folder name)" },
      program: { ...P.program, description: "Initial view program (omit = global default)" },
      shell: { type: "string", description: "Terminal shell path (omit = global setting → $SHELL)" },
    },
    returns: "{ projectId, contentId, groupId, viewId, paneId?, existing? }",
    errors: ["INVALID_PARAMS"],
    examples: [
      'sok project.create \'{"root":"/Users/me/work","program":"claude"}\'',
      'sok project.create \'{"folder":"my-project"}\'',
    ],
    handler: async (p) => {
      let root = p.root as string | undefined;
      const alias = (p.alias as string) ?? "";
      if (root) {
        // P2: 홈/루트 금지 + 정규화(P5 중복 비교 기준).
        try {
          root = await validateProjectRoot(root);
        } catch (e) {
          return {
            ok: false as const,
            code: "INVALID_PARAMS" as const,
            message: String(e),
          };
        }
      } else {
        const folder = (p.folder as string | undefined)?.trim();
        if (!folder || !FOLDER_NAME_RE.test(folder)) {
          return {
            ok: false as const,
            code: "INVALID_PARAMS" as const,
            message: "root 생략 시 folder 필수(^[a-z0-9][a-z0-9-]*$)",
          };
        }
        root = await ensureDefaultWorkspace(folder);
      }
      // 루트 초기화 정책(git init 등)은 project.created 이벤트 구독 플러그인 소유.
      return S().addProject({
        alias,
        root,
        shell: p.shell as string | undefined,
      });
    },
  });

  register("project.close", {
    danger: "destructive",
    description: "Close a project. Refuses to close the last remaining project.",
    triggers: { ko: "프로젝트 닫기 프로젝트 제거" },
    params: { project: { ...P.project, required: true } },
    returns: "{ activeProjectId }",
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['sok project.close \'{"project":"t2"}\''],
    handler: (p) => S().closeTab(p.project as string),
  });

  register("project.activate", {
    description: "Switch to a different project, making it active.",
    triggers: { ko: "프로젝트 전환 프로젝트 바꾸기 이동" },
    params: { project: { ...P.project, required: true } },
    returns: "{}",
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok project.activate \'{"project":"t2"}\''],
    handler: (p) => S().setActive(p.project as string),
  });

  register("project.rename", {
    description: "Rename a project tab.",
    triggers: { ko: "프로젝트 이름 바꾸기 이름 변경 프로젝트 제목" },
    params: {
      project: { ...P.project, required: true },
      title: { type: "string", description: "New project name", required: true },
    },
    returns: "{}",
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok project.rename \'{"project":"t1","title":"백엔드"}\''],
    handler: (p) => S().renameTab(p.project as string, p.title as string),
  });

  register("project.color", {
    description: "Set the accent color for a project (rail chip and tab highlight). Omit color to remove.",
    triggers: { ko: "프로젝트 색 색상 탭 색깔" },
    params: {
      project: { ...P.project, required: true },
      color: {
        type: "string",
        description: "CSS color (e.g. #4a8fe8). Omit to revert to default.",
      },
    },
    returns: "{}",
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok project.color \'{"project":"t1","color":"#4a8fe8"}\''],
    handler: (p) =>
      S().setProjectColor(p.project as string, (p.color as string) ?? null),
  });

  register("project.update", {
    description:
      "Batch-update project settings. Omitted fields are preserved; \"\" removes the override. root is immutable.",
    params: {
      project: { ...P.project, required: true },
      title: { type: "string", description: "Alias (empty string is ignored)" },
      shell: { type: "string", description: 'Terminal shell path ("" = default)' },
      color: { type: "string", description: 'Accent color ("" = remove)' },
    },
    returns: "{}",
    errors: ["TARGET_NOT_FOUND"],
    examples: [
      'sok project.update \'{"project":"t1","title":"백엔드","program":"claude"}\'',
    ],
    handler: (p) =>
      S().updateProject(p.project as string, {
        title: p.title as string | undefined,
        shell: p.shell === undefined ? undefined : (p.shell as string) || null,
        color: p.color === undefined ? undefined : (p.color as string) || null,
      }),
  });

  register("project.sidebar.toggle", {
    description: "Toggle the file-tree sidebar for a project.",
    triggers: { ko: "사이드바 파일트리 열기 닫기 토글" },
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

  register("project.rightbar.toggle", {
    description: "Toggle the right plugin sidebar (⌥⌘B). Provide open to set state explicitly (idempotent).",
    triggers: { ko: "우측 사이드바 오른쪽 패널 플러그인 바 열기 닫기" },
    params: {
      project: P.project,
      open: { type: "boolean", description: "When provided, force open or closed" },
    },
    returns: "{ rightOpen }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ["sok project.rightbar.toggle", 'sok project.rightbar.toggle \'{"open":true}\''],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      return S().toggleRightSidebar(t.id, p.open as boolean | undefined);
    },
  });

  register("sidebar.right.mode", {
    description:
      "Right sidebar layout mode — overlay (floats over content) or push (occupies area like the left sidebar). Global setting; omit mode to query current.",
    triggers: { ko: "우측 사이드바 밀기 영역차지 오버레이 모드 도킹" },
    params: {
      mode: { type: "string", description: "overlay | push — omit to query current" },
    },
    returns: "{ mode }",
    errors: ["INVALID_PARAMS"],
    examples: ["sok sidebar.right.mode", 'sok sidebar.right.mode \'{"mode":"push"}\''],
    handler: (p) => {
      const s = useSettings.getState();
      if (p.mode !== undefined) {
        if (p.mode !== "overlay" && p.mode !== "push")
          return { ok: false as const, code: "INVALID_PARAMS", message: "mode: overlay | push" };
        s.setRightSidebarMode(p.mode);
        return { mode: p.mode };
      }
      return { mode: s.rightSidebarMode };
    },
  });

  // ----- content -----
  register("content.list", {
    description: "List content tabs in a project.",
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
          active: c.id === t.activeContentId,
        })),
      };
    },
  });

  register("content.create", {
    description: "Create a new content tab. Program priority: explicit > project setting > global setting.",
    triggers: { ko: "새 탭 콘텐츠 탭 추가 새로 열기" },
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
    danger: "destructive",
    description: "Close a content tab. Refuses to close the last remaining content.",
    triggers: { ko: "탭 닫기 컨텐츠 닫기" },
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
    description: "Switch to a specific content tab, making it active.",
    triggers: { ko: "탭 이동 탭 전환 탭 바꾸기" },
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
    description: "Rename a content tab.",
    params: {
      project: P.project,
      content: { ...P.content, required: true },
      title: { type: "string", description: "New name", required: true },
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
    description: "List panels (split panes) in a content area, including their rect (%) and the split tree.",
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
    description:
      "Split a panel — add a new panel beside the target on a given side (optionally running a program). Use when arranging the layout or opening something side by side.",
    triggers: { ko: "패널 나누기 분할 화면 분할 옆에 열기 나란히" },
    params: {
      project: P.project,
      group: P.group,
      side: { ...P.side, required: true },
      program: { ...P.program, default: "terminal" },
    },
    returns: "{ groupId(new panel), viewId, paneId? }",
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
    description: "Merge panels — move all tabs from src into dst; empty src panel is removed automatically.",
    triggers: { ko: "패널 합치기 병합 탭 이동 합병" },
    params: {
      project: P.project,
      src: { type: "string", description: "Source panel id", required: true },
      dst: { type: "string", description: "Destination panel id", required: true },
    },
    returns: "{ groupId(merged panel) }",
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
    description: "Reposition a panel — move the entire src panel to the zone position relative to dst.",
    triggers: { ko: "패널 이동 재배치 위치 옮기기" },
    params: {
      project: P.project,
      src: { type: "string", description: "Source panel id", required: true },
      dst: { type: "string", description: "Destination panel id", required: true },
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
    danger: "destructive",
    description: "Close a panel and all its tabs. Refuses to close the last panel.",
    triggers: { ko: "패널 닫기 패널 제거" },
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
    description: "Focus (activate) a panel, making it the active group.",
    triggers: { ko: "패널 포커스 패널 활성화 선택" },
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
      "Adjust split ratios — provide the splitId (layout.split.id from state.tree) and an array of sizes that sum to 1.",
    triggers: { ko: "패널 크기 조절 비율 분할 조정 크기 바꾸기" },
    params: {
      project: P.project,
      split: { type: "string", description: "Split node id (e.g. s1)", required: true },
      sizes: {
        type: "number[]",
        description: "Child ratios array summing to 1 (e.g. [0.7,0.3])",
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

  register("panel.equalize", {
    description:
      "Equalize split ratios — with index, halves the two areas at that divider (same as double-clicking the divider); without index, distributes all children equally.",
    triggers: { ko: "패널 균등 같은 크기 반반 균등화" },
    params: {
      project: P.project,
      split: { type: "string", description: "Split node id (e.g. s1)", required: true },
      index: {
        type: "number",
        description: "Divider index (0 = first boundary). Omit to equalize all children.",
      },
    },
    returns: "{ sizes }",
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: [
      'sok panel.equalize \'{"split":"s1"}\'',
      'sok panel.equalize \'{"split":"s1","index":0}\'',
    ],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      const node = findSplitNode(t, p.split as string);
      if (!node) return notFound(`분할 없음: ${p.split}`);
      const sizes = [...node.sizes];
      const idx = p.index as number | undefined;
      if (idx === undefined) {
        sizes.fill(1 / sizes.length);
      } else {
        if (idx < 0 || idx >= sizes.length - 1) {
          return {
            ok: false as const,
            code: "INVALID_PARAMS" as const,
            message: `index 범위: 0..${sizes.length - 2}`,
          };
        }
        const half = (sizes[idx] + sizes[idx + 1]) / 2;
        sizes[idx] = half;
        sizes[idx + 1] = half;
      }
      const r = S().resizeSplit(t.id, p.split as string, sizes);
      return r.ok ? { sizes } : r;
    },
  });

  // ----- view(탭) -----
  register("view.list", {
    description: "List the views (tabs) inside a panel.",
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
    description: "Open a new view tab in a panel (terminal / claude / codex / browser with optional url).",
    triggers: { ko: "뷰 열기 탭 추가 claude 열기 터미널 열기 브라우저 탭" },
    params: {
      group: P.group,
      program: { ...P.program, required: true },
      url: { type: "string", description: "Browser start URL (program=browser)" },
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
    danger: "destructive",
    description: "Close a view tab — if it was the last view in a panel, the panel is also removed. Refuses to close the last view in a content area.",
    triggers: { ko: "탭 닫기 뷰 닫기" },
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
    description: "Activate (switch to) a specific view tab.",
    triggers: { ko: "탭 전환 탭 선택 뷰 활성화" },
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

  register("view.maximize", {
    description:
      "Maximize a view to fill the entire content area. The split tree is preserved; only the display is toggled. Same as double-clicking a tab. Omit view to maximize the active view.",
    triggers: { ko: "최대화 전체화면 탭 최대화 크게 보기" },
    params: { view: P.view },
    returns: "{ viewId }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok view.maximize \'{"view":"v3"}\'', "sok view.maximize"],
    handler: (p, ctx) => {
      const loc = p.view ? locateView(p.view as string) : resolveCtx(ctx);
      if (!loc) return notFound(`뷰 없음: ${p.view ?? "(활성)"}`);
      return S().maximizeView(loc.project.id, loc.view.id);
    },
  });

  register("view.restore", {
    description: "Exit view maximize mode and restore the original split layout for the active content.",
    triggers: { ko: "최대화 해제 원래대로 레이아웃 복원" },
    params: { project: P.project },
    returns: "{ viewId(restored view | null = was not maximized) }",
    examples: ["sok view.restore"],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      return S().restoreView(t.id);
    },
  });

  register("view.move", {
    description: "Move a view tab to the zone position of dst panel (center = move into panel; other = split and create new panel).",
    triggers: { ko: "탭 이동 뷰 이동 다른 패널로" },
    params: {
      view: { ...P.view, required: true },
      dst: { type: "string", description: "Destination panel id", required: true },
      zone: { ...P.zone, required: true },
    },
    returns: "{ groupId(moved or created panel) }",
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

  // ----- status(뷰 보고 회신, R8) -----
  register("status.query", {
    description:
      "Query the status each view reports (R8 회신) — what setStatus / file dirty / terminal running pushed. Omit view to list all reporting views.",
    triggers: { ko: "상태 조회 뷰 상태 status 조회 무엇이 도는지" },
    params: { view: P.view },
    returns: "{ statuses: Array<{ viewId, code, message? }> }",
    examples: ["sok status.query", 'sok status.query \'{"view":"v3"}\''],
    handler: (p) => {
      const only = p.view as string | undefined;
      const statuses: { viewId: string; code: string; message?: string }[] = [];
      for (const t of S().tabs)
        for (const c of t.contents)
          for (const g of allGroups(c.layout))
            for (const v of g.views)
              if (v.status && (!only || v.id === only))
                statuses.push({
                  viewId: v.id,
                  code: v.status.code,
                  message: v.status.message,
                });
      return { statuses };
    },
  });

  // ----- pane(터미널 내부 분할) -----
  register("pane.list", {
    description: "List panes inside a terminal view, including the focused pane id.",
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
    description: "Split a terminal pane (row = side by side, col = top and bottom).",
    triggers: { ko: "터미널 분할 pane 나누기 pane 분할" },
    params: {
      pane: P.pane,
      dir: {
        type: "string",
        description: "Split direction",
        enum: ["row", "col"],
        required: true,
      },
    },
    returns: "{ paneId(new pane) }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok pane.split \'{"dir":"row"}\''],
    handler: (p, ctx) => {
      const r = resolvePane(p, ctx);
      if (!r) return notFound("pane 없음");
      return S().splitPane(r.loc.project.id, r.loc.view.id, r.paneId, p.dir as "row" | "col");
    },
  });

  register("pane.close", {
    danger: "destructive",
    description: "Close a terminal pane. Refuses to close the last pane — use view.close instead.",
    triggers: { ko: "pane 닫기 터미널 pane 제거" },
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
    description: "Focus a specific terminal pane.",
    triggers: { ko: "pane 포커스 터미널 pane 선택 활성화" },
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
      "Read terminal screen and scrollback text (TUI shows current screen only). Use to check command output.",
    triggers: { ko: "터미널 읽기 출력 확인 결과 보기" },
    params: {
      pane: P.pane,
      lines: { type: "number", description: "Last N lines only (omit = all)" },
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
    danger: "inject",
    description:
      "Inject raw key input into a terminal (for TUI control). Pass control characters via JSON escapes: \\r=Enter, \\u0003=^C, \\u001b[A=↑.",
    triggers: { ko: "터미널 입력 키 주입 TUI 조작 키 보내기" },
    params: {
      pane: P.pane,
      text: { type: "string", description: "Bytes to inject (escapes allowed)", required: true },
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
    danger: "inject",
    description: "Execute a shell command in the terminal (sends text + Enter). Check output with term.read.",
    triggers: { ko: "명령 실행 터미널 실행 셸 실행 커맨드 실행" },
    params: {
      pane: P.pane,
      cmd: { type: "string", description: "Shell command to run", required: true },
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
    description: "Get the current working directory of a terminal pane (requires shell integration).",
    triggers: { ko: "현재 디렉토리 cwd 작업 폴더 터미널 경로" },
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
    description:
      "Open soksak's own built-in browser view — as a panel tab (where=panel) or a standalone soksak window (where=window). This is ONLY the embedded in-app browser. Do NOT use it when the user names a specific or external browser (Chrome, Safari, Edge, Firefox, an agent browser, etc.) or says 'not the embedded one' — those are separate applications, not this command; launch the OS app instead.",
    triggers: { ko: "내장 브라우저 열기 웹페이지 인앱 브라우저 URL 띄우기" },
    params: {
      url: { type: "string", description: "Start URL (omit = settings homeUrl)" },
      where: {
        type: "string",
        description: "Where to open",
        enum: ["panel", "window"],
        default: "panel",
      },
      group: P.group,
    },
    returns: "panel: { groupId, viewId } / window: {}",
    errors: ["TARGET_NOT_FOUND", "INTERNAL"],
    examples: ['sok browser.open \'{"url":"https://example.com"}\''],
    handler: async (p, ctx) => {
      const url = (p.url as string) ?? browserHome();
      if (p.where === "window") {
        await invoke("browser_open_window", { url });
        return {};
      }
      const loc = resolveGroup(p, ctx);
      if (!loc) return notFound("패널 없음");
      return S().addViewToGroup(loc.project.id, "browser", loc.group.id, { url });
    },
  });

  register("browser.navigate", {
    description: "Navigate the browser view to a URL.",
    triggers: { ko: "URL 이동 페이지 열기 주소 이동 사이트 열기" },
    params: {
      view: P.view,
      url: { type: "string", description: "Target URL", required: true },
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
    description: "Navigate the browser to the previous page in history.",
    triggers: { ko: "뒤로 이전 페이지 브라우저 뒤로가기" },
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
    description: "Navigate the browser to the next page in history.",
    triggers: { ko: "앞으로 다음 페이지 브라우저 앞으로가기" },
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
    description: "Reload the current browser page.",
    triggers: { ko: "새로고침 페이지 리로드 브라우저 새로고침" },
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

  register("browser.devtools", {
    description:
      "Toggle the browser Web Inspector. WKWebView has no CDP so the OS inspector opens in a separate window — same as clicking the toolbar inspect button.",
    triggers: { ko: "개발자 도구 인스펙터 devtools 열기 닫기" },
    params: { view: P.view },
    returns: "{ viewId, open }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ["sok browser.devtools"],
    handler: async (p, ctx) => {
      const b = resolveBrowser(p, ctx);
      if (!b) return notFound("브라우저 뷰 없음");
      const open = await invoke<boolean>("browser_devtools", {
        label: browserLabel(b.view.id),
      });
      return { viewId: b.view.id, open };
    },
  });

  register("browser.list", {
    description:
      "List existing native browser webview labels (b-<viewId>). Should match the store's browser view set — use to detect orphaned webviews.",
    params: {},
    returns: "{ labels: string[] }",
    examples: ["sok browser.list"],
    handler: async () => ({
      labels: await invoke<string[]>("browser_list"),
    }),
  });

  register("browser.eval", {
    danger: "inject",
    description:
      "Execute arbitrary JS in a browser page (async supported; return value is serialized as JSON).",
    triggers: { ko: "JS 실행 자바스크립트 브라우저 실행 페이지 스크립트" },
    params: {
      view: P.view,
      js: {
        type: "string",
        description: "JS body to execute (e.g. return document.title)",
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

  register("browser.media.extract", {
    danger: "inject",
    description:
      "Extract media URLs from a page WITHOUT showing it — opens an offscreen webview, lets the page load (sniffing its own media requests via the core hook), then closes it and returns the hits. Site-agnostic (R3): takes a url only, intercepts whatever the page requests, no decode/branching. Reaches sites the webview can load (e.g. behind network/SNI blocks) but cross-origin fetch/yt-dlp cannot. Symmetric hidden counterpart of browser.media.sniff (visible tab).",
    triggers: { ko: "미디어 추출 숨김 오프스크린 m3u8 스트림 페이지 가로채기 동영상" },
    params: {
      url: { type: "string", description: "Page URL to load offscreen and extract from", required: true },
      timeoutMs: { type: "number", description: "Max wait for a media hit (ms)", default: 15000 },
    },
    returns: "{ urls: [{ url, via, ref }] }",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['sok browser.media.extract \'{"url":"https://example.com/watch","timeoutMs":15000}\''],
    handler: async (p) => {
      if (typeof p.url !== "string" || !p.url) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "url 필요" };
      }
      const urls = await invoke<unknown>("browser_media_extract", {
        url: p.url,
        timeoutMs: typeof p.timeoutMs === "number" ? p.timeoutMs : 15000,
      });
      return { urls: Array.isArray(urls) ? urls : [] };
    },
  });

  register("browser.media.sniff", {
    danger: "inject",
    description:
      "Harvest media URLs (m3u8/mpd/mp4/...) that the page itself requested — captured passively by the core init-script hook (window.__soksakMedia). Site-agnostic: catches whatever the page loads, regardless of obfuscation. Waits up to timeoutMs for at least one hit; with autoplay it calls video.play() to provoke the stream. Use to extract a playable stream from a page the webview can reach (e.g. behind network blocks) but cross-origin fetch/yt-dlp cannot.",
    triggers: { ko: "미디어 스니프 추출 m3u8 스트림 페이지 캡처 가로채기 동영상" },
    params: {
      view: P.view,
      timeoutMs: { type: "number", description: "Max wait for a hit (ms)", default: 8000 },
      autoplay: { type: "boolean", description: "Call video.play() to provoke the stream request", default: true },
      pattern: { type: "string", description: "Only return URLs matching this regex (e.g. m3u8)" },
    },
    returns: "{ viewId, urls: [{ url, via, ref }] }",
    errors: ["TARGET_NOT_FOUND", "INTERNAL"],
    examples: ['sok browser.media.sniff \'{"pattern":"m3u8","timeoutMs":10000}\''],
    handler: async (p, ctx) => {
      const b = resolveBrowser(p, ctx);
      if (!b) return notFound("브라우저 뷰 없음");
      const viewId = b.view.id;
      const timeoutMs = typeof p.timeoutMs === "number" ? p.timeoutMs : 8000;
      const autoplay = p.autoplay !== false;
      const re = p.pattern ? new RegExp(p.pattern as string, "i") : null;
      const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      const deadline = Date.now() + Math.max(500, timeoutMs);
      let triggered = false;
      // 시간 상한 폴링(R10 무한폴링 금지) — hit 나오면 즉시 반환.
      for (;;) {
        const raw = (await evalInBrowser(viewId, "return JSON.stringify(window.__soksakMedia || [])")) as unknown;
        let hits: { url: string; via?: string; ref?: string }[] = [];
        try {
          hits = typeof raw === "string" ? JSON.parse(raw) : (raw as typeof hits);
        } catch {
          hits = [];
        }
        const urls = re ? hits.filter((h) => re.test(h.url)) : hits;
        if (urls.length > 0) return { viewId, urls };
        if (autoplay && !triggered) {
          triggered = true;
          // 페이지 자신의 플레이어를 유발(사이트 무관) — 재생 시 m3u8 을 요청한다.
          await evalInBrowser(
            viewId,
            "try { var v = document.querySelector('video'); if (v) { v.muted = true; v.play && v.play().catch(function(){}); } } catch(e){} return null;",
          );
        }
        if (Date.now() >= deadline) return { viewId, urls: [] };
        await delay(400);
      }
    },
  });

  // ----- browser.dom -----
  register("browser.dom.text", {
    description: "Get the visible text of the page or a specific selector element.",
    params: {
      view: P.view,
      selector: { type: "string", description: "CSS selector (omit = entire body)" },
      maxLength: { type: "number", description: "Max character length", default: 20000 },
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
    description: "Get the HTML of the page or a specific selector element.",
    params: {
      view: P.view,
      selector: { type: "string", description: "CSS selector (omit = entire document)" },
      maxLength: { type: "number", description: "Max character length", default: 50000 },
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
    description: "Summarize matching elements (tag / text / attributes) for a CSS selector — use to understand page structure.",
    params: {
      view: P.view,
      selector: { type: "string", description: "CSS selector", required: true },
      limit: { type: "number", description: "Max element count", default: 20 },
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
    danger: "inject",
    description: "Click the first element matching a CSS selector.",
    triggers: { ko: "클릭 버튼 클릭 링크 클릭 페이지 클릭" },
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
    danger: "inject",
    description: "Fill an input element with a value (fires input/change events — React form compatible).",
    triggers: { ko: "입력 채우기 폼 입력 텍스트 입력 필드 채우기" },
    params: {
      view: P.view,
      selector: { type: "string", description: "CSS selector", required: true },
      text: { type: "string", description: "Value to enter", required: true },
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
    danger: "inject",
    description: "Submit a form (selector can be the form element or any element inside it).",
    triggers: { ko: "폼 제출 submit 전송 양식 제출" },
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
    description: "Wait until a selector appears on the page (dynamic pages — uses MutationObserver).",
    triggers: { ko: "요소 대기 나타날 때까지 기다리기 동적 로딩 대기" },
    params: {
      view: P.view,
      selector: { type: "string", description: "CSS selector", required: true },
      timeoutMs: { type: "number", description: "Max wait time (ms)", default: 5000 },
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
    description: "List saved browser bookmarks.",
    triggers: { ko: "즐겨찾기 목록 북마크 목록" },
    params: {},
    returns: "{ bookmarks: [{url,title}] }",
    examples: ["sok bookmark.list"],
    handler: () => ({ bookmarks: useBookmarks.getState().list }),
  });

  register("bookmark.add", {
    description: "Add a URL to browser bookmarks.",
    triggers: { ko: "즐겨찾기 추가 북마크 추가 저장" },
    params: {
      url: { type: "string", description: "URL", required: true },
      title: { type: "string", description: "Display name (omit = hostname)" },
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
    description: "Remove a URL from browser bookmarks.",
    triggers: { ko: "즐겨찾기 삭제 북마크 제거 삭제" },
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
    description: "Open a file in an editor view. If already open, activates that tab instead.",
    triggers: { ko: "파일 열기 에디터 열기 파일 편집 코드 열기" },
    params: {
      project: P.project,
      path: { type: "string", description: "Absolute file path", required: true },
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

  register("editor.close", {
    description: "Close an editor view (same as view.close).",
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
      "List direct children of a directory (same view as the file tree). Omit path to use the project root (falls back to HOME).",
    triggers: { ko: "파일 목록 디렉토리 목록 폴더 내용 파일 탐색" },
    params: {
      project: P.project,
      path: { type: "string", description: "Absolute directory path" },
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
    description: "Get git change status for a directory (matches file-tree decoration).",
    triggers: { ko: "git 상태 변경 파일 수정됨 git 변경" },
    params: {
      project: P.project,
      path: { type: "string", description: "Git repo directory (omit = project root)" },
    },
    returns: "{ entries: [{path,status}] } — empty list if not a repo",
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
  // splitHeaderMode 는 탭 모드 고정(2026-06 결정)으로 표면에서 제외.
  const SETTING_KEYS = [
    "language",
    "projectTabPosition",
    "shell",
    "homeUrl",
    "fontFamily",
    "fontSize",
    "cursorBlink",
    "cursorStyle",
    "scrollback",
    "resizeReflow",
    "xtermRenderer",
    "iconSet",
    "iconBox",
    "focusIndicator",
  ] as const;

  register("settings.get", {
    description: "Retrieve all application settings.",
    triggers: { ko: "설정 확인 앱 설정 조회 환경설정" },
    params: {},
    returns: `{ ${SETTING_KEYS.join(", ")}, bg }`,
    examples: ["sok settings.get"],
    handler: () => {
      const s = useSettings.getState();
      return {
        language: s.language,
        projectTabPosition: s.projectTabPosition,
        shell: s.shell,
        homeUrl: s.homeUrl,
        fontFamily: s.fontFamily,
        fontSize: s.fontSize,
        cursorBlink: s.cursorBlink,
        cursorStyle: s.cursorStyle,
        scrollback: s.scrollback,
        resizeReflow: s.resizeReflow,
        xtermRenderer: s.xtermRenderer,
        iconSet: s.iconSet,
        iconBox: s.iconBox,
        focusIndicator: s.focusIndicator,
        // 선택 가능한 아이콘 셋 목록(내장 + 활성 플러그인 등록분).
        iconSets: Object.values(useIconRegistry.getState().sets).map((x) => ({
          id: x.id,
          name: x.name,
        })),
        theme: useTheme.getState().current,
        themeMode: useTheme.getState().effectiveMode,
      };
    },
  });

  register("settings.set", {
    description: `Change an application setting. key: ${SETTING_KEYS.join("|")}`,
    triggers: { ko: "설정 변경 설정 바꾸기 환경설정 변경 폰트 크기 언어" },
    params: {
      key: {
        type: "string",
        description: "Setting key",
        enum: SETTING_KEYS,
        required: true,
      },
      value: {
        type: "json",
        description:
          "Value — language:ko|en, projectTabPosition:top|left, fontFamily:string, fontSize:number, cursorBlink:boolean, cursorStyle:block|bar|underline, scrollback:number, resizeReflow:live|settle, xtermRenderer:dom|webgl, iconSet:string (registered set id — unregistered falls back to lucide), iconBox:boolean, focusIndicator:outline|corners",
        required: true,
      },
    },
    returns: "{ key, value }",
    errors: ["INVALID_PARAMS"],
    examples: [
      'sok settings.set \'{"key":"fontSize","value":14}\'',
      'sok settings.set \'{"key":"projectTabPosition","value":"left"}\'',
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
        case "shell":
          if (typeof v !== "string") return bad("string(셸 경로, ''=기본)");
          s.setShell(v);
          break;
        case "homeUrl":
          if (typeof v !== "string") return bad("string(URL)");
          s.setHomeUrl(v);
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
        case "resizeReflow":
          if (v !== "live" && v !== "settle") return bad("live|settle");
          s.setResizeReflow(v);
          break;
        case "xtermRenderer":
          if (v !== "dom" && v !== "webgl") return bad("dom|webgl");
          s.setXtermRenderer(v);
          break;
        case "iconSet":
          if (typeof v !== "string" || !v.trim())
            return bad("string(셋 id — settings.get 의 iconSets 참조)");
          s.setIconSet(v.trim());
          break;
        case "iconBox":
          if (typeof v !== "boolean") return bad("boolean");
          s.setIconBox(v);
          break;
        case "focusIndicator":
          if (v !== "outline" && v !== "corners") return bad("outline|corners");
          s.setFocusIndicator(v);
          break;
      }
      return { key, value: v };
    },
  });

  register("window.info", {
    description: "Get window screen position, size, and scale factor (for automation validation — outerPosition is physical pixels).",
    params: {},
    returns: "{ x, y, w, h, scale }",
    examples: ["sok window.info"],
    handler: async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      const [pos, size, scale] = await Promise.all([
        win.outerPosition(),
        win.outerSize(),
        win.scaleFactor(),
      ]);
      return { x: pos.x, y: pos.y, w: size.width, h: size.height, scale };
    },
  });

  register("window.move", {
    description: "Move the window to a screen position in physical pixels (for automation and multi-monitor validation).",
    params: {
      x: { type: "number", description: "Physical x coordinate", required: true },
      y: { type: "number", description: "Physical y coordinate", required: true },
    },
    returns: "{ x, y }",
    examples: ['sok window.move \'{"x":0,"y":0}\''],
    handler: async (p) => {
      const { getCurrentWindow, PhysicalPosition } = await import(
        "@tauri-apps/api/window"
      );
      await getCurrentWindow().setPosition(
        new PhysicalPosition(p.x as number, p.y as number),
      );
      return { x: p.x, y: p.y };
    },
  });

  register("window.focus", {
    description: "Bring the app window to the front and focus it (clears inactive state for automation).",
    params: {},
    returns: "{ focused: true }",
    examples: ["sok window.focus"],
    handler: async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      // setFocus 는 창을 key 로 만들 뿐 — 앱 전면 전환은 네이티브 자기 활성화로.
      await invoke("window_activate");
      await getCurrentWindow().setFocus();
      return { focused: true };
    },
  });

  register("window.reload", {
    description:
      "Fully reload the app webview (location.reload). Picks up core/plugin code changes during development — including modules HMR misses (e.g. already-activated plugin API surfaces). Active plugins are re-activated automatically after reload (install and consent are persisted).",
    triggers: { ko: "앱 리로드 새로고침 플러그인 재시작 코드 반영" },
    params: {},
    returns: "{ reloaded: true }",
    examples: ["sok window.reload"],
    handler: async () => {
      // 소켓 응답을 먼저 흘려보낸 뒤 다음 틱에 리로드(응답 유실 방지).
      setTimeout(() => window.location.reload(), 30);
      return { reloaded: true };
    },
  });

  // ── 멀티 윈도우 ──────────────────────────────────────────────────────────
  register("window.new", {
    description: "Open a new OS window (independent workspace). Returns the created window label.",
    triggers: { ko: "새 창 창 열기 새 윈도우" },
    params: {},
    returns: "{ label }",
    examples: ["sok window.new"],
    handler: async () => ({ label: await invoke<string>("window_create") }),
  });

  register("window.list", {
    description: "List open window labels. Use to discover targets for commands that accept a window argument.",
    triggers: { ko: "창 목록 윈도우 목록 열린 창" },
    params: {},
    returns: "{ labels }",
    examples: ["sok window.list"],
    handler: async () => ({ labels: await invoke<string[]>("window_list") }),
  });

  register("window.focus", {
    description: "Bring a specific window to the front (focus it).",
    triggers: { ko: "창 포커스 창 활성화 창 앞으로" },
    params: { label: { type: "string", description: "Window label (see window.list)" } },
    returns: "{ ok }",
    examples: ['sok window.focus \'{"label":"win-1"}\''],
    handler: async (p) => {
      await invoke("window_focus", { label: p.label as string });
      return { ok: true };
    },
  });

  register("window.close", {
    description: "Close a specific window.",
    triggers: { ko: "창 닫기 윈도우 닫기" },
    params: { label: { type: "string", description: "Window label" } },
    returns: "{ ok }",
    examples: ['sok window.close \'{"label":"win-1"}\''],
    handler: async (p) => {
      await invoke("window_close", { label: p.label as string });
      return { ok: true };
    },
  });

  register("window.snapshot", {
    description:
      "Capture the window contents to a PNG. Captures even when fully occluded by other apps (occlusion detection is temporarily disabled during capture). Includes WebGL terminal. Parent folder is created automatically.",
    triggers: { ko: "스크린샷 캡처 화면 저장 PNG 저장 스냅샷" },
    params: {
      path: {
        type: "string",
        description: "Output .png path. Omit to use a temp folder.",
      },
    },
    returns: "{ saved }",
    examples: [
      "sok window.snapshot",
      'sok window.snapshot \'{"path":"/tmp/shot.png"}\'',
    ],
    handler: async (p) => {
      let path = p.path as string | undefined;
      if (!path) {
        const { tempDir, join } = await import("@tauri-apps/api/path");
        path = await join(
          await tempDir(),
          "soksak",
          `snapshot-${Date.now()}.png`,
        );
      }
      const saved = await invoke<string>("plugin:webview-capture|snapshot", {
        path,
      });
      return { saved };
    },
  });

  register("window.record", {
    description:
      "Capture the window as a sequence of PNGs (dir/f0000.png ...) for use as a video source. All frames are rendered even when occluded (occlusion detection disabled for the duration). Folder is created automatically.",
    triggers: { ko: "녹화 연속 캡처 프레임 저장 동영상 소스" },
    params: {
      dir: {
        type: "string",
        description: "Output directory for frames",
        required: true,
      },
      frames: { type: "number", description: "Number of frames (default 40, max 600)" },
      intervalMs: { type: "number", description: "Interval between frames in ms (default 40)" },
    },
    returns: "{ dir, frames }",
    examples: [
      'sok window.record \'{"dir":"/tmp/rec"}\'',
      'sok window.record \'{"dir":"/tmp/rec","frames":120,"intervalMs":33}\'',
    ],
    handler: async (p) => {
      const dir = p.dir as string;
      const frames = (p.frames as number | undefined) ?? 40;
      const intervalMs = (p.intervalMs as number | undefined) ?? 40;
      const n = await invoke<number>("plugin:webview-capture|record", {
        dir,
        frames,
        intervalMs,
      });
      return { dir, frames: n };
    },
  });

  register("window.occlusion", {
    description:
      "Toggle occlusion detection. When false, rendering continues even when fully covered by other apps (for continuous background capture — note battery cost). Not needed for normal use; snapshot/record disable it automatically during capture.",
    params: {
      enabled: {
        type: "boolean",
        description: "Occlusion detection on (default) / off",
        required: true,
      },
    },
    returns: "{ occlusion }",
    examples: ['sok window.occlusion \'{"enabled":false}\''],
    handler: async (p) => {
      const enabled = !!p.enabled;
      await invoke("plugin:webview-capture|set_occlusion", { enabled });
      return { occlusion: enabled };
    },
  });

  register("theme.list", {
    description:
      "List available themes (built-in + external ~/.soksak/themes), including files that failed validation and their reasons.",
    triggers: { ko: "테마 목록 테마 보기 사용 가능 테마" },
    params: {},
    returns: "{ current, mode, themes:[{name,defaultMode,modes,source,warnings}], rejected }",
    examples: ["sok theme.list"],
    handler: () => {
      const s = useTheme.getState();
      return {
        current: s.current,
        mode: s.effectiveMode,
        themes: Object.values(s.themes).map((th) => ({
          name: th.name,
          defaultMode: th.defaultMode,
          modes: th.colorsAlt ? ["light", "dark"] : [th.defaultMode],
          source: th.source,
          warnings: s.warnings[th.name] ?? [],
        })),
        rejected: s.rejected,
      };
    },
  });

  register("theme.apply", {
    description: "Apply a theme (replaces all token slots). Omit mode to keep the current mode.",
    triggers: { ko: "테마 적용 테마 바꾸기 다크 모드 라이트 모드 색 테마" },
    params: {
      name: { type: "string", description: "Theme name (see theme.list)", required: true },
      mode: { type: "string", description: "Color mode", enum: ["light", "dark"] },
    },
    returns: "{ name, mode }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok theme.apply \'{"name":"Paper"}\'', 'sok theme.apply \'{"name":"Midnight","mode":"light"}\''],
    handler: (p) => {
      const s = useTheme.getState();
      const ok2 = s.apply(p.name as string, p.mode as "light" | "dark" | undefined);
      if (!ok2) return notFound(`테마 없음: ${p.name}`);
      const cur = useTheme.getState();
      return { name: cur.current, mode: cur.effectiveMode };
    },
  });

  register("theme.reload", {
    description: "Re-scan the external theme directory (~/.soksak/themes) and re-apply the current theme.",
    triggers: { ko: "테마 새로고침 테마 리로드 외부 테마 재스캔" },
    params: {},
    returns: "{ count, rejected }",
    examples: ["sok theme.reload"],
    handler: async () => {
      await useTheme.getState().reload();
      const s = useTheme.getState();
      return { count: Object.keys(s.themes).length, rejected: s.rejected };
    },
  });

  register("theme.install", {
    description: "Install a theme JSON file into ~/.soksak/themes (immediately usable if validation passes).",
    triggers: { ko: "테마 설치 테마 추가 외부 테마 설치" },
    params: {
      path: { type: "string", description: "Absolute path to theme .json file", required: true },
    },
    returns: "{ installed(install path), rejected? }",
    errors: ["INTERNAL"],
    examples: ['sok theme.install \'{"path":"/tmp/dracula.json"}\''],
    handler: async (p) => {
      const installed = await useTheme.getState().install(p.path as string);
      const s = useTheme.getState();
      const reject = s.rejected.find((r) => r.file === installed);
      return reject ? { installed, rejected: reject.errors } : { installed };
    },
  });

  // ----- 분권 카탈로그(파일 분리 — 단일 진실은 동일 registry) -----
  registerGitCatalog();
  registerPluginCatalog();
  registerUiCatalog();
  registerDomCatalog();
  registerDataCatalog();
  registerSecretsCatalog();
  registerTurnCatalog();
  registerNetworkCatalog();
  registerMediaCatalog();
  registerClipboardCatalog();
  registerNotifyCatalog();
  registerScheduleCatalog();
}
