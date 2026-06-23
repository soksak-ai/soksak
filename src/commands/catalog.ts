// 명령 카탈로그 — soksak 전 기능을 command 로 등록한다(단일 진실).
// 타기팅 규칙(모든 명령 공통):
//   - 대상 id 를 명시하면 그 위치(프로젝트 전체에서 검색), 생략하면 호출자 컨텍스트
//     (SOKSAK_PANE → 그 pane 이 속한 뷰/패널/컨텐츠/프로젝트) 또는 활성 체인.
//   - 모든 변이는 결과(새 id/변경 후 상태)를 반환 — 호출자가 응답만으로 검증 가능.

import { invoke } from "@tauri-apps/api/core";
import {
  allGroups,
  useSessions,
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
import { useViewLabels } from "../state/viewLabels";
import { useBookmarks } from "../state/bookmarks";
import { useTheme } from "../state/theme";
import { useIconRegistry } from "../ui/icons/registry";
import { hasPtyObservation } from "../terminal/ptyObservationStore";
import { resolveTermPane } from "./termResolve";
import { computeLayout } from "../components/GroupArea";
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

// paneId = 플러그인 터미널의 view.id(코어 터미널 제거 — 터미널도 플러그인 뷰). 그 뷰의 위치.
function locatePane(paneId: string): Location | null {
  const s = useSessions.getState();
  for (const project of s.tabs) {
    for (const content of project.contents) {
      for (const group of allGroups(content.layout)) {
        for (const view of group.views) {
          if (view.id === paneId) {
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

// term.* 의 컨텍스트 기반 터미널 pane 해석(명시 pane 이 없을 때) — resolveTermPane 에 주입.
// 터미널 = PTY 관찰을 가진 뷰(플러그인 터미널, view.id = paneId). 컨텍스트 pane > 활성 뷰 >
// 같은 컨텐츠의 첫 터미널 뷰 순. substrate 술어(hasPtyObservation)로 generic 판정(코어 락인 0).
function terminalContextPane(
  _params: Record<string, unknown>,
  ctx: CommandContext,
): { paneId: string } | null {
  if (ctx.pane && hasPtyObservation(ctx.pane)) return { paneId: ctx.pane };
  const loc = activeChain();
  if (!loc) return null;
  if (loc.view && hasPtyObservation(loc.view.id)) {
    return { paneId: loc.view.id };
  }
  for (const g of allGroups(loc.content.layout)) {
    for (const v of g.views) {
      if (hasPtyObservation(v.id)) return { paneId: v.id };
    }
  }
  return null;
}

// ── 직렬화(state.tree) ──────────────────────────────────────────────────────

function serializeView(v: View) {
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
  return {
    id: v.id,
    kind: v.kind,
    title: v.title,
    plugin: v.pluginId,
    view: v.view,
  };
}

// 그룹 트리(분할 구조 — splitId/dir/sizes 는 panel.resize 의 대상).
function serializeLayout(node: GroupNode): object {
  if (node.type === "leaf") return { panel: node.value.id };
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
        // 터미널 pane = 플러그인 터미널의 view.id(PTY 관찰을 가진 뷰). 명시 > 컨텍스트 > 활성 뷰.
        paneId:
          (p.pane as string) ??
          ctx.pane ??
          (hasPtyObservation(loc.view.id) ? loc.view.id : undefined),
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

  register("view.label.set", {
    description:
      "Set a custom tab label for a sidebar view (overrides the manifest title). Empty label clears the override (manifest fallback). viewKey = '<pluginId>.<viewId>' from ui.tree (tab/left/<key>).",
    triggers: { ko: "사이드바 탭 이름변경 라벨 뷰 제목 변경" },
    params: {
      view: { type: "string", description: "viewKey '<pluginId>.<viewId>'", required: true },
      label: { type: "string", description: "Custom label; empty to clear", required: true },
    },
    returns: "{ view, label }",
    errors: ["INVALID_PARAMS"],
    examples: [
      'sok view.label.set \'{"view":"soksak-plugin-folderpop.folders","label":"폴더팝"}\'',
    ],
    handler: (p) => {
      const key = p.view as string;
      useViewLabels.getState().setLabel(key, p.label as string);
      return { view: key, label: useViewLabels.getState().labels[key] ?? "" };
    },
  });

  register("view.label.get", {
    description:
      "Get the custom tab label override for a sidebar view (empty = none, caller falls back to manifest title). Omit view to list all overrides.",
    triggers: { ko: "사이드바 탭 라벨 조회 뷰 제목" },
    params: {
      view: { type: "string", description: "viewKey; omit to list all overrides" },
    },
    returns: "{ labels } or { view, label }",
    examples: ["sok view.label.get", 'sok view.label.get \'{"view":"x.y"}\''],
    handler: (p) => {
      const labels = useViewLabels.getState().labels;
      if (p.view !== undefined)
        return { view: p.view, label: labels[p.view as string] ?? "" };
      return { labels };
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

  register("sidebar.left.tree", {
    description:
      "Return the left sidebar layout tree (SplitTree of tab groups) — split ids, sizes, each leaf's viewKeys + active. Source for sidebar.left.move/resize targets.",
    triggers: { ko: "좌측 사이드바 레이아웃 트리 탭 분할 구조" },
    params: { project: P.project },
    returns: "{ projectId, layout }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ["sok sidebar.left.tree"],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      return { projectId: t.id, layout: t.leftLayout };
    },
  });

  register("sidebar.left.move", {
    description:
      "Drag-merge a left sidebar view — into=merge as a tab, left/right=horizontal split, top/bottom=vertical split (same 4 directions as the content area). viewKeys/targets come from sidebar.left.tree.",
    triggers: { ko: "좌측 사이드바 탭 이동 합치기 분할 드래그 머지" },
    params: {
      project: P.project,
      view: { type: "string", description: "viewKey to move", required: true },
      target: { type: "string", description: "target viewKey (a view in the target group)", required: true },
      zone: {
        type: "string",
        description: "into | left | right | top | bottom (4-direction, same as content area)",
        enum: ["into", "left", "right", "top", "bottom"],
        required: true,
      },
    },
    returns: "{}",
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: [
      'sok sidebar.left.move \'{"view":"soksak-plugin-folderpop.folders","target":"soksak-plugin-file-tree.tree","zone":"right"}\'',
    ],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      const zone = p.zone as string;
      const target = p.target as string;
      let drop;
      if (zone === "into") drop = { type: "into" as const, targetKey: target };
      else if (zone === "left" || zone === "right")
        drop = { type: "split" as const, targetKey: target, dir: "row" as const, before: zone === "left" };
      else if (zone === "top" || zone === "bottom")
        drop = { type: "split" as const, targetKey: target, dir: "col" as const, before: zone === "top" };
      else
        return { ok: false as const, code: "INVALID_PARAMS", message: "zone: into | left | right | top | bottom" };
      return S().moveSidebarView(t.id, p.view as string, drop);
    },
  });

  register("sidebar.left.resize", {
    description:
      "Resize a left sidebar split by ratio — sizes parallel to the split's children (sum 1). Split ids from sidebar.left.tree.",
    triggers: { ko: "좌측 사이드바 분할 비율 크기 조절" },
    params: {
      project: P.project,
      split: { type: "string", description: "Sidebar split id", required: true },
      sizes: { type: "number[]", description: "Ratio per child, sum 1", required: true },
    },
    returns: "{}",
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok sidebar.left.resize \'{"split":"s7","sizes":[0.6,0.4]}\''],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      return S().resizeSidebar(t.id, p.split as string, p.sizes as number[]);
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
      // 그룹 활성화만 — 뷰 내부 포커스는 뷰(플러그인 터미널 등)가 마운트/활성 시 스스로 처리.
      return S().setActiveGroup(loc.project.id, p.group as string);
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
    description: "Open a new view tab in a panel by program id (terminal / claude / codex / a plugin view program).",
    triggers: { ko: "뷰 열기 탭 추가 claude 열기 터미널 열기" },
    params: {
      group: P.group,
      program: { ...P.program, required: true },
    },
    returns: "{ groupId, viewId, paneId? }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok view.open \'{"program":"claude"}\''],
    handler: (p, ctx) => {
      const loc = resolveGroup(p, ctx);
      if (!loc) return notFound("패널 없음");
      return S().addViewToGroup(
        loc.project.id,
        p.program as Program,
        loc.group.id,
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
      const r = resolveTermPane(p, ctx, terminalContextPane);
      if (!r) return notFound("pane 없음");
      const text = r.readBuffer(p.lines as number | undefined);
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
      const r = resolveTermPane(p, ctx, terminalContextPane);
      if (!r) return notFound("pane 없음");
      if (!r.sendInput(p.text as string))
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
      const r = resolveTermPane(p, ctx, terminalContextPane);
      if (!r) return notFound("pane 없음");
      if (!r.sendInput(`${p.cmd as string}\r`))
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
      const r = resolveTermPane(p, ctx, terminalContextPane);
      if (!r) return notFound("pane 없음");
      return { paneId: r.paneId, cwd: r.getCwd() ?? null };
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
  // 터미널 외형(shell/font/cursor/scrollback/renderer)은 코어 설정이 아니다 — 터미널
  // 플러그인 설정(manifest configuration)이 소유한다(plugin.<id>.settings.* 로 노출).
  const SETTING_KEYS = [
    "language",
    "projectTabPosition",
    "iconSet",
    "iconBox",
    "focusIndicator",
    "appFontFamily",
    "appFontSize",
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
        iconSet: s.iconSet,
        iconBox: s.iconBox,
        focusIndicator: s.focusIndicator,
        appFontFamily: s.appFontFamily,
        appFontSize: s.appFontSize,
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
          "Value — language:ko|en, projectTabPosition:top|left, iconSet:string (registered set id — unregistered falls back to lucide), iconBox:boolean, focusIndicator:outline|corners, appFontFamily:string (CSS font-family stack), appFontSize:number (6-40)",
        required: true,
      },
    },
    returns: "{ key, value }",
    errors: ["INVALID_PARAMS"],
    examples: [
      'sok settings.set \'{"key":"projectTabPosition","value":"left"}\'',
      'sok settings.set \'{"key":"iconBox","value":true}\'',
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
        case "appFontFamily":
          if (typeof v !== "string" || !v.trim())
            return bad("string(CSS font-family 스택)");
          s.setAppFontFamily(v.trim());
          break;
        case "appFontSize":
          if (typeof v !== "number" || !Number.isFinite(v))
            return bad("number(6~40 클램프)");
          s.setAppFontSize(v);
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
