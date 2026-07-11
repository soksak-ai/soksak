// 명령 카탈로그 — soksak 전 기능을 command 로 등록한다(단일 진실).
// 타기팅 규칙(모든 명령 공통):
//   - 대상 id 를 명시하면 그 위치(프로젝트 전체에서 검색), 생략하면 호출자 컨텍스트
//     (SOKSAK_PANE → 그 pane 이 속한 뷰/패널/스페이스/프로젝트) 또는 활성 체인.
//   - 모든 변이는 결과(새 id/변경 후 상태)를 반환 — 호출자가 응답만으로 검증 가능.

import { invoke } from "@tauri-apps/api/core";
import { tmsg } from "../i18n";
import { suggestLayout, type MonitorFact, type WindowFact } from "../lib/layoutSuggest";
import { listRecentProjects, removeRecentProject } from "../state/recentProjects";
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
import { addProjectClaimed, closeProjectReleased } from "../state/projectRegistry";
import { getRegisteredProgram, listPrograms } from "../plugins/programRegistry";
import {
  activeSessionViewId,
  transferViewFocus,
} from "../plugins/viewFocus";
import { useSettings } from "../state/settings";
import { useViewLabels } from "../state/viewLabels";
import { useBookmarks } from "../state/bookmarks";
import { useTheme } from "../state/theme";
import { useIconRegistry } from "../ui/icons/registry";
import { hasPtyObservation } from "../terminal/ptyObservationStore";
import { resolveTermPane } from "./termResolve";
import { computeLayout } from "../components/GroupArea";
import { catalogJson, register, type CommandContext, type CommandHint } from "./registry";
import { registerFsWatchCatalog } from "./catalogFsWatch";
import { registerPluginCatalog } from "./catalogPlugins";
import { registerDaemonCatalog } from "./catalogDaemon";
import { registerUiCatalog } from "./catalogUi";
import { registerDomCatalog } from "./catalogDom";
import { registerAiSessionCatalog } from "./catalogAiSession";
import { registerDataCatalog } from "./catalogData";
import { registerSecretsCatalog } from "./catalogSecrets";
import { registerTurnCatalog } from "./catalogTurn";
import { registerNetworkCatalog } from "./catalogNetwork";
import { registerMediaCatalog } from "./catalogMedia";
import { registerClipboardCatalog } from "./catalogClipboard";
import { registerNotifyCatalog } from "./catalogNotify";
import { registerScheduleCatalog } from "./catalogSchedule";
import { registerServiceCatalog } from "./catalogService";
import { registerSystemCatalog } from "./catalogSystem";
import { registerWebviewCatalog } from "./catalogWebview";
import {
  ensureDefaultProjectRoot,
  FOLDER_NAME_RE,
  validateProjectRoot,
} from "../lib/projectRoot";

// ── 공통 에러/헬퍼 ───────────────────────────────────────────────────────────

const notFound = (what: string) => ({
  ok: false as const,
  code: "TARGET_NOT_FOUND" as const,
  message: what,
});

// 표면 반환 경계 변환(단일 진실) — store(sessions.ts 등) 내부 필드는 표면이 아니므로 이름을
// 바꾸지 않는다(§ 계약). 핸들러가 store 결과를 그대로 반환하는 지점에서만 이 경계를 지나
// 공개 명칭으로 옮긴다: groupId→panelId, contentId→spaceId, activeGroupId→activePanelId,
// activeContentId→activeSpaceId, contents→spaces. 그 외 키는 그대로 통과(에러 응답도 무해).
function asSurface(r: object): object {
  const rec = r as Record<string, unknown>;
  const { groupId, contentId, activeGroupId, activeContentId, contents, ...rest } = rec;
  const out: Record<string, unknown> = rest;
  if ("groupId" in rec) out.panelId = groupId;
  if ("contentId" in rec) out.spaceId = contentId;
  if ("activeGroupId" in rec) out.activePanelId = activeGroupId;
  if ("activeContentId" in rec) out.activeSpaceId = activeContentId;
  if ("contents" in rec) out.spaces = contents;
  return out;
}

interface Location {
  project: ProjectTab;
  content: ContentArea;
  group: ViewGroup;
  /** 빈 패널(뷰 0개)은 위치로 유효하되 view 만 없다 — view 를 전제하는 소비처는 부재를 처리한다. */
  view?: View;
}

// layout.apply 저작 형태 — 1차 스페이스, 2차 각 스페이스의 패널(분할). 표면 계약(space/panel)과 같은 결.
interface LayoutPanelSpec {
  program: string;
  side?: Side;
}
interface LayoutSpaceSpec {
  title?: string;
  panels?: LayoutPanelSpec[];
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
  // 빈 패널(전부 이동·닫힘)도 유효한 위치다 — 패널 대상 명령(view.open 등)은 계속 동작해야
  // 하므로 여기서 끊지 않고, view 를 전제하는 소비처가 부재를 처리한다(INTERNAL 사망 금지, 실측).
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

// 대상 패널: 명시 id(전 프로젝트 검색) > 컨텍스트 패널.
function resolveGroup(
  params: Record<string, unknown>,
  ctx: CommandContext,
): Location | null {
  const id = params.panel as string | undefined;
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

// 브라우저 계열 프로그램 id 해석(layout.apply dev preset). 프로그램은 전부 플러그인 기여라
// 코어는 브라우저 종류를 모른다(락인 0) — 등록 프로그램 id 관례("browser")로 식별한다. 없으면
// undefined 를 돌려주고, 호출부가 그 패널을 건너뛰며 사유를 남긴다(은폐 금지).
// hint 예시용 실존 프로그램 — 등록 목록에서 터미널 아닌 것을 우선(다양성), 없으면 terminal,
// 그마저 없으면 목록의 첫 항목. 하드코딩 예시는 미설치 환경에서 깨진 안내가 된다(실측: claude).
function exampleProgramId(): string {
  const ids = listPrograms().map((p) => p.decl.id);
  return ids.find((x) => x !== "terminal") ?? ids[0] ?? "terminal";
}

// dev 프리셋의 브라우저 패널 해석 — 관례 프로그램 id "browser"(terminal 과 동일 메커니즘)만 본다.
// substring 매칭 폴백은 두지 않는다: "browser" 를 포함한 임의 id 를 기본 브라우저로 오인할 수 있고
// (엔진 변형·도구 프로그램), terminal 은 그런 폴백 없이 관례 id 하나로 동작한다 — 대칭 유지.
// 미등록이면 undefined — 호출부가 패널을 건너뛰고 사유를 남긴다(은폐 금지).
function findBrowserProgram(): string | undefined {
  return listPrograms().find((p) => p.decl.id === "browser")?.decl.id;
}

// ── 직렬화(state.tree) ──────────────────────────────────────────────────────

function serializeView(v: View) {
  if (v.kind === "file") {
    return {
      id: v.id,
      kind: v.kind,
      title: v.title,
      customLabel: v.customLabel,
      path: v.path,
      mode: v.mode,
      dirty: v.status?.code === "dirty",
    };
  }
  return {
    id: v.id,
    kind: v.kind,
    title: v.title,
    customLabel: v.customLabel,
    icon: v.icon,
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
    activePanelId: c.activeGroupId,
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
      activeSpaceId: t.activeContentId,
      spaces: t.contents.map((c) => serializeContent(c, t.activeContentId)),
    })),
  };
}

// ── 파라미터 조각(재사용) ────────────────────────────────────────────────────

const P = {
  project: {
    type: "string",
    description: "Target project id (omit = caller's context project)",
  },
  space: { type: "string", description: "Target space tab id" },
  panel: {
    type: "string",
    description: "Target panel id (omit = caller's context panel)",
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
      "Full layout snapshot (address book): all ids and active state across project → space → panel (rect %) → view → pane. Use to discover ids before targeting other commands.",
    params: {},
    returns: "{ activeProjectId, projects[] } — panels[].rect is % of the content area",
    message: (d) => tmsg("msg.state.tree", { n: ((d.projects as unknown[]) ?? []).length }),
    examples: ["sok state.tree"],
    handler: () => serializeTree(),
  });

  register("state.commands", {
    description: "Full command catalog with parameter schemas, returns, errors, and examples — the source of truth for all available commands.",
    params: {},
    returns: "{ commands: [{name,description,params,returns,errors,examples}] }",
    message: (d) => tmsg("msg.state.commands", { n: ((d.commands as unknown[]) ?? []).length }),
    examples: ["sok commands"],
    handler: () => ({ commands: catalogJson() }),
  });

  register("state.context", {
    description:
      "Resolve the caller's position: project/space/panel/view that $SOKSAK_PANE belongs to (falls back to active chain when called outside a terminal).",
    params: { pane: P.pane },
    returns: "{ projectId, spaceId, panelId, viewId?, paneId? } — viewId is absent when the panel is empty",
    message: (d) =>
      d.viewId
        ? tmsg("msg.state.context", { view: String(d.viewId) })
        : tmsg("msg.state.context.emptyPanel", { panel: String(d.panelId) }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["sok state.context"],
    handler: (p, ctx) => {
      const loc = p.pane
        ? locatePane(p.pane as string)
        : resolveCtx(ctx);
      if (!loc) return notFound("컨텍스트를 해석할 수 없음");
      return asSurface({
        projectId: loc.project.id,
        contentId: loc.content.id,
        groupId: loc.group.id,
        // 빈 패널이면 viewId 없이 패널까지의 위치를 답한다 — 빈 패널 위치도 위치다.
        viewId: loc.view?.id,
        // 터미널 pane = 플러그인 터미널의 view.id(PTY 관찰을 가진 뷰). 명시 > 컨텍스트 > 활성 뷰.
        paneId:
          (p.pane as string) ??
          ctx.pane ??
          (loc.view && hasPtyObservation(loc.view.id) ? loc.view.id : undefined),
      });
    },
  });

  // ----- project -----
  register("project.list", {
    description: "List all projects with id, title, root path, and active state.",
    triggers: { ko: "프로젝트 목록 프로젝트 리스트 열린 프로젝트" },
    params: {},
    returns: "{ projects: [{id,title,root,active}] }",
    message: (d) => tmsg("msg.project.list", { n: ((d.projects as unknown[]) ?? []).length }),
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

  register("project.recent", {
    description:
      "List recent projects (the cross-window recents feeding the control-plane project map and the project rail): root, alias, last-opened timestamp. Same list from any window (core kv).",
    triggers: { ko: "최근 프로젝트 목록 최근 연 프로젝트 픽커 레일" },
    params: {},
    returns: "{ recents: [{root, alias, lastOpenedAt}] }",
    message: (d) => tmsg("msg.project.recent", { n: ((d.recents as unknown[]) ?? []).length }),
    examples: ["sok project.recent"],
    handler: async () => ({ recents: await listRecentProjects() }),
  });

  register("project.recent.remove", {
    description:
      "Remove a project from the recents list (project map/rail). Does not touch the project on disk — only the recents entry. Idempotent (missing root is a no-op).",
    triggers: { ko: "최근 프로젝트 제거 최근 목록에서 지우기 잊기" },
    params: {
      root: { type: "string", description: "Project root to forget", required: true },
    },
    returns: "{ ok }",
    message: () => tmsg("msg.project.recent.remove"),
    examples: ['sok project.recent.remove \'{"root":"/Users/me/old"}\''],
    handler: async (p) => {
      await removeRecentProject(p.root as string);
      return {};
    },
  });

  register("project.open", {
    description:
      "Open a project (creates it if it doesn't exist yet). When root is omitted, folder (slug) is required — creates and uses ~/.soksak/projects/<folder>. Home (~) and root (/) are forbidden as root. Duplicate root activates the existing project instead.",
    triggers: { ko: "프로젝트 만들기 새 프로젝트 프로젝트 생성 열기" },
    params: {
      root: { type: "string", description: "Project root directory (absolute path — home/root forbidden)" },
      folder: {
        type: "string",
        description:
          "Required when root is omitted — ^[a-z0-9][a-z0-9-]*$, used as ~/.soksak/projects/<folder>",
      },
      alias: { type: "string", description: "Tab alias (omit = folder name)" },
      program: { ...P.program, description: "Initial view program (omit = empty space tab)" },
      shell: { type: "string", description: "Terminal shell path (omit = global setting → $SHELL)" },
    },
    returns:
      "{ projectId, spaceId, panelId, viewId, paneId?, existing? } | { existingWindow } (already open in another window — focused instead) | { routedWindow } (called on the control-plane window — opened in a new project window instead)",
    message: (d) =>
      d.routedWindow
        ? tmsg("msg.project.open.routed", { window: String(d.routedWindow) })
        : d.existingWindow
          ? tmsg("msg.project.open.existingWindow")
          : d.existing
            ? tmsg("msg.project.open.existing")
            : tmsg("msg.project.open.created"),
    errors: ["INVALID_PARAMS"],
    hint: (d) => {
      // 실패는 표준 안내에 맡긴다(창 필드 없이 code 만 도착).
      if (d.code) return [];
      // 제어판이 새 워크스페이스 창으로 라우팅했다 — 그 창에서 이어가는 수를 제시한다.
      const routed = d.routedWindow as string | undefined;
      if (routed) {
        return [
          { cmd: `sok --window ${routed} state.tree`, why: tmsg("hint.flow.project.open.routedContinue") },
          { cmd: `sok --window ${routed} layout.apply dev`, why: tmsg("hint.flow.project.open.routedLayout") },
        ];
      }
      // 이미 다른 창에 열려 있어 그 창을 앞으로 가져왔다 — 그 창에서 이어간다.
      const existingWin = d.existingWindow as string | undefined;
      if (existingWin) {
        return [
          { cmd: `sok --window ${existingWin} state.tree`, why: tmsg("hint.flow.project.open.existingWindow") },
        ];
      }
      // 이 창에서 열렸다 — 화면을 꾸미는 다음 수들을 제시한다(가능성의 제시, 3개 상한).
      return [
        { cmd: "sok layout.apply dev", why: tmsg("hint.flow.project.open.layout") },
        { cmd: "sok window.maximize", why: tmsg("hint.flow.project.open.maximize") },
        { cmd: "sok space.create", why: tmsg("hint.flow.project.open.space") },
      ];
    },
    examples: [
      'sok project.open \'{"root":"/Users/me/work","program":"claude"}\'',
      'sok project.open \'{"folder":"my-project"}\'',
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
        root = await ensureDefaultProjectRoot(folder);
      }
      // 루트 초기화 정책(git init 등)은 project.created 이벤트 구독 플러그인 소유.
      // P6(전역 단일 오픈) 게이트 경유 — 다른 창 소유면 그 창 포커스 + existingWindow 반환.
      return asSurface(
        await addProjectClaimed({
          alias,
          root,
          shell: p.shell as string | undefined,
          program: p.program as Program | undefined,
        }),
      );
    },
  });

  register("project.close", {
    danger: "destructive",
    description: "Close a project. Refuses to close the last remaining project.",
    triggers: { ko: "프로젝트 닫기 프로젝트 제거" },
    params: { project: { ...P.project, required: true } },
    returns: "{ activeProjectId }",
    message: () => tmsg("msg.project.close"),
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['sok project.close \'{"project":"t2"}\''],
    // P6: 닫기 성공 시 전역 점유 해제(다른 창이 이 프로젝트를 열 수 있게).
    handler: (p) => closeProjectReleased(p.project as string),
  });

  register("project.activate", {
    description: "Switch to a different project, making it active.",
    triggers: { ko: "프로젝트 전환 프로젝트 바꾸기 이동" },
    params: { project: { ...P.project, required: true } },
    returns: "{}",
    message: () => tmsg("msg.project.activate"),
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
    message: () => tmsg("msg.project.rename"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok project.rename \'{"project":"t1","title":"백엔드"}\''],
    handler: (p) => S().renameProject(p.project as string, p.title as string),
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
    message: () => tmsg("msg.project.color"),
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
    message: () => tmsg("msg.project.update"),
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
    message: (d) =>
      d.sidebarOpen
        ? tmsg("msg.project.sidebar.toggle.opened")
        : tmsg("msg.project.sidebar.toggle.closed"),
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
    message: (d) =>
      d.rightOpen
        ? tmsg("msg.project.rightbar.toggle.opened")
        : tmsg("msg.project.rightbar.toggle.closed"),
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
    message: (d) =>
      d.label
        ? tmsg("msg.view.label.set.set", { label: String(d.label) })
        : tmsg("msg.view.label.set.cleared"),
    errors: ["INVALID_PARAMS"],
    examples: [
      'sok view.label.set \'{"view":"soksak-plugin-<id>.<view>","label":"내 라벨"}\'',
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
    message: (d) =>
      d.labels
        ? tmsg("msg.view.label.get.all", {
            n: Object.keys((d.labels as Record<string, unknown>) ?? {}).length,
          })
        : tmsg("msg.view.label.get.one", { label: String(d.label ?? "") }),
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
    message: (d) => tmsg("msg.sidebar.right.mode", { mode: String(d.mode) }),
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
    message: () => tmsg("msg.sidebar.left.tree"),
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
    message: () => tmsg("msg.sidebar.left.move"),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: [
      'sok sidebar.left.move \'{"view":"soksak-plugin-<id>.<view>","target":"soksak-plugin-<other-id>.<view>","zone":"right"}\'',
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
    message: () => tmsg("msg.sidebar.left.resize"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok sidebar.left.resize \'{"split":"s7","sizes":[0.6,0.4]}\''],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      return S().resizeSidebar(t.id, p.split as string, p.sizes as number[]);
    },
  });

  // ----- space -----
  register("space.list", {
    description: "List space tabs in a project.",
    params: { project: P.project },
    returns: "{ spaces: [{id,title,program,active}] }",
    message: (d) => tmsg("msg.space.list", { n: ((d.spaces as unknown[]) ?? []).length }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["sok space.list"],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      return asSurface({
        contents: t.contents.map((c) => ({
          id: c.id,
          title: c.title,
          active: c.id === t.activeContentId,
        })),
      });
    },
  });

  register("space.create", {
    description: "Create a new space tab. Program priority: explicit > project setting > global setting.",
    triggers: { ko: "새 탭 스페이스 탭 추가 새로 열기" },
    params: { project: P.project, program: P.program },
    returns: "{ spaceId, panelId, viewId, paneId? }",
    message: () => tmsg("msg.space.create"),
    errors: ["TARGET_NOT_FOUND"],
    hint: (d) => {
      // 새 스페이스는 활성 스페이스가 되므로 후속 수는 컨텍스트를 그대로 겨냥한다(대상 id 불요).
      if (d.code) return [];
      return [
        { cmd: "sok panel.split right", why: tmsg("hint.flow.space.create.split") },
        { cmd: `sok view.open ${exampleProgramId()}`, why: tmsg("hint.flow.space.create.view") },
        { cmd: "sok window.snapshot", why: tmsg("hint.flow.space.create.snapshot") },
      ];
    },
    examples: ['sok space.create \'{"program":"browser"}\''],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      return asSurface(S().addContent(t.id, p.program as Program | undefined));
    },
  });

  register("space.close", {
    danger: "destructive",
    description: "Close a space tab. Refuses to close the last remaining space.",
    triggers: { ko: "탭 닫기 스페이스 닫기" },
    params: {
      project: P.project,
      space: { ...P.space, required: true },
    },
    returns: "{ activeSpaceId }",
    message: () => tmsg("msg.space.close"),
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['sok space.close \'{"space":"c2"}\''],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      return asSurface(S().closeContent(t.id, p.space as string));
    },
  });

  register("space.activate", {
    description: "Switch to a specific space tab, making it active.",
    triggers: { ko: "탭 이동 탭 전환 탭 바꾸기" },
    params: {
      project: P.project,
      space: { ...P.space, required: true },
    },
    returns: "{}",
    message: () => tmsg("msg.space.activate"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok space.activate \'{"space":"c2"}\''],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      return S().setActiveContent(t.id, p.space as string);
    },
  });

  register("space.switchScan", {
    description:
      "Measure a space-tab switch as the user sees it: record the switch and report whether the new space lands in a single clean frame or smears across several (jank), via per-frame pixel change in the content area. Detects same-color switches that brightness can't. Restores the original tab. Replaces ad-hoc capture scripts.",
    triggers: { ko: "탭 전환 측정 깜빡임 jank 스페이스 전환 검사 단일프레임" },
    params: {
      project: P.project,
      to: { ...P.space, required: true },
      from: {
        type: "string",
        description: "Space id to start on (default: current active)",
      },
      frames: { type: "number", description: "Frames to capture (default 30)" },
      intervalMs: { type: "number", description: "Frame interval ms (default 16)" },
      applyAtMs: {
        type: "number",
        description: "Delay after recording starts before switching (default 250)",
      },
      settleMs: {
        type: "number",
        description: "Settle wait on the start space (default 600)",
      },
      region: {
        type: "json",
        description:
          "Content area fractional rect {x0,y0,x1,y1} (0..1). Default covers the main content pane.",
      },
      threshold: {
        type: "number",
        description:
          "Noise floor (changed-pixel fraction) below which no switch is reported (default 0.003). Detection above the floor is peak-relative, so it adapts to the switch's magnitude.",
      },
    },
    returns:
      "{ frames, frameMs, switchFrame, switchFrames (consecutive changed = jank spread), clean, diffsPct }",
    message: (d) =>
      d.clean
        ? tmsg("msg.space.switchScan.clean")
        : tmsg("msg.space.switchScan.jank", { n: Number(d.switchFrames) }),
    examples: [
      'sok space.switchScan \'{"from":"c1","to":"c3"}\'',
      'sok space.switchScan \'{"to":"c3","frames":40}\'',
    ],
    handler: async (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const prev = t.activeContentId;
      const to = p.to as string;
      const from = (p.from as string | undefined) ?? prev;
      const frames = (p.frames as number | undefined) ?? 30;
      const intervalMs = (p.intervalMs as number | undefined) ?? 16;
      const applyAtMs = (p.applyAtMs as number | undefined) ?? 250;
      const settleMs = (p.settleMs as number | undefined) ?? 600;
      const region =
        (p.region as { x0: number; y0: number; x1: number; y1: number }) ?? {
          // 좌측 사이드바·상단 크롬 제외한 본문 영역(탭 전환이 바뀌는 곳).
          x0: 0.23,
          y0: 0.1,
          x1: 0.99,
          y1: 0.96,
        };

      const { tempDir, join } = await import("@tauri-apps/api/path");
      const dir = await join(await tempDir(), "soksak", `switchscan-${Date.now()}`);

      // 1) 시작 스페이스로 + settle.
      S().setActiveContent(t.id, from);
      await sleep(settleMs);
      // 2) 녹화 시작(비대기) → applyAtMs 후 대상 스페이스로 전환 → 완료 대기.
      const recT0 = performance.now();
      const recP = invoke<number>("plugin:webview-capture|record", {
        dir,
        frames,
        intervalMs,
      });
      await sleep(applyAtMs);
      S().setActiveContent(t.id, to);
      const n = await recP;
      const realFrameMs = n > 0 ? (performance.now() - recT0) / n : intervalMs;
      // 3) 프레임간 픽셀 변화율 → 전환 프레임 탐지.
      const grid = await invoke<number[][]>(
        "plugin:webview-capture|analyze_frame_diffs",
        { dir, regions: [region] },
      );
      // 4) 원래 스페이스 복원.
      S().setActiveContent(t.id, prev);

      const diffs = grid.map((r) => r[0] ?? 0);
      // 자기적응 감지 — 전환 변화량은 스페이스 쌍마다 다르다(비슷한 두 터미널=0.5%, 터미널↔에디터=수%).
      // 고정 임계값은 작은 전환을 놓치므로, peak 의 40% 이상인 프레임을 전환으로 본다(단 floor 미만이면
      // 노이즈로 보고 전환 없음). 깨끗 = 그런 프레임이 정확히 1개(연속/복수면 번짐=jank). floor 조절 가능.
      const peak = diffs.length ? Math.max(...diffs) : 0;
      const floor = (p.threshold as number | undefined) ?? 0.003;
      let switchFrame = -1;
      let switchFrames = 0;
      if (peak >= floor) {
        const hi = Math.max(floor, peak * 0.4);
        for (let f = 0; f < diffs.length; f++) {
          if (diffs[f] >= hi) {
            if (switchFrame < 0) switchFrame = f;
            switchFrames++;
          }
        }
      }
      return {
        frames: n,
        frameMs: Math.round(realFrameMs),
        switchFrame,
        switchFrames,
        clean: switchFrame >= 0 && switchFrames <= 1,
        diffsPct: diffs.map((d) => +(d * 100).toFixed(1)),
      };
    },
  });

  register("space.rename", {
    description: "Rename a space tab.",
    params: {
      project: P.project,
      space: { ...P.space, required: true },
      title: { type: "string", description: "New name", required: true },
    },
    returns: "{}",
    message: () => tmsg("msg.space.rename"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok space.rename \'{"space":"c1","title":"빌드"}\''],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      return S().renameContent(t.id, p.space as string, p.title as string);
    },
  });

  // ----- panel -----
  register("panel.list", {
    description: "List panels (split panes) in a space, including their rect (%) and the split tree.",
    params: { project: P.project, space: P.space },
    returns: "{ activePanelId, layout, panels[] }",
    message: (d) => tmsg("msg.panel.list", { n: ((d.panels as unknown[]) ?? []).length }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["sok panel.list"],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      const c = p.space
        ? t.contents.find((x) => x.id === p.space)
        : (resolveCtx(ctx)?.content ??
          t.contents.find((x) => x.id === t.activeContentId));
      if (!c) return notFound(`스페이스 없음: ${p.space}`);
      const out = serializeContent(c, t.activeContentId);
      return {
        activePanelId: out.activePanelId,
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
      panel: P.panel,
      side: { ...P.side, required: true },
      program: { ...P.program, default: "terminal" },
    },
    returns: "{ panelId(new panel), viewId, paneId? }",
    message: () => tmsg("msg.panel.split"),
    errors: ["TARGET_NOT_FOUND"],
    hint: (d) => {
      if (d.code) return [];
      const out: CommandHint[] = [];
      const panel = d.panelId as string | undefined;
      // 새로 생긴 패널에 다른 프로그램을 탭으로 더 열 수 있다 — 그 패널을 명시 겨냥한다.
      if (panel)
        out.push({
          cmd: `sok view.open '{"panel":"${panel}","program":"${exampleProgramId()}"}'`,
          why: tmsg("hint.flow.panel.split.view"),
        });
      out.push({ cmd: "sok window.snapshot", why: tmsg("hint.flow.panel.split.snapshot") });
      return out;
    },
    examples: ['sok panel.split \'{"side":"right"}\'', 'sok panel.split \'{"side":"bottom","program":"browser"}\''],
    handler: (p, ctx) => {
      const loc = resolveGroup(p, ctx);
      if (!loc) return notFound("대상 패널 없음");
      return asSurface(
        S().splitWithNewView(
          loc.project.id,
          loc.group.id,
          p.side as Side,
          p.program as Program,
        ),
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
    returns: "{ panelId(merged panel) }",
    message: () => tmsg("msg.panel.merge"),
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['sok panel.merge \'{"src":"g2","dst":"g1"}\''],
    handler: (p, ctx) => {
      const loc = locateGroup(p.src as string) ?? resolveGroup(p, ctx);
      if (!loc) return notFound(`패널 없음: ${p.src}`);
      return asSurface(
        S().moveGroupToGroup(
          loc.project.id,
          p.src as string,
          p.dst as string,
          "center",
        ),
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
    returns: "{ panelId }",
    message: () => tmsg("msg.panel.move"),
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['sok panel.move \'{"src":"g2","dst":"g1","zone":"left"}\''],
    handler: (p) => {
      const loc = locateGroup(p.src as string);
      if (!loc) return notFound(`패널 없음: ${p.src}`);
      return asSurface(
        S().moveGroupToGroup(
          loc.project.id,
          p.src as string,
          p.dst as string,
          p.zone as DropZone,
        ),
      );
    },
  });

  register("panel.close", {
    danger: "destructive",
    description: "Close a panel and all its tabs. Refuses to close the last panel.",
    triggers: { ko: "패널 닫기 패널 제거" },
    params: { panel: { ...P.panel, required: true } },
    returns: "{ activePanelId }",
    message: () => tmsg("msg.panel.close"),
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['sok panel.close \'{"panel":"g2"}\''],
    handler: (p) => {
      const loc = locateGroup(p.panel as string);
      if (!loc) return notFound(`패널 없음: ${p.panel}`);
      return asSurface(S().closeGroup(loc.project.id, p.panel as string));
    },
  });

  register("panel.focus", {
    description: "Focus (activate) a panel, making it the active group.",
    triggers: { ko: "패널 포커스 패널 활성화 선택" },
    params: { panel: { ...P.panel, required: true } },
    returns: "{}",
    message: () => tmsg("msg.panel.focus"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok panel.focus \'{"panel":"g2"}\''],
    handler: (p) => {
      const loc = locateGroup(p.panel as string);
      if (!loc) return notFound(`패널 없음: ${p.panel}`);
      if (!loc.group.activeViewId)
        return S().setActiveGroup(loc.project.id, p.panel as string);
      return transferViewFocus(
        activeSessionViewId(),
        loc.group.activeViewId,
        () => S().setActiveGroup(loc.project.id, p.panel as string),
      );
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
    message: () => tmsg("msg.panel.resize"),
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
    message: () => tmsg("msg.panel.equalize"),
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

  register("layout.apply", {
    description:
      "Apply a layout by building fresh spaces — never destroys existing spaces. Hierarchy: first-level spaces are independent switchable screens; second-level panels are the splits inside each space. preset dev = a terminal plus a browser side by side (if no browser program is installed, that panel is skipped and reported in skipped). preset facets = build the named spaces you pass in (spaces required). Verify by switching to a space with space.activate, then capturing with window.snapshot.",
    triggers: { ko: "화면 구성 레이아웃 적용 스페이스 배치 개발 화면 나란히 배치 dev facets" },
    params: {
      preset: {
        type: "string",
        enum: ["dev", "facets"],
        required: true,
        description:
          "dev = a terminal plus a browser side by side; facets = build the named spaces passed in spaces",
      },
      spaces: {
        type: "json",
        description:
          "Named spaces to build (required for facets): [{ title, panels?: [{ program, side? }] }]",
      },
      project: P.project,
    },
    returns:
      "{ spaces: [{ spaceId, title, panels: [{ panelId, program }] }], skipped? } — skipped lists panels dropped because their program is missing",
    message: (d) => tmsg("msg.layout.apply", { n: ((d.spaces as unknown[]) ?? []).length }),
    errors: ["INVALID_PARAMS", "TARGET_NOT_FOUND"],
    hint: (d) => {
      if (d.code) return [];
      const out: CommandHint[] = [];
      const spaces = (d.spaces as { spaceId?: string }[] | undefined) ?? [];
      const skipped = (d.skipped as unknown[] | undefined) ?? [];
      // 건너뛴 패널이 있으면(브라우저 미설치 등) 설치 경로를 먼저 제시한다.
      if (skipped.length)
        out.push({ cmd: "sok plugin.catalog", why: tmsg("hint.flow.layout.apply.install") });
      const first = spaces[0]?.spaceId;
      if (first)
        out.push({ cmd: `sok space.activate ${first}`, why: tmsg("hint.flow.layout.apply.activate") });
      out.push({ cmd: "sok window.snapshot", why: tmsg("hint.flow.layout.apply.snapshot") });
      return out;
    },
    examples: [
      "sok layout.apply dev",
      'sok layout.apply \'{"preset":"facets","spaces":[{"title":"docs","panels":[{"program":"browser"}]}]}\'',
    ],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      const skipped: {
        space: string;
        program: string;
        side?: Side;
        reason: string;
      }[] = [];
      let spaceSpecs: LayoutSpaceSpec[];
      if (p.preset === "dev") {
        // dev 축약 — 터미널 + 브라우저(우측). 브라우저 미설치면 그 패널만 건너뛰고 사유를 남긴다.
        const browserId = findBrowserProgram();
        const panels: LayoutPanelSpec[] = [{ program: "terminal" }];
        if (browserId) panels.push({ program: browserId, side: "right" });
        else
          skipped.push({
            space: "dev",
            program: "browser",
            side: "right",
            reason: tmsg("layout.skip.noBrowser"),
          });
        spaceSpecs = [{ title: "dev", panels }];
      } else {
        // facets — spaces 인자를 그대로 쓰는 별칭. spaces 필수.
        const raw = p.spaces;
        if (!Array.isArray(raw) || raw.length === 0) {
          return {
            ok: false as const,
            code: "INVALID_PARAMS" as const,
            message: "preset=facets 는 spaces 필요([{title,panels}])",
          };
        }
        spaceSpecs = raw as LayoutSpaceSpec[];
      }
      const builtSpaces: {
        spaceId: string;
        title: string;
        panels: { panelId: string; program: string }[];
      }[] = [];
      for (const spec of spaceSpecs) {
        const title = typeof spec.title === "string" ? spec.title : "";
        // 새 스페이스(빈 스페이스) — 첫 패널을 명시 제어하려 program 없이 만든다. 기존 스페이스는 불변.
        const created = S().addContent(t.id);
        if (!created.ok) continue; // 프로젝트 확인 이후이므로 도달 불가(방어)
        const spaceId = created.contentId;
        const firstPanelId = created.groupId;
        if (title) S().renameContent(t.id, spaceId, title);
        const builtPanels: { panelId: string; program: string }[] = [];
        let firstFilled = false;
        for (const panel of spec.panels ?? []) {
          const program = panel.program;
          if (typeof program !== "string" || !getRegisteredProgram(program)) {
            skipped.push({
              space: title || spaceId,
              program: String(program),
              side: panel.side,
              reason: tmsg("layout.skip.unregistered", { program: String(program) }),
            });
            continue;
          }
          if (!firstFilled) {
            // 첫 패널 = 스페이스의 초기(빈) 그룹에 뷰를 넣는다.
            S().addViewToGroup(t.id, program, firstPanelId);
            builtPanels.push({ panelId: firstPanelId, program });
            firstFilled = true;
          } else {
            // 이후 패널 = 첫 그룹 옆에 분할 생성.
            const r = S().splitWithNewView(t.id, firstPanelId, panel.side ?? "right", program);
            if (r.ok) builtPanels.push({ panelId: r.groupId, program });
          }
        }
        builtSpaces.push({ spaceId, title, panels: builtPanels });
      }
      return skipped.length ? { spaces: builtSpaces, skipped } : { spaces: builtSpaces };
    },
  });

  // ----- view(탭) -----
  register("view.list", {
    description: "List the views (tabs) inside a panel.",
    params: { panel: P.panel },
    returns: "{ panelId, activeViewId, views[] }",
    message: (d) => tmsg("msg.view.list", { n: ((d.views as unknown[]) ?? []).length }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["sok view.list"],
    handler: (p, ctx) => {
      const loc = resolveGroup(p, ctx);
      if (!loc) return notFound("패널 없음");
      return asSurface({
        groupId: loc.group.id,
        activeViewId: loc.group.activeViewId,
        views: loc.group.views.map(serializeView),
      });
    },
  });

  register("view.open", {
    description: "Open a new view tab in a panel by program id (terminal / claude / codex / a plugin view program).",
    triggers: { ko: "뷰 열기 탭 추가 claude 열기 터미널 열기" },
    params: {
      panel: P.panel,
      program: { ...P.program, required: true },
    },
    returns: "{ panelId, viewId, paneId? }",
    message: () => tmsg("msg.view.open"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok view.open \'{"program":"claude"}\''],
    handler: (p, ctx) => {
      const loc = resolveGroup(p, ctx);
      if (!loc) return notFound("패널 없음");
      return asSurface(
        S().addViewToGroup(
          loc.project.id,
          p.program as Program,
          loc.group.id,
        ),
      );
    },
  });

  register("view.close", {
    danger: "destructive",
    description: "Close a view tab — if it was the last view in a panel, the panel is also removed. Refuses to close the last view in a space.",
    triggers: { ko: "탭 닫기 뷰 닫기" },
    params: { view: { ...P.view, required: true } },
    returns: "{ activePanelId, activeViewId }",
    message: () => tmsg("msg.view.close"),
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['sok view.close \'{"view":"v3"}\''],
    handler: (p) => {
      const loc = locateView(p.view as string);
      if (!loc) return notFound(`뷰 없음: ${p.view}`);
      return asSurface(S().closeView(loc.project.id, p.view as string));
    },
  });

  register("view.activate", {
    description: "Activate (switch to) a specific view tab.",
    triggers: { ko: "탭 전환 탭 선택 뷰 활성화" },
    params: { view: { ...P.view, required: true } },
    returns: "{}",
    message: () => tmsg("msg.view.activate"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok view.activate \'{"view":"v3"}\''],
    handler: (p) => {
      const loc = locateView(p.view as string);
      if (!loc) return notFound(`뷰 없음: ${p.view}`);
      return transferViewFocus(
        activeSessionViewId(),
        p.view as string,
        () => S().setActiveView(loc.project.id, p.view as string),
      );
    },
  });

  register("view.rename", {
    description:
      "Set a custom label for a view tab (grid tab). Overrides the dynamic content title (e.g. a browser page <title> keeps updating underneath; the override wins on display). Empty title clears the override and the dynamic title returns. Sidebar views use view.label.set instead.",
    triggers: { ko: "탭 이름변경 탭명 변경 뷰 이름 바꾸기 라벨" },
    params: {
      view: { ...P.view, required: true },
      title: { type: "string", description: "Custom label; empty to clear the override", required: true },
    },
    returns: "{ label }",
    message: (d) =>
      d.label ? tmsg("msg.view.rename.set", { label: String(d.label) }) : tmsg("msg.view.rename.cleared"),
    errors: ["TARGET_NOT_FOUND"],
    examples: [
      'sok view.rename \'{"view":"v3","title":"작업 브라우저"}\'',
      'sok view.rename \'{"view":"v3","title":""}\'',
    ],
    handler: (p) => {
      const loc = locateView(p.view as string);
      if (!loc) return notFound(`뷰 없음: ${p.view}`);
      return S().renameView(loc.project.id, p.view as string, p.title as string);
    },
  });

  register("view.maximize", {
    description:
      "Maximize a view to fill the entire space. The split tree is preserved; only the display is toggled. Same as double-clicking a tab. Omit view to maximize the active view.",
    triggers: { ko: "최대화 전체화면 탭 최대화 크게 보기" },
    params: { view: P.view },
    returns: "{ viewId }",
    message: () => tmsg("msg.view.maximize"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok view.maximize \'{"view":"v3"}\'', "sok view.maximize"],
    handler: (p, ctx) => {
      const loc = p.view ? locateView(p.view as string) : resolveCtx(ctx);
      if (!loc?.view) return notFound(`뷰 없음: ${p.view ?? "(활성)"}`);
      return S().maximizeView(loc.project.id, loc.view.id);
    },
  });

  register("view.restore", {
    description: "Exit view maximize mode and restore the original split layout for the active space.",
    triggers: { ko: "최대화 해제 원래대로 레이아웃 복원" },
    params: { project: P.project },
    returns: "{ viewId(restored view | null = was not maximized) }",
    message: (d) =>
      d.viewId ? tmsg("msg.view.restore.restored") : tmsg("msg.view.restore.none"),
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
    returns: "{ panelId(moved or created panel) }",
    message: () => tmsg("msg.view.move"),
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['sok view.move \'{"view":"v3","dst":"g1","zone":"right"}\''],
    handler: (p) => {
      const loc = locateView(p.view as string);
      if (!loc) return notFound(`뷰 없음: ${p.view}`);
      return asSurface(
        S().moveViewToGroup(
          loc.project.id,
          p.view as string,
          p.dst as string,
          p.zone as DropZone,
        ),
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
    message: (d) => tmsg("msg.status.query", { n: ((d.statuses as unknown[]) ?? []).length }),
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
    message: (d) => tmsg("msg.term.read", { n: String(d.text ?? "").length }),
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
    message: () => tmsg("msg.term.send"),
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
    description:
      "Execute a shell command in a terminal (sends the text plus Enter). Returns immediately — it does not wait for the command to finish, so read the output a moment later with term.read.",
    triggers: { ko: "명령 실행 터미널 실행 셸 실행 커맨드 실행" },
    params: {
      pane: P.pane,
      cmd: { type: "string", description: "Shell command to run", required: true },
    },
    returns: "{ paneId }",
    message: () => tmsg("msg.term.exec"),
    errors: ["TARGET_NOT_FOUND"],
    hint: (d) => {
      if (d.code) return [];
      // 실행은 즉시 돌아온다 — 출력은 잠시 후 그 pane 을 읽어 확인한다.
      const pane = d.paneId as string | undefined;
      return [
        {
          cmd: pane ? `sok term.read '{"pane":"${pane}"}'` : "sok term.read",
          why: tmsg("hint.flow.term.exec.read"),
        },
      ];
    },
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
    message: (d) =>
      d.cwd ? tmsg("msg.term.cwd.path", { path: String(d.cwd) }) : tmsg("msg.term.cwd.none"),
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
    message: (d) => tmsg("msg.bookmark.list", { n: ((d.bookmarks as unknown[]) ?? []).length }),
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
    message: () => tmsg("msg.bookmark.add"),
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
    message: () => tmsg("msg.bookmark.remove"),
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
    returns: "{ viewId, panelId, existing }",
    message: (d) =>
      d.existing ? tmsg("msg.editor.open.existing") : tmsg("msg.editor.open.opened"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok editor.open \'{"path":"/Users/me/work/src/main.rs"}\''],
    handler: (p, ctx) => {
      const t = resolveProject(p, ctx);
      if (!t) return notFound("프로젝트 없음");
      return asSurface(S().openFileView(t.id, p.path as string));
    },
  });

  register("editor.close", {
    description: "Close an editor view (same as view.close).",
    params: { view: { ...P.view, required: true } },
    returns: "{ activePanelId, activeViewId }",
    message: () => tmsg("msg.editor.close"),
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['sok editor.close \'{"view":"v4"}\''],
    handler: (p) => {
      const loc = locateView(p.view as string);
      if (!loc) return notFound(`뷰 없음: ${p.view}`);
      return asSurface(S().closeView(loc.project.id, p.view as string));
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
    message: (d) => tmsg("msg.explorer.list", { n: ((d.children as unknown[]) ?? []).length }),
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
    "orchestratorAgent",
    "orchestratorModel",
  ] as const;

  register("settings.get", {
    description: "Retrieve all application settings.",
    triggers: { ko: "설정 확인 앱 설정 조회 환경설정" },
    params: {},
    returns: `{ ${SETTING_KEYS.join(", ")}, bg }`,
    message: () => tmsg("msg.settings.get"),
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
        orchestratorAgent: s.orchestratorAgent,
        orchestratorModel: s.orchestratorModel,
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
          "Value — language:ko|en, projectTabPosition:top|left, iconSet:string (registered set id — unregistered falls back to lucide), iconBox:boolean, focusIndicator:outline|corners, appFontFamily:string (CSS font-family stack), appFontSize:number (6-40), orchestratorAgent:string (agent CLI command or path the natural-language console spawns), orchestratorModel:string (--model alias for the agent; empty = CLI default)",
        required: true,
      },
    },
    returns: "{ key, value }",
    message: (d) => tmsg("msg.settings.set", { key: String(d.key) }),
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
        case "orchestratorAgent":
          if (typeof v !== "string" || !v.trim())
            return bad("string(에이전트 CLI 명령 또는 경로)");
          s.setOrchestratorAgent(v.trim());
          break;
        case "orchestratorModel":
          if (typeof v !== "string") return bad('string(모델 별칭 — "" = CLI 기본)');
          s.setOrchestratorModel(v.trim());
          break;
      }
      return { key, value: v };
    },
  });

  register("window.info", {
    description: "Get window screen position, size, and scale factor (for automation validation — outerPosition is physical pixels).",
    params: {},
    returns: "{ x, y, w, h, scale }",
    message: (d) => tmsg("msg.window.info", { w: Number(d.w), h: Number(d.h) }),
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
    message: (d) => tmsg("msg.window.move", { x: Number(d.x), y: Number(d.y) }),
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

  register("window.resize", {
    description: "Resize the window to a physical pixel size (for automation and resize-path E2E — drives the native window resize, the same path as edge-drag, which panel.resize does not exercise).",
    params: {
      w: { type: "number", description: "Physical width", required: true },
      h: { type: "number", description: "Physical height", required: true },
    },
    returns: "{ w, h }",
    message: (d) => tmsg("msg.window.resize", { w: Number(d.w), h: Number(d.h) }),
    examples: ['sok window.resize \'{"w":1200,"h":800}\''],
    handler: async (p) => {
      const { getCurrentWindow, PhysicalSize } = await import(
        "@tauri-apps/api/window"
      );
      await getCurrentWindow().setSize(
        new PhysicalSize(p.w as number, p.h as number),
      );
      return { w: p.w, h: p.h };
    },
  });

  register("window.focus", {
    description:
      "Bring a window to the front and focus it. Without label, focuses the window this command runs in (clears inactive state for automation); with label, focuses that window (see window.list).",
    triggers: { ko: "창 포커스 창 활성화 창 앞으로" },
    params: {
      label: { type: "string", description: "Window label (omit = this window)" },
    },
    returns: "{ focused: true }",
    message: () => tmsg("msg.window.focus"),
    examples: ["sok window.focus", 'sok window.focus \'{"label":"w-<uuid>"}\''],
    handler: async (p) => {
      if (p.label) {
        await invoke("window_focus", { label: p.label as string });
        return { focused: true };
      }
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      // setFocus 는 창을 key 로 만들 뿐 — 앱 전면 전환은 네이티브 자기 활성화로.
      await invoke("window_activate");
      await getCurrentWindow().setFocus();
      return { focused: true };
    },
  });

  register("window.maximize", {
    description:
      "Maximize a window to fill the screen (native window maximize — distinct from view.maximize, which only enlarges one view within a space). Without label, targets the window this command runs in; with label, targets that window (see window.list). Pass off:true to restore (unmaximize).",
    triggers: { ko: "창 최대화 전체화면 창 키우기 최대화 해제" },
    params: {
      label: { type: "string", description: "Window label (omit = this window)" },
      off: { type: "boolean", description: "Restore (unmaximize) instead of maximizing" },
    },
    returns: "{ maximized: boolean }",
    message: (d) =>
      d.maximized ? tmsg("msg.window.maximize") : tmsg("msg.window.maximize.off"),
    errors: ["TARGET_NOT_FOUND"],
    examples: [
      "sok window.maximize",
      'sok window.maximize \'{"off":true}\'',
      'sok window.maximize \'{"label":"w-<uuid>"}\'',
    ],
    handler: async (p) => {
      const off = p.off === true;
      const { getCurrentWindow, Window } = await import("@tauri-apps/api/window");
      const win = p.label
        ? await Window.getByLabel(p.label as string)
        : getCurrentWindow();
      if (!win) return notFound(`창 없음: ${p.label}`);
      if (off) await win.unmaximize();
      else await win.maximize();
      return { maximized: !off };
    },
  });

  register("window.reload", {
    description:
      "Fully reload the app webview (location.reload). Picks up core/plugin code changes during development — including modules HMR misses (e.g. already-activated plugin API surfaces). Active plugins are re-activated automatically after reload (install and consent are persisted).",
    triggers: { ko: "앱 리로드 새로고침 플러그인 재시작 코드 반영" },
    params: {},
    returns: "{ reloaded: true }",
    message: () => tmsg("msg.window.reload"),
    examples: ["sok window.reload"],
    handler: async () => {
      // 소켓 응답을 먼저 흘려보낸 뒤 다음 틱에 리로드(응답 유실 방지).
      setTimeout(() => window.location.reload(), 30);
      return { reloaded: true };
    },
  });

  // ── 멀티 윈도우 ──────────────────────────────────────────────────────────
  register("window.open", {
    description:
      "Open a new project window for a project root (P6: if the root is already open in some window, no window is created — that window is focused and returned as existingWindow). root is required unless mode orchestrator, which brings the control plane (main) forward instead — opening and creating projects live there; empty project windows do not exist.",
    triggers: { ko: "새 창 창 열기 새 윈도우 프로젝트 새 창 오케스트레이터 창" },
    params: {
      root: {
        type: "string",
        description: "Project root to open in the new window (absolute path).",
      },
      alias: {
        type: "string",
        description: "Display alias for the project tab (defaults to the folder name).",
      },
      shell: {
        type: "string",
        description: "Shell binary for the project's terminals (defaults to the user shell).",
      },
      mode: {
        type: "string",
        description:
          "orchestrator = bring the control plane (main) forward. Mutually exclusive with root.",
        enum: ["orchestrator"],
      },
    },
    returns: "{ label } | { existingWindow } (root already open — focused instead)",
    message: (d) =>
      d.existingWindow ? tmsg("msg.window.open.existing") : tmsg("msg.window.open.created"),
    errors: ["INVALID_PARAMS"],
    hint: (d) => {
      if (d.code) return [];
      // 새 창의 라벨을 겨냥해 명령을 보내는 법을 제시한다(--window <label>).
      const label = (d.label as string | undefined) ?? (d.existingWindow as string | undefined);
      if (!label) return [];
      return [
        {
          cmd: `sok --window ${label} state.tree`,
          why: tmsg("hint.flow.window.open.target", { label }),
        },
      ];
    },
    examples: [
      'sok window.open \'{"root":"/Users/me/work"}\'',
      'sok window.open \'{"mode":"orchestrator"}\'',
    ],
    handler: async (p) => {
      if (p.mode === "orchestrator") {
        if (p.root) {
          return {
            ok: false as const,
            code: "INVALID_PARAMS" as const,
            message: "mode=orchestrator 는 root 와 함께 쓸 수 없음",
          };
        }
        // 컨트롤 플레인은 main 하나뿐(NAMING 4b 예약어) — 있으면 앞으로, 사용자가 닫았으면
        // 같은 예약 라벨로 재개설한다(부트가 라벨로 분기하므로 init 불요).
        const labels = await invoke<string[]>("window_list");
        if (labels.includes("main")) {
          await invoke("window_focus", { label: "main" }).catch(() => {});
          return { existingWindow: "main" };
        }
        await invoke("window_create", { label: "main" });
        return { label: "main" };
      }
      // 빈 워크스페이스 창은 없다 — 프로젝트 열기·생성은 컨트롤 플레인(main)의 표면이다.
      if (!p.root) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: "root 필요 — 프로젝트 열기·생성은 오케스트레이터(main)에서",
        };
      }
      let root: string;
      try {
        root = await validateProjectRoot(p.root as string);
      } catch (e) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: String(e),
        };
      }
      // P6 선검사: 이미 열려 있으면 창을 만들지 않고 소유 창 포커스(중복 창 0).
      // 검사↔생성 사이 레이스는 새 창 부트의 claim 이 최종 시행(실패 시 빈 상태로 열화).
      const owners = await invoke<{ owners: { root: string; window: string }[] }>(
        "project_owners",
      );
      const owner = owners.owners.find((o) => o.root === root)?.window;
      if (owner) {
        await invoke("window_focus", { label: owner }).catch(() => {});
        return { existingWindow: owner };
      }
      let init = `root=${encodeURIComponent(root)}`;
      if (typeof p.alias === "string" && p.alias) init += `&alias=${encodeURIComponent(p.alias)}`;
      if (typeof p.shell === "string" && p.shell) init += `&shell=${encodeURIComponent(p.shell)}`;
      return { label: await invoke<string>("window_create", { init }) };
    },
  });

  register("window.list", {
    description: "List open window labels. Use to discover targets for commands that accept a window argument.",
    triggers: { ko: "창 목록 윈도우 목록 열린 창" },
    params: {},
    returns: "{ labels }",
    message: (d) => tmsg("msg.window.list", { n: ((d.labels as unknown[]) ?? []).length }),
    examples: ["sok window.list"],
    handler: async () => ({ labels: await invoke<string[]>("window_list") }),
  });

  register("window.projects", {
    description:
      "Map open windows to the project each one hosts (root path + name + window label). The meaning layer over window.list — use it first to pick the right window before targeting commands with --window. Same answer from any window (process-wide registry).",
    triggers: { ko: "창 프로젝트 매핑 어느 창 프로젝트 열림 창별 프로젝트" },
    params: {},
    returns: "{ projects: [{ root, name, window }] }",
    message: (d) => tmsg("msg.window.projects", { n: ((d.projects as unknown[]) ?? []).length }),
    examples: ["sok window.projects"],
    handler: async () => {
      const owners = await invoke<{ owners: { root: string; window: string }[] }>(
        "project_owners",
      );
      const projects = owners.owners.map((o) => ({
        root: o.root,
        name: o.root.split("/").filter(Boolean).pop() ?? o.root,
        window: o.window,
      }));
      return { projects };
    },
  });

  register("window.close", {
    description: "Close a specific window.",
    triggers: { ko: "창 닫기 윈도우 닫기" },
    params: { label: { type: "string", description: "Window label" } },
    returns: "{ ok }",
    message: () => tmsg("msg.window.close"),
    examples: ['sok window.close \'{"label":"w-<uuid>"}\''],
    handler: async (p) => {
      await invoke("window_close", { label: p.label as string });
      return { ok: true };
    },
  });

  register("window.snapshot", {
    description:
      "Capture the window contents to a PNG. Captures even when fully occluded by other apps (occlusion detection is temporarily disabled during capture). Includes WebGL terminal. Parent folder is created automatically. Pass base64:true to get the PNG inline instead of a file; rect (CSS px, window coords — same space as ui.measure) crops to a region and implies base64.",
    triggers: { ko: "스크린샷 캡처 화면 저장 PNG 저장 스냅샷 부분 영역" },
    params: {
      path: {
        type: "string",
        description: "Output .png path (file mode). Omit to use a temp folder.",
      },
      base64: {
        type: "boolean",
        description: "Return the PNG as base64 instead of writing a file",
      },
      rect: {
        type: "json",
        description:
          "Crop region {x,y,w,h} in CSS px, window coordinates (ui.measure space). Implies base64 mode.",
      },
    },
    returns:
      "{ saved, media:{kind,path} } (file mode) | { media:{kind:'image/png',base64} } (base64/rect mode)",
    message: (d) =>
      d.saved
        ? tmsg("msg.window.snapshot.saved", { path: String(d.saved) })
        : tmsg("msg.window.snapshot.captured"),
    // 귀의 문장(§3) — 경로는 message(눈)에만. 실패는 message(진단) 에코.
    speak: (out) => (out.ok ? (out.data?.saved ? "화면을 저장했어요." : "화면을 캡처했어요.") : out.message),
    hint: (d) => {
      if (d.code) return [];
      // 재캡처의 두 갈래 — 뷰 최대화로 확대해 담거나, 다른 스페이스로 전환해 화면을 비교한다.
      return [
        { cmd: "sok view.maximize", why: tmsg("hint.flow.snapshot.maximize") },
        { cmd: "sok space.list", why: tmsg("hint.flow.snapshot.switch") },
      ];
    },
    errors: ["INVALID_PARAMS"],
    examples: [
      "sok window.snapshot",
      'sok window.snapshot \'{"path":"/tmp/shot.png"}\'',
      'sok window.snapshot \'{"rect":{"x":100,"y":80,"w":400,"h":300},"base64":true}\'',
    ],
    handler: async (p) => {
      const rect = p.rect as
        | { x: number; y: number; w: number; h: number }
        | undefined;
      if (rect || p.base64) {
        if (
          rect &&
          (typeof rect.x !== "number" ||
            typeof rect.y !== "number" ||
            typeof rect.w !== "number" ||
            typeof rect.h !== "number")
        ) {
          return {
            ok: false as const,
            code: "INVALID_PARAMS" as const,
            message: "rect 는 {x,y,w,h} 숫자 필수",
          };
        }
        const pngBase64 = await invoke<string>(
          "plugin:webview-capture|snapshot_region",
          rect ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h } : {},
        );
        // 이미지는 봉투 media 로 선언(표준) — 소비자는 키 추측 없이 media 만 렌더한다.
        return { media: { kind: "image/png", base64: pngBase64 } };
      }
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
      // 파일 캡처도 media 로 선언 — 피드가 경로를 읽어 이미지로 렌더한다(경로 텍스트만 보이지 않게).
      return { saved, media: { kind: "image/png", path: saved } };
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
    message: (d) => tmsg("msg.window.record", { n: Number(d.frames) }),
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
    message: (d) =>
      d.occlusion ? tmsg("msg.window.occlusion.on") : tmsg("msg.window.occlusion.off"),
    examples: ['sok window.occlusion \'{"enabled":false}\''],
    handler: async (p) => {
      const enabled = !!p.enabled;
      await invoke("plugin:webview-capture|set_occlusion", { enabled });
      return { occlusion: enabled };
    },
  });

  register("window.layers", {
    description:
      "Dump the window's native view hierarchy (class / frame / hidden, indented text). Ground truth for layer diagnostics — verify a native child webview's actual bounds and z-order against the DOM slot (e.g. divider-drag freeze, hole-punch mismatch).",
    triggers: {
      ko: "네이티브 뷰 계층 레이어 덤프 child 위치 진단",
    },
    params: {},
    returns: "{ hierarchy } — indented text, one view per line",
    message: () => tmsg("msg.window.layers"),
    examples: ["sok window.layers"],
    handler: async () => {
      const hierarchy = await invoke<string>("webview_debug_hierarchy");
      return { hierarchy };
    },
  });

  register("window.monitors", {
    description:
      "Monitor and window placement facts (physical px): every monitor's rect/scale/name and every window's rect, focus state, and owning monitor index. Facts only — placement strategy is layout.suggest, execution is window.place (same coordinate space).",
    triggers: {
      ko: "모니터 목록 해상도 창 배치 현황 듀얼 모니터 파악",
    },
    params: {},
    returns:
      "{ monitors: [{index,name,x,y,w,h,scale}], windows: [{label,title,x,y,w,h,focused,monitor}] }",
    message: (d) =>
      tmsg("msg.window.monitors", {
        n: ((d.monitors as unknown[]) ?? []).length,
        m: ((d.windows as unknown[]) ?? []).length,
      }),
    examples: ["sok window.monitors"],
    handler: async () => {
      return (await invoke("window_monitors")) as object;
    },
  });

  register("window.place", {
    description:
      "Place a window at an exact frame (physical px — the window.monitors coordinate space). Position and size applied once. Use layout.suggest output directly. The OS may clamp frames into the usable area (e.g. below the macOS menu bar) — read back window.monitors for the settled frame.",
    triggers: {
      ko: "창 배치 이동 모니터로 옮기기 위치 지정",
    },
    params: {
      label: { type: "string", description: "Window label (window.list)", required: true },
      x: { type: "number", description: "Left edge (physical px)", required: true },
      y: { type: "number", description: "Top edge (physical px)", required: true },
      w: { type: "number", description: "Width (physical px)", required: true },
      h: { type: "number", description: "Height (physical px)", required: true },
    },
    returns: "{ ok }",
    message: () => tmsg("msg.window.place"),
    examples: ['sok window.place \'{"label":"main","x":2560,"y":0,"w":2560,"h":1440}\''],
    handler: async (p) => {
      await invoke("window_place", {
        label: p.label,
        x: p.x,
        y: p.y,
        w: p.w,
        h: p.h,
      });
      return {};
    },
  });

  register("layout.suggest", {
    description:
      "Suggest window placements from current monitor/window facts (pure strategy — nothing moves). strategy spread: orchestrator windows take a monitor free of project windows whole (or the right third alongside on a single monitor); project windows fill their own monitor. strategy grid: tile all windows on the first monitor. Feed each placement to window.place to execute.",
    triggers: {
      ko: "창 배치 제안 전략 모니터 분배 오케스트레이터 배치",
    },
    params: {
      strategy: {
        type: "string",
        description: "Placement strategy",
        enum: ["spread", "grid"],
        default: "spread",
      },
      roles: {
        type: "json",
        description:
          'Optional label→role map, e.g. {"main":"orchestrator"} — unlisted windows count as project windows',
      },
    },
    returns: "{ placements: [{label,monitor,x,y,w,h}] }",
    message: (d) => tmsg("msg.layout.suggest", { n: ((d.placements as unknown[]) ?? []).length }),
    examples: [
      'sok layout.suggest \'{"strategy":"spread","roles":{"main":"orchestrator"}}\'',
    ],
    handler: async (p) => {
      const facts = (await invoke("window_monitors")) as {
        monitors: MonitorFact[];
        windows: WindowFact[];
      };
      const placements = suggestLayout({
        monitors: facts.monitors,
        windows: facts.windows,
        strategy: (p.strategy as "spread" | "grid") ?? "spread",
        roles: (p.roles as Record<string, "orchestrator" | "project">) ?? undefined,
      });
      return { placements };
    },
  });

  register("activity.recent", {
    description:
      "Query the app-wide activity stream (P12 execution visibility): registry command executions (command/source/danger/duration/outcome — param keys only, no values), terminal command start/finish, AI turn ends, view activations. Cursor with since (exclusive seq) to fetch only new entries; entries carry monotonic seq + epoch-ms ts. Same answer from any window (process-wide singleton hub).",
    triggers: {
      ko: "활동 피드 실행 기록 최근 명령 스트림 조회 오케스트레이터",
    },
    params: {
      since: {
        type: "number",
        description: "Return entries with seq greater than this (backfill cursor). Omit for latest.",
      },
      limit: {
        type: "number",
        description: "Maximum entries to return (default 200)",
        default: 200,
      },
    },
    returns: "{ entries: [{ seq, ts, kind, source, payload }] }",
    message: (d) => tmsg("msg.activity.recent", { n: ((d.entries as unknown[]) ?? []).length }),
    examples: [
      'sok activity.recent \'{"limit":20}\'',
      'sok activity.recent \'{"since":1234}\'',
    ],
    // §5 R2: 조회도 사실이다 — 기록된다(선형 증가일 뿐 되먹임 아님. 낭독 루프는 tts 축이
    // 차단). 컴포넌트 자기 백필은 호출측이 origin:"internal" 로 선언(노출만 낮아짐).
    handler: async (p) => {
      const entries = await invoke("activity_recent", {
        since: p.since ?? null,
        limit: p.limit ?? 200,
      });
      return { entries };
    },
  });

  register("window.themeScan", {
    description:
      "Measure whether a dark/light theme transition is atomic across screen regions. Records the toggle, then reports each region's transition frame and how many frames they are out of sync (a torn frame is chrome already switched while content has not). Idempotent — replaces ad-hoc capture scripts. Restores the original theme when done.",
    triggers: {
      ko: "테마 전환 검사 원자성 깜빡임 tear 측정 다크 라이트 토글 회귀",
    },
    params: {
      theme: {
        type: "string",
        description: "Theme name to scan (default: current theme)",
      },
      from: {
        type: "string",
        description: "Starting mode (default dark)",
        enum: ["light", "dark"],
      },
      to: {
        type: "string",
        description: "Ending mode (default light)",
        enum: ["light", "dark"],
      },
      frames: { type: "number", description: "Frames to capture (default 40)" },
      intervalMs: {
        type: "number",
        description: "Frame interval in ms (default 16 ≈ one display frame)",
      },
      applyAtMs: {
        type: "number",
        description: "Delay after recording starts before toggling (default 250)",
      },
      settleMs: {
        type: "number",
        description: "Settle wait after setting the start mode (default 800)",
      },
      skipCapture: {
        type: "boolean",
        description:
          "Measure latency only (applyJsMs, applyReflowMs) and skip frame capture — fast, robust even when the window is backgrounded. For A/B latency tuning.",
      },
      regions: {
        type: "json",
        description:
          "Named fractional rects {name:{x0,y0,x1,y1}} (0..1). Default samples chrome top bar, center content, and left sidebar.",
      },
    },
    returns:
      "{ frames, frameMs (measured capture interval), spreadFrames, spreadMs, atomic, regions:[{name,start,end,transitionFrame}] }",
    message: (d) =>
      d.atomic !== undefined
        ? d.atomic
          ? tmsg("msg.window.themeScan.atomic")
          : tmsg("msg.window.themeScan.torn", { n: Number(d.spreadFrames) })
        : tmsg("msg.window.themeScan"),
    examples: [
      "sok window.themeScan",
      'sok window.themeScan \'{"theme":"Midnight","frames":48}\'',
    ],
    handler: async (p) => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const ts = useTheme.getState();
      const theme = (p.theme as string | undefined) ?? ts.current;
      const startMode = (p.from as "light" | "dark" | undefined) ?? "dark";
      const endMode = (p.to as "light" | "dark" | undefined) ?? "light";
      // 기본값은 RPC 10s 안에 여유로 들어오게 보수적으로(네이티브 캡처가 프레임당 ~55ms 로
      // intervalMs 보다 느리고 가끔 stall — 전환은 3~5프레임이라 20프레임이면 충분).
      const frames = (p.frames as number | undefined) ?? 20;
      const intervalMs = (p.intervalMs as number | undefined) ?? 16;
      const applyAtMs = (p.applyAtMs as number | undefined) ?? 180;
      const settleMs = (p.settleMs as number | undefined) ?? 600;
      const regionMap =
        (p.regions as Record<
          string,
          { x0: number; y0: number; x1: number; y1: number }
        >) ?? {
          // 크롬 상단바 / 중앙 콘텐츠(에디터·터미널) / 좌측 사이드바 — tear 를 드러내는 세 구역.
          top: { x0: 0.3, y0: 0.0, x1: 0.95, y1: 0.06 },
          center: { x0: 0.45, y0: 0.15, x1: 0.95, y1: 0.85 },
          left: { x0: 0.02, y0: 0.2, x1: 0.22, y1: 0.85 },
        };
      const names = Object.keys(regionMap);
      const regionList = names.map((n) => regionMap[n]);

      // 원래 테마/모드 — 검사 후 복원(부수효과 없는 멱등 호출).
      const prevTheme = ts.current;
      const prevMode = ts.effectiveMode;

      let stage = "start";
      try {
        stage = "path";
        const { tempDir, join } = await import("@tauri-apps/api/path");
        const dir = await join(
          await tempDir(),
          "soksak",
          `themescan-${Date.now()}`,
        );

        // 1) 시작 모드로 세팅 + settle.
        stage = "applyStart";
        useTheme.getState().apply(theme, startMode);
        await sleep(settleMs);
        // 1b) clean 지연 측정(캡처 전, 동시 캡처가 rAF 를 느리게 해 오염되지 않게). rAF 대신 강제
        // reflow(offsetHeight)로 동기 style recalc+layout 을 잰다 — 백그라운드 창에서도 견고
        // (paint/composite 는 제외되나 recalc+layout 이 테마 변경의 주 비용). applyJsMs=동기 JS
        // (플러그인 theme.changed 핸들러), applyReflowMs=그 위에 recalc+layout 까지.
        stage = "measurePaint";
        const applyT0 = performance.now();
        useTheme.getState().apply(theme, endMode);
        const applyJsMs = performance.now() - applyT0;
        void document.documentElement.offsetHeight;
        const applyReflowMs = performance.now() - applyT0;
        // skipCapture: 캡처 없이 지연만 — 빠르고 견고(가려진 창·헤드리스에서도). 최적화 A/B 용.
        if (p.skipCapture) {
          useTheme.getState().apply(prevTheme, prevMode);
          return {
            applyJsMs: Math.round(applyJsMs),
            applyReflowMs: Math.round(applyReflowMs),
            skipped: "capture",
          };
        }
        // 캡처 패스를 위해 다시 startMode 로 되돌리고 짧게 settle.
        useTheme.getState().apply(theme, startMode);
        await sleep(250);
        // 2) 녹화 시작(비대기) → applyAtMs 후 끝 모드로 토글 → 녹화 완료 대기.
        stage = "record";
        const recT0 = performance.now();
        const recP = invoke<number>("plugin:webview-capture|record", {
          dir,
          frames,
          intervalMs,
        });
        await sleep(applyAtMs);
        useTheme.getState().apply(theme, endMode);
        const n = await recP;
        // 실측 프레임 간격(네이티브 캡처가 intervalMs 보다 느릴 수 있음 — tear ms 는 이것 기준).
        const realFrameMs = n > 0 ? (performance.now() - recT0) / n : intervalMs;
        // 3) 프레임별 영역 명도 → tear 판정.
        stage = "analyze";
        const grid = await invoke<number[][]>(
          "plugin:webview-capture|analyze_regions",
          { dir, regions: regionList },
        );
        // 4) 원래 테마 복원.
        useTheme.getState().apply(prevTheme, prevMode);

        stage = "interpret";
        const round = (v: number) => Math.round(v);
        const per = names.map((name, c) => {
          const start = grid[0]?.[c] ?? 0;
          const end = grid[grid.length - 1]?.[c] ?? 0;
          const mid = (start + end) / 2;
          const rising = end >= start;
          let transitionFrame = -1;
          for (let f = 0; f < grid.length; f++) {
            const v = grid[f]?.[c] ?? 0;
            if (rising ? v >= mid : v <= mid) {
              transitionFrame = f;
              break;
            }
          }
          return { name, start: round(start), end: round(end), transitionFrame };
        });
        const tfs = per.map((r) => r.transitionFrame).filter((f) => f >= 0);
        const minTf = tfs.length ? Math.min(...tfs) : 0;
        const maxTf = tfs.length ? Math.max(...tfs) : 0;
        const spreadFrames = maxTf - minTf;
        return {
          frames: n,
          frameMs: Math.round(realFrameMs),
          applyJsMs: Math.round(applyJsMs),
          applyReflowMs: Math.round(applyReflowMs),
          spreadFrames,
          spreadMs: Math.round(spreadFrames * realFrameMs),
          atomic: spreadFrames === 0,
          regions: per,
        };
      } catch (e) {
        // 행이 아니라 실패면 단계와 함께 회신(타임아웃으로 침묵하지 않게).
        try {
          useTheme.getState().apply(prevTheme, prevMode);
        } catch {
          /* 복원 실패는 부차 */
        }
        return { error: String(e), stage };
      }
    },
  });

  register("theme.list", {
    description:
      "List available themes (built-in + external ~/.soksak/themes), including files that failed validation and their reasons.",
    triggers: { ko: "테마 목록 테마 보기 사용 가능 테마" },
    params: {},
    returns: "{ current, mode, themes:[{name,defaultMode,modes,source,warnings}], rejected }",
    message: (d) => tmsg("msg.theme.list", { n: ((d.themes as unknown[]) ?? []).length }),
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
    message: (d) => tmsg("msg.theme.apply", { name: String(d.name) }),
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
    message: (d) => tmsg("msg.theme.reload", { n: Number(d.count) }),
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
    message: (d) =>
      d.rejected
        ? tmsg("msg.theme.install.rejected")
        : tmsg("msg.theme.install.installed", { path: String(d.installed) }),
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
  registerFsWatchCatalog();
  registerPluginCatalog();
  registerDaemonCatalog();
  registerUiCatalog();
  registerDomCatalog();
  registerDataCatalog();
  registerSecretsCatalog();
  registerAiSessionCatalog();
  registerTurnCatalog();
  registerNetworkCatalog();
  registerMediaCatalog();
  registerClipboardCatalog();
  registerNotifyCatalog();
  registerScheduleCatalog();
  registerServiceCatalog();
  registerSystemCatalog();
  registerWebviewCatalog();
}
