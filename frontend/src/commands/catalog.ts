// Command catalog — every soksak capability registers as a command (single source of truth).
// Targeting rules (all commands):
//   - An explicit target id selects that location (searched across every workspace); omitting it
//     uses the caller context (SOKSAK_CALLER_TAB → the pane/space/workspace of that tab) or the
//     active chain.
//   - Every mutation returns its result (new id / state after the change) — the caller verifies
//     from the response alone.

import { registerCaptureCatalog } from "./catalogCapture";
import { registerSettingsCatalog } from "./catalogSettings";
import { registerHealthCatalog } from "./catalogHealth";
import { registerBootCatalog } from "./catalogBoot";
import { registerWindowCatalog } from "./catalogWindow";
import { framework, invoke, frameworkPath } from "../framework";
import {
  validWindowRecordFrames,
  validWindowRecordIntervalMs,
} from "./windowRecorder";
import { tabIconOf } from "../lib/tabIcon";
import { tmsg, key} from "../i18n";
import { computeSplitLayout } from "../lib/splitLayout";
import { railJournal } from "../lib/railJournal";
import { fingerprintOf } from "./stateFingerprint";
import {
  DEFAULT_RAIL_PLACEMENT,
  snapRailStation,
  type RailPlacement,
} from "../lib/railPlacement";
import { listRecentWorkspaces, removeRecentWorkspace } from "../state/recentWorkspaces";
import {
  allGroups,
  err,
  projectArrangement,
  splitAtGroup,
  useSessions,
  type Space,
  type DropZone,
  type PaneNode,
  type Program,
  type Workspace,
  type Side,
  type Tab,
  type Pane,
  type CmdErr,
  type SidebarRegion,
} from "../state/sessions";
import { SECTION_PLACES, byPlace, type SectionPlace } from "../state/sectionSets";
import {
  PLACE_WIDTH_BOUNDS,
  persistPlaceWidth,
  placeWidth,
  setPlaceWidth,
  widthWithinBounds,
} from "../state/placeWidth";
import {
  canonicalGutter,
  isCanonicalSide,
  resolveGutter,
  type GutterSide,
} from "../lib/gutterAddress";
import type { SidebarLayout } from "../state/sidebarLayout";
import type { SplitTree } from "../state/splitTree";
import { addWorkspaceClaimed, closeWorkspaceReleased } from "../state/workspaceRegistry";
import { getRegisteredProgram, listPrograms } from "../plugins/programRegistry";
import {
  activeSessionViewId,
  transferViewFocus,
} from "../plugins/viewFocus";
import { useSettings, EDGE_SIDEBAR_MODES, type EdgeSidebarMode } from "../state/settings";
import { currentWindowLabel } from "../lib/webviewLabels";
import { awaitViewMounted } from "../plugins/viewFocus";
import { useViewLabels } from "../state/viewLabels";
import { hasPtyObservation } from "../terminal/ptyObservationStore";
import { closeViewPermanently } from "../state/permanentViewClose";
import { computeLayout } from "../components/GroupArea";
import {
  resolveEffectiveRailRelation,
  type Arrangement,
} from "../lib/railArrangement";
import { catalogJson, execute, register, type CommandContext, type CommandHint } from "./registry";
import { notFound } from "./refuse";
import { registerFsWatchCatalog } from "./catalogFsWatch";
import { registerSectionsCatalog } from "./catalogSections";
import { registerPluginCatalog } from "./catalogPlugins";
import { registerDaemonCatalog } from "./catalogDaemon";
import { registerUpdateCatalog } from "./catalogUpdate";
import { registerUiCatalog } from "./catalogUi";
import { registerDomCatalog } from "./catalogDom";
import { registerDataCatalog } from "./catalogData";
import { registerSecretsCatalog } from "./catalogSecrets";
import { registerNetworkCatalog } from "./catalogNetwork";
import { registerClipboardCatalog } from "./catalogClipboard";
import { registerNotifyCatalog } from "./catalogNotify";
import { registerScheduleCatalog } from "./catalogSchedule";
import { registerServiceCatalog } from "./catalogService";
import { registerRuntimeCatalog } from "./catalogRuntime";
import { registerSystemCatalog } from "./catalogSystem";
import { registerSidecarCatalog } from "./catalogSidecar";
import {
  declareLayoutCause,
  layoutTransitionJournal,
  waitForLayoutTransaction,
} from "../lib/layoutTransitionJournal";
import { registerLayoutAlignmentCatalog, registerLayoutTraceCatalog } from "./catalogLayoutAlignment";
import { registerWebviewCatalog } from "./catalogWebview";
import { registerPresentationClockCatalog } from "./catalogPresentationClock";
import {
  ensureDefaultWorkspaceRoot,
  FOLDER_NAME_RE,
  validateWorkspaceRoot,
} from "../lib/workspaceRoot";
import { contentViewHost, hasContentViewHost } from "../lib/contentViews";
import { nextFrame } from "../lib/nextFrame";
import { waitForDomCommit } from "./waitForDomCommit";
import {
  runSwitchScan,
  type SwitchScanActivationReceipt,
  type SwitchScanLayoutTransaction,
  type SwitchScanRegion,
} from "./switchScanRuntime";

// ── Shared errors and helpers ─────────────────────────────────────────────────

// Echo the resolved target axes in the response — omitted axes are filled silently from the caller
// context, so a response that omits them leaves the caller with no way to see where the command ran
// (targetEcho gate). Not attached to failure envelopes — a failed call has no resolved target.
function withTargets(result: object, targets: Record<string, string | undefined>): object {
  const rec = result as Record<string, unknown>;
  if (rec.ok === false || rec.code) return result;
  return { ...rec, ...targets };
}

// Attach the landed arrangement to the response of a command that changed structure — the caller
// does not have to query again to see where things aligned (the solve is already done right after
// the change). Not attached to failure responses.
function withArrangement(projectId: string, result: object): object {
  const rec = result as Record<string, unknown>;
  if (rec.ok === false || rec.code) return result;
  const t = useSessions.getState().workspaces.find((item) => item.id === projectId);
  const solved = t ? projectArrangement(t) : null;
  if (!solved) return result;
  return {
    ...rec,
    arrangement: {
      station: solved.station,
      switched: solved.swapped,
      cleanLines: solved.cleanLines,
      cells: solved.cells.map((cell) => ({ id: cell.id, rect: cell.rect })),
    },
  };
}

export interface Location {
  workspace: Workspace;
  space: Space;
  pane: Pane;
  /** An empty pane (0 tabs) is a valid location with no tab — consumers that require a tab handle the absence. */
  tab?: Tab;
}

// layout.apply authoring shape — spaces first, then each space's panes (splits). Same grain as the surface contract (space/pane).
interface LayoutPaneSpec {
  program: string;
  side?: Side;
}
interface LayoutSpaceSpec {
  title?: string;
  panes?: LayoutPaneSpec[];
}

// Gutter axis resolution and canonicalization is owned by lib/gutterAddress alone (the renderer's
// data-node address and the command parameters take the same function — no second standard). Here
// it only adds sizes to that result.
const EDGES = ["right", "bottom", "left", "top"] as const satisfies readonly GutterSide[];
const paneIdOf = (pane: Pane) => pane.id;

// The canonical gutter the response names — the direction axis on the command surface is edge (side
// means pane.split's split direction, a different axis, so one word never has two meanings here).
function gutterEcho(
  layout: PaneNode,
  paneId: string,
  edge: GutterSide,
): { pane: string; edge: GutterSide } | null {
  const canonical = canonicalGutter(layout, paneId, edge, paneIdOf);
  return canonical ? { pane: canonical.pane, edge: canonical.side } : null;
}

// The split that directly wraps the leaf holding that viewKey — interior nodes of the sidebar tree
// have no name, so the split to adjust is named by the view inside it (sidebar.resize). A leaf
// root has no split (null).
function sidebarSplitIdOf(layout: SidebarLayout, viewKey: string): string | null {
  const walk = (node: SidebarLayout, parentId: string | null): string | null => {
    if (node.type === "leaf") return node.value.viewKeys.includes(viewKey) ? parentId : null;
    for (const c of node.children) {
      const hit = walk(c, node.id);
      if (hit !== null) return hit;
    }
    return null;
  };
  return walk(layout, null);
}

// Current sizes of the split containing the resolved gutter — this read exists because resizeSplit
// requires the full sizes array (moving one gutter re-reads the other ratios and writes them back).
// If that interface changes to take one gutter's ratio, this function disappears entirely — that is
// the removal condition, and until then it stays a local read here (promoting it gives a home to
// something that must vanish). If promotion becomes necessary, put it next to resizeSplitTree and
// findSplitTree in splitTree.ts as a leaf generic — that file is the single abstraction for both the
// pane tree and the sidebar tree, so a read that fits only one side breaks the symmetry.
function splitSizesOf(node: PaneNode, splitId: string): number[] | null {
  if (node.type === "leaf") return null;
  if (node.id === splitId) return node.sizes;
  for (const c of node.children) {
    const hit = splitSizesOf(c, splitId);
    if (hit) return hit;
  }
  return null;
}

// Search every workspace for the location of a tab id. Terminal targets resolve through this function
// too — a terminal is a plugin view and its instance is a tab (no core terminal).
/** Tab location — other catalog files (capture etc.) use this same one (two copies answer different places for one id). */
export function locateTab(tabId: string): Location | null {
  const s = useSessions.getState();
  for (const workspace of s.workspaces) {
    for (const space of workspace.spaces) {
      for (const pane of allGroups(space.layout)) {
        const tab = pane.tabs.find((v) => v.id === tabId);
        if (tab) return { workspace, space, pane, tab };
      }
    }
  }
  return null;
}

// Location of a pane id (tab = that pane's active tab).
function locatePane(paneId: string): Location | null {
  const s = useSessions.getState();
  for (const workspace of s.workspaces) {
    for (const space of workspace.spaces) {
      const pane = allGroups(space.layout).find((g) => g.id === paneId);
      if (pane) {
        const tab =
          pane.tabs.find((v) => v.id === pane.activeTabId) ?? pane.tabs[0];
        return { workspace, space, pane, tab };
      }
    }
  }
  return null;
}

// Active chain (active workspace → active space → active pane → active tab).
function activeChain(): Location | null {
  const s = useSessions.getState();
  const workspace = s.workspaces.find((t) => t.id === s.activeId);
  if (!workspace) return null;
  const space =
    workspace.spaces.find((c) => c.id === workspace.activeSpaceId) ??
    workspace.spaces[0];
  if (!space) return null;
  const pane =
    allGroups(space.layout).find((g) => g.id === space.activePaneId) ??
    allGroups(space.layout)[0];
  if (!pane) return null;
  const tab =
    pane.tabs.find((v) => v.id === pane.activeTabId) ?? pane.tabs[0];
  // An empty pane (everything moved or closed) is a valid location too — pane-target commands
  // (tab.open etc.) must keep working, so it is not cut off here; consumers that require a tab handle
  // the absence (no INTERNAL death, measured).
  return { workspace, space, pane, tab };
}

// Call context resolution: caller tab ($SOKSAK_CALLER_TAB) first, else the active chain.
function resolveCtx(ctx: CommandContext): Location | null {
  if (ctx.pane) {
    const loc = locateTab(ctx.pane);
    if (loc) return loc;
  }
  return activeChain();
}

// Target workspace: explicit id > context.
export function resolveWorkspace(
  params: Record<string, unknown>,
  ctx: CommandContext,
): Workspace | null {
  const id = params.workspace as string | undefined;
  if (id) {
    return useSessions.getState().workspaces.find((t) => t.id === id) ?? null;
  }
  return resolveCtx(ctx)?.workspace ?? null;
}

// Target pane: explicit id (searched across every workspace) > context pane.
function resolvePane(
  params: Record<string, unknown>,
  ctx: CommandContext,
): Location | null {
  const id = params.pane as string | undefined;
  if (id) return locatePane(id);
  return resolveCtx(ctx);
}



// A program id for an example line — the first one registered, and "<program>" when none is.
// The registry answers; no id is written down here.
function exampleProgramId(): string {
  return listPrograms()[0]?.decl.id ?? "<program>";
}

// ── Serialization (state.tree) ────────────────────────────────────────────────

function serializeTab(v: Tab) {
  // drawnIcon is what the tab bar draws, from the same function it draws by. `icon` alone answered
  // only what a view reported, so two tabs of one view drawing different icons was visible on screen
  // and unreadable from outside (EVIDENCE E2 — a surface with no number is unfinished).
  const drawn = tabIconOf(v);
  return {
    id: v.id,
    kind: v.kind,
    title: v.title,
    customLabel: v.customLabel,
    icon: v.icon,
    drawnIcon: drawn.source,
    drawnIconValue: drawn.value,
    plugin: v.pluginId,
    view: v.view,
  };
}

// Serialization of the split structure (shared by the pane tree and the sidebar tree). Interior nodes
// are not real things, so they have no name — only dir/sizes and nested children, no id. Commands
// that manipulate gutters (pane.resize, pane.equalize, sidebar.resize) name a gutter by leaf, so
// an interior node is never named (IDENTITY §4).
function serializeSplitStructure<L>(
  node: SplitTree<L>,
  leafOf: (value: L) => object,
): object {
  if (node.type === "leaf") return leafOf(node.value);
  return {
    split: { dir: node.dir, sizes: node.sizes },
    children: node.children.map((c) => serializeSplitStructure(c, leafOf)),
  };
}

function serializeLayout(node: PaneNode): object {
  return serializeSplitStructure(node, (pane) => ({ pane: pane.id }));
}

function serializeSidebarLayout(node: SidebarLayout): object {
  return serializeSplitStructure(node, (g) => ({
    viewKeys: g.viewKeys,
    active: g.activeViewKey,
  }));
}

function serializeSpace(
  c: Space,
  activeSpaceId: string,
  /** The solve for this space (arrangement solver). An inactive space with no rail is null — the canonical order as is. */
  arrangement: Arrangement<Pane> | null,
  railOpen = true,
  railPlacement: RailPlacement["mode"] = "flow",
) {
  const displayLayout = arrangement?.displayLayout ?? c.layout;
  const canonicalLayout = serializeLayout(c.layout);
  const canonicalCells = computeLayout(c.layout).cells;
  const projectedCells = computeLayout(displayLayout).cells;
  const maximizedPane = c.maximizedTabId
    ? (projectedCells.find(({ group }) => group.id === c.activePaneId) ??
      projectedCells.find(({ group }) =>
        group.tabs.some((tab) => tab.id === c.maximizedTabId),
      ) ?? null)
    : null;
  const cells = maximizedPane
    ? [{ group: maximizedPane.group, rect: { left: 0, top: 0, width: 100, height: 100 } }]
    : projectedCells;
  const canonicalOrder = canonicalCells.map(({ group }) => group.id);
  const projectedOrder = projectedCells.map(({ group }) => group.id);
  const swappedPanes = canonicalOrder.filter(
    (id, index) => projectedOrder[index] !== id,
  );
  const projection = c.maximizedTabId
    ? {
        kind: "maximized" as const,
        applied: true,
        focusedPaneId: c.activePaneId,
        swappedPanes: [] as string[],
      }
    : displayLayout !== c.layout
      ? {
          kind: "switched" as const,
          applied: true,
          focusedPaneId: c.activePaneId,
          swappedPanes,
        }
      : {
          kind: "canonical" as const,
          applied: false,
          focusedPaneId: c.activePaneId,
          swappedPanes: [] as string[],
        };
  // Consumes the same solver as the screen. A missing explicit binding resolves to the active tab of
  // the active pane; a closed rail or an empty pane is published as none/0, not hidden as nullable.
  const railRelation = resolveEffectiveRailRelation({
    contentId: c.id,
    arrangement,
    placement: railPlacement,
    railOpen,
  }).state;
  return {
    id: c.id,
    title: c.title,
    active: c.id === activeSpaceId,
    activePaneId: c.activePaneId,
    maximizedTabId: c.maximizedTabId ?? null,
    // layout/panes = the screen right now. canonicalLayout = read-only serialization of the stored
    // SplitTree. Consumers need not mistake the projection for the canonical state or read the private store.
    layout: maximizedPane
      ? { pane: maximizedPane.group.id }
      : serializeLayout(displayLayout),
    canonicalLayout,
    projection,
    railRelation,
    panes: cells.map(({ group, rect }) => ({
      id: group.id,
      rect: {
        left: Math.round(rect.left * 10) / 10,
        top: Math.round(rect.top * 10) / 10,
        width: Math.round(rect.width * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
      },
      active: group.id === c.activePaneId,
      activeTabId: group.activeTabId,
      tabs: group.tabs.map(serializeTab),
    })),
  };
}

// Public facts about the left rail position. The stored PIN station and the station actually applied
// on the current grid are kept apart. Reading a stale snapshot's dirty PIN does not change the stored
// value; only an explicit PIN command snaps to a valid line and stores it.
function serializeRailPosition(t: Workspace) {
  const arrangement = projectArrangement(t);
  const cleanLines = arrangement?.cleanLines ?? [0, 100];
  const placement: RailPlacement = t.railPlacement ?? DEFAULT_RAIL_PLACEMENT;
  const effectiveStation = arrangement?.station ?? 0;
  return placement.mode === "pin"
    ? {
        mode: placement.mode,
        station: placement.station,
        effectiveStation,
        cleanLines,
      }
    : { mode: placement.mode, effectiveStation, cleanLines };
}

function serializeTree() {
  const s = useSessions.getState();
  return {
    activeProjectId: s.activeId,
    workspaces: s.workspaces.map((t) => {
      const railPosition = serializeRailPosition(t);
      const arrangement = projectArrangement(t);
      return {
        id: t.id,
        title: t.title,
        root: t.root ?? null,
        color: t.color ?? null,
        // One entry per place, by name. It was `sidebarOpen`, a single boolean, from the days when
        // the window had one sidebar and `left` named the rail — so whether either window edge
        // stood could not be asked from outside at all (measured 2026-08-19: the left edge was open
        // with a set standing in it, drawing nothing, and only the DOM named it).
        regionOpen: byPlace((place) => t.regionOpen[place]),
        railPosition: railPosition,
        active: t.id === s.activeId,
        activeSpaceId: t.activeSpaceId,
        spaces: t.spaces.map((c) =>
          serializeSpace(
            c,
            t.activeSpaceId,
            c.id === t.activeSpaceId ? arrangement : null,
            t.regionOpen.rail,
            railPosition.mode,
          ),
        ),
      };
    }),
  };
}

// ── Parameter fragments (reused) ──────────────────────────────────────────────

/**
 * Window axis resolution — four commands use the same shape.
 *
 * When the shape differs per command, "omitted = the addressed target" goes missing somewhere
 * (measured: only window.close missed it and died on a missing argument). One resolution function
 * makes that rule hold in the code — different from a test catching it afterwards.
 */
export function windowTarget(p: Record<string, unknown>): string {
  return typeof p.label === "string" && p.label ? p.label : currentWindowLabel();
}

export const P = {
  /**
   * Window axis — the envelope (--window) already names the target, so omitting is the default.
   *
   * Why the definition is in one place: written per command, the meaning and the default drift apart.
   * Measured defect — only window.close required label in practice, so a close called against its own
   * window died on a missing argument and e2e piled up views on every run. The window axis cannot be
   * required (windowAxis.test).
   *
   * The webview axis (webview.recover's label = b-<win>-<view>) is a different identifier space, outside this rule.
   */
  windowLabel: {
    type: "string",
    description: key("cmd.param.windowLabel"),
  },
  workspace: {
    type: "string",
    description: key("cmd.param.workspace"),
  },
  space: { type: "string", description: key("cmd.param.space") },
  pane: {
    type: "string",
    description: key("cmd.param.pane"),
  },
  /**
   * Tab axis — one axis has one name. Two names for the same id space make the caller guess which to
   * use, and a fix touches only one of them. Terminal targets are this axis too (a terminal = an
   * instance of a plugin view).
   */
  tab: {
    type: "string",
    description: key("cmd.param.tab"),
  },
  program: {
    type: "string",
    description: key("cmd.param.program"),
  },
  side: {
    type: "string",
    description: key("cmd.param.side"),
    enum: ["left", "right", "top", "bottom"],
  },
  edge: {
    type: "string",
    description: key("cmd.param.edge"),
    enum: [...EDGES],
  },
  zone: {
    type: "string",
    description: key("cmd.param.zone"),
    enum: ["center", "left", "right", "top", "bottom"],
  },
} satisfies Record<string, import("./registry").ParamSpec>;

// ── Registration ──────────────────────────────────────────────────────────────

export function registerCatalog(): void {
  registerBootCatalog();
  registerPresentationClockCatalog();
  const S = () => useSessions.getState();

  // ----- state -----
  // ui.measure / ui.tree / ui.input.* are in catalogDom.ts (address-based) — selector measurement is dropped (moved to the address scheme).

  register("state.tree", {
    description: key("cmd.state.tree.desc"),
    params: {},
    returns:
      "{ activeProjectId, workspaces[].{ regionOpen{left,rail,right}, railPosition, spaces[].{ layout, canonicalLayout, projection, railRelation:{boundTabId,boundPaneId,relationId,placement,connected,side:left|right|detached,borderMode:union|independent|none,pathCount:1|2|0}, panes[] } } } — layout/panes are displayed state; canonicalLayout is the stored SplitTree",
    message: (d) => tmsg("msg.state.tree", { n: ((d.workspaces as unknown[]) ?? []).length }),
    examples: ["state.tree"],
    handler: () => serializeTree(),
  });

  // What a restore is judged by. state.tree, layout.arrangement and surface.composition each answer
  // part of what a window holds, and comparing three answers across a restart puts the rule in
  // whoever is comparing — two people comparing the same restart can then disagree about it.
  register("state.fingerprint", {
    description: key("cmd.state.fingerprint.desc"),
    triggers: { ko: "상태 지문 복원 동형 비교 다이제스트" },
    params: {},
    returns:
      "{ digest, workspaces[].{ root, mode, station, cleanLines[], spaces[].panes[].{rect,active} } } — the parts are carried beside the digest so a mismatch says which one moved",
    message: (d) => tmsg("msg.state.fingerprint", { digest: String(d.digest) }),
    examples: ["state.fingerprint"],
    handler: () => fingerprintOf(serializeTree()),
  });

  // The arrangement solve — station, switching and travel distance are a pure function of (grid,
  // focus), and this command exposes that solve as is. Comparing it against observation (ui.measure)
  // shows whether the screen matches the contract.
  // No command sets the arrangement directly — the solve comes out of the tree and the focus, so a
  // surface that writes it directly becomes a second truth (position is owned by
  // rail.position, structure by pane.*).
  register("layout.arrangement", {
    description: key("cmd.layout.arrangement.desc"),
    triggers: {
      ko: "배치 해 레일 스테이션 이동량 스위칭 정렬 계산 확인",
    },
    params: { workspace: P.workspace },
    returns:
      "{ projectId, spaceId, station, cleanLines[], switched, focusId, relation:{boundPaneId,boundTabId,source(binding|focus|fallback|none),side,connected,borderMode,pathCount}, betweenIds[] (panes stranded between the rail and the focused pane when the rail could not reach it — they do not move, they dim), cells[].{id,rect,railSide} }",
    message: (d) => tmsg("msg.layout.arrangement", { n: Number(d.station) }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["layout.arrangement"],
    handler: (p, ctx) => {
      const t = resolveWorkspace(p, ctx);
      if (!t) return notFound("msg.workspace.notFound");
      const solved = projectArrangement(t);
      if (!solved) return notFound("msg.space.notFound");
      const railOpen = t.regionOpen.rail;
      // Which pane the rail is grouped with, from the same solve the screen draws. The command
      // answered the station and the cells and said nothing about the grouping, so an outline drawn
      // around the wrong pane could only be reported by looking at it (measured 2026-08-19).
      const relation = resolveEffectiveRailRelation({
        contentId: t.activeSpaceId,
        arrangement: solved,
        placement: (t.railPlacement ?? DEFAULT_RAIL_PLACEMENT).mode,
        railOpen,
      }).state;
      return {
        projectId: t.id,
        spaceId: t.activeSpaceId,
        station: solved.station,
        cleanLines: solved.cleanLines,
        switched: solved.swapped,
        focusId: solved.focusId,
        relation,
        // Panes stranded between the rail and the focused pane when the rail could not travel there —
        // they do not move, they dim. A hand-written list drops one entry every time the contract grows
        // (measured 2026-08-02: this spot omitted betweenIds, so the command could not report that fact).
        betweenIds: solved.betweenIds,
        railOpen,
        cells: solved.cells.map((cell) => ({
          id: cell.id,
          rect: {
            left: cell.rect.left,
            top: cell.rect.top,
            width: cell.rect.width,
            height: cell.rect.height,
          },
          railSide: cell.rect.left >= solved.station - 0.01 ? "after" : "before",
        })),
      };
    },
  });

  // The declared arrangement and the pixels on screen are two different facts. Only their difference
  // answers whether the layout landed. layout.arrangement gives the first, ui.measure gives the second
  // one node at a time — read apart, the subtraction is left to the caller, who then needs the CSS rule
  // to do it. This command subtracts in one call so the judgement is a number.
  //
  // The arithmetic below repeats the .pane rule in App.css on purpose. A verifier that shares the
  // renderer's arithmetic answers yes to every question; this one recomputes the position from the
  // declared percentage and compares.
  register("layout.verify", {
    description: key("cmd.layout.verify.desc"),
    triggers: { ko: "레이아웃 검증 선언 실측 차이 대조 셀 rect 픽셀" },
    params: { workspace: P.workspace },
    returns:
      "{ projectId, spaceId, settled, inFlight[], host:{left,top,width,height}, devicePixelRatio, tolerance, worst, panes[].{id,declared:{left,top,width,height},expected:{left,top,width,height},measured:{left,top,width,height},delta:{left,top,width,height},worst}, missing[], unexpected[] }",
    message: (d) =>
      d.settled
        ? tmsg("msg.layout.verify", { n: Number(d.worst) })
        : tmsg("msg.layout.verify.moving", { n: Number(d.worst) }),
    errors: ["TARGET_NOT_FOUND", "NOT_EXPOSED"],
    examples: ["layout.verify"],
    handler: async (p, ctx) => {
      const t0 = resolveWorkspace(p, ctx);
      if (!t0) return notFound("msg.workspace.notFound");
      if (!projectArrangement(t0)) return notFound("msg.space.notFound");

      const read = (el: HTMLElement, name: string): number => {
        const raw = getComputedStyle(el).getPropertyValue(name).trim();
        const n = Number.parseFloat(raw);
        return Number.isFinite(n) ? n : 0;
      };
      const cellIds = (w: Workspace): string =>
        (projectArrangement(w)?.cells ?? []).map((c) => c.id).sort().join(" ");

      // Measured after a paint, and only trusted when the arrangement did not move while it was being
      // measured. React commits a split on a later frame than the store update, so a measurement taken
      // between the two describes a DOM built from an older tree — measured 2026-08-16, verifying
      // during a burst of splits gave 20.8px of difference and 28 panes counted as missing, all of
      // which came to 0.013px and 0 once the frame landed. The open-transaction list alone does not
      // catch that: the transaction closes before the frame is painted.
      let attempt: {
        solved: NonNullable<ReturnType<typeof projectArrangement>>;
        workspace: Workspace;
        host: HTMLElement;
        stable: boolean;
      } | null = null;
      for (let round = 0; round < 4; round += 1) {
        // Two frames: the commit, then the paint that follows it. Each has its own second clock,
        // so a window that is not drawing ends this round instead of holding the command.
        await nextFrame();
        await nextFrame();
        const before = resolveWorkspace(p, ctx);
        if (!before) return notFound("msg.workspace.notFound");
        const solved = projectArrangement(before);
        if (!solved) return notFound("msg.space.notFound");
        const host = document.querySelector<HTMLElement>(
          `[data-node="layout/space/${before.activeSpaceId}"]`,
        );
        if (!host) return { ok: false, code: "NOT_EXPOSED", message: `layout/space/${before.activeSpaceId}` };
        const drawn = [...document.querySelectorAll<HTMLElement>(`[data-node^="layout/pane/"]`)]
          .filter((el) => host.contains(el) && el.dataset.pane)
          .map((el) => el.dataset.pane as string)
          .sort()
          .join(" ");
        const after = resolveWorkspace(p, ctx);
        const stable = !!after && cellIds(before) === cellIds(after) && cellIds(before) === drawn;
        attempt = { solved, workspace: before, host, stable };
        if (stable) break;
      }
      if (!attempt) return notFound("msg.workspace.notFound");
      const { solved, workspace: t, host, stable } = attempt;

      const spaceId = t.activeSpaceId;
      const hostRect = host.getBoundingClientRect();
      // The inset is declared once on the space container and every pane consumes it.
      const inset = read(host, "--pane-inset");

      const onScreen = new Map<string, HTMLElement>();
      for (const el of document.querySelectorAll<HTMLElement>(`[data-node^="layout/pane/"]`)) {
        const id = el.dataset.pane;
        if (id && host.contains(el)) onScreen.set(id, el);
      }

      const missing: string[] = [];
      const panes: unknown[] = [];
      let worst = 0;

      for (const cell of solved.cells) {
        const el = onScreen.get(cell.id);
        if (!el) {
          missing.push(cell.id);
          continue;
        }
        onScreen.delete(cell.id);
        const measured = el.getBoundingClientRect();
        // The rail shifts a pane sideways. The shift it was rendered with is on the pane itself.
        const railDx = read(el, "--rail-dx");
        const railDw = read(el, "--rail-dw");
        const expected = {
          left: hostRect.left + (hostRect.width * cell.rect.left) / 100 + railDx + inset,
          top: hostRect.top + (hostRect.height * cell.rect.top) / 100 + inset,
          width: (hostRect.width * cell.rect.width) / 100 + railDw - inset * 2,
          height: (hostRect.height * cell.rect.height) / 100 - inset * 2,
        };
        const delta = {
          left: measured.left - expected.left,
          top: measured.top - expected.top,
          width: measured.width - expected.width,
          height: measured.height - expected.height,
        };
        const cellWorst = Math.max(...Object.values(delta).map(Math.abs));
        worst = Math.max(worst, cellWorst);
        panes.push({
          id: cell.id,
          declared: cell.rect,
          expected,
          measured: { left: measured.left, top: measured.top, width: measured.width, height: measured.height },
          delta,
          worst: cellWorst,
        });
      }

      const dpr = window.devicePixelRatio || 1;
      // The open transactions are reported alongside, because an unstable answer during one has a
      // different cause than an unstable answer with none open.
      const inFlight = layoutTransitionJournal()
        .filter((entry) => entry.phase === "preparing" || entry.phase === "prepared")
        .map((entry) => entry.transactionId);
      return {
        projectId: t.id,
        spaceId,
        settled: stable,
        inFlight,
        host: { left: hostRect.left, top: hostRect.top, width: hostRect.width, height: hostRect.height },
        devicePixelRatio: dpr,
        // A layout is laid out in CSS pixels and painted on device pixels, so a difference smaller than
        // one device pixel cannot appear on screen. Anything larger is a real mismatch.
        tolerance: 1 / dpr,
        worst,
        panes,
        missing,
        unexpected: [...onScreen.keys()],
      };
    },
  });

  // The rail contract as numbers. layout.transactions records what the presentation layer
  // acknowledged; this records what the arrangement was at each phase, which is a different fact
  // and the one the three rail claims are judged on.
  register("layout.transition.journal", {
    description: key("cmd.layout.transition.journal.desc"),
    triggers: { ko: "레일 전이 저널 위상 스테이션 이동 델타 표면" },
    params: {},
    returns:
      "{ records:[{ sequence, phase:'settled'|'traveling', frame, station, dStation, cleanLines[], cells[].{id,rect}, moved[].{id,dLeft,dTop,dWidth,dHeight}, appeared[], gone[], railSurfaces }] } — moved omits a pane that did not move, so nothing moved is read rather than computed; appeared and gone name panes with no rectangle on one side, because there is no delta against one that did not exist",
    message: (d) => tmsg("msg.layout.transition.journal", { n: ((d.records as unknown[]) ?? []).length }),
    examples: ["layout.transition.journal"],
    handler: () => ({ records: railJournal() }),
  });

  register("layout.transactions", {
    description: key("cmd.layout.transactions.desc"),
    triggers: { ko: "레이아웃 거래 장부 이동 위상 수치 추적" },
    params: {},
    returns:
      "{ entries:[{transactionId,causeTraceId?,sequence,recordingFrame?,phase:'preparing'|'prepared'|'committed'|'failed'|'cancelled',openedAtUnixMs,preparedAtUnixMs?,domCommittedAtUnixMs?,closedAtUnixMs?,stagedTargetsStatus:'pending'|'declared',stagedTargets:null|[direct:<label>|pane:<host>],moves,panePresentationTargets:[{viewId}],paneSettlementParticipants:[{viewId}],settlement:{ownerKey,revision,status:'pending'|'settled'|'failed'|'cancelled'}|null,presentationFailure?:{candidateAttempts:[{candidate:{commandReceivedAtUnixUs,installedAtUnixUs,callbackReceivedAtUnixUs,callbackObservedAtUnixMs,callbackObservedAtUnixUs,startAtUnixUs,documentTimelineBridge:{producer:'display-callback-wall-bridge',clock:'unix-wall',callbackObservedAtUnixUs,startAtUnixUs}},armClock,armStartedAtUnixUs,armCompletedAtUnixUs,armDurationUs,armFailures:[{diagnostic?:{expectedDocumentStartTime?}}]}]},projectionFailure?:{transactionId,stagedTarget,paneBoundsAck:{transactionId,pane,targetMemberFrames,memberPlacements}}} & (preparing:{mode:null}|glide:{mode:'glide',presentationStart:{transactionId,producer:'display-callback',clock,sourceGeneration,frameSequence,commandReceivedAtUnixUs,installedAtUnixUs,callbackReceivedAtUnixUs,startAtUnixUs,durationMs,documentTimelineBridge:{producer:'display-callback-wall-bridge',clock:'unix-wall',callbackObservedAtUnixUs,startAtUnixUs},candidateAttempts:[...]},projectionCommit:absent}|snap:{mode:'snap',presentationStart:absent,projectionCommit:{transactionId,producer:'layout-adapter',targets:[{stagedTarget,owner:'pane-bounds'|'direct-bounds'|'external-surface',frame:{x,y,w,h},sourceGeneration?}]})] }",
    message: (data) => `layout transactions ${String((data.entries as unknown[])?.length ?? 0)}`,
    examples: ["layout.transactions"],
    handler: () => ({ entries: layoutTransitionJournal() }),
  });

  register("layout.transaction.wait", {
    description: key("cmd.layout.transaction.wait.desc"),
    triggers: { ko: "레이아웃 거래 종결 대기 원인 식별자 이벤트" },
    params: {
      causeTraceId: {
        type: "string",
        description: key("cmd.layout.transaction.wait.param.causeTraceId"),
        required: true,
      },
      afterSequence: {
        type: "number",
        description: key("cmd.layout.transaction.wait.param.afterSequence"),
        required: true,
      },
      timeoutMs: {
        type: "number",
        description: key("cmd.layout.transaction.wait.param.timeoutMs"),
        required: true,
      },
    },
    returns:
      "{ causeStatus:'exact', entry:{panePresentationTargets:[{viewId}],paneSettlementParticipants:[{viewId}],settlement:{ownerKey,revision,status:'pending'|'settled'|'failed'|'cancelled'}|null,...} & (glide:{mode:'glide',presentationStart:{transactionId,producer:'display-callback',clock,sourceGeneration,frameSequence,commandReceivedAtUnixUs,installedAtUnixUs,callbackReceivedAtUnixUs,startAtUnixUs,durationMs,documentTimelineBridge:{producer:'display-callback-wall-bridge',clock:'unix-wall',callbackObservedAtUnixUs,startAtUnixUs},candidateAttempts:[{candidate:{commandReceivedAtUnixUs,installedAtUnixUs,callbackReceivedAtUnixUs,callbackObservedAtUnixMs,callbackObservedAtUnixUs,startAtUnixUs,documentTimelineBridge:{producer:'display-callback-wall-bridge',clock:'unix-wall',callbackObservedAtUnixUs,startAtUnixUs}},armClock,armStartedAtUnixUs,armCompletedAtUnixUs,armDurationUs,...}]},projectionCommit:absent,...}|snap:{mode:'snap',presentationStart:absent,projectionCommit:{transactionId,producer:'layout-adapter',targets:[{stagedTarget,owner,frame,sourceGeneration?}]},...}|failed:{mode:null|'glide'|'snap',failure,presentationFailure?,...}) }",
    message: (data) => `layout transaction ${String((data.entry as { transactionId?: string })?.transactionId ?? "")}`,
    errors: ["INVALID_PARAMS", "TIMEOUT", "AMBIGUOUS_TARGET"],
    examples: ['layout.transaction.wait \'{"causeTraceId":"flow-1","afterSequence":12,"timeoutMs":8000}\''],
    handler: (p) => waitForLayoutTransaction({
      causeTraceId: p.causeTraceId as string,
      afterSequence: p.afterSequence as number,
      timeoutMs: p.timeoutMs as number,
    }),
  });

  register("state.commands", {
    description: key("cmd.state.commands.desc"),
    params: {},
    returns: "{ commands: [{name,description,params,returns,errors,examples}] }",
    message: (d) => tmsg("msg.state.commands", { n: ((d.commands as unknown[]) ?? []).length }),
    examples: ["commands"],
    handler: () => ({ commands: catalogJson() }),
  });

  register("state.context", {
    description: key("cmd.state.context.desc"),
    params: { tab: P.tab },
    returns:
      "{ projectId, spaceId, paneId, tabId?, callerTab? } — tabId is absent when the pane is empty; callerTab is the terminal tab this call came from",
    message: (d) =>
      d.tabId
        ? tmsg("msg.state.context", { view: String(d.tabId) })
        : tmsg("msg.state.context.emptyPane", { pane: String(d.paneId) }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["state.context"],
    handler: (p, ctx) => {
      const loc = p.tab ? locateTab(p.tab as string) : resolveCtx(ctx);
      if (!loc) return notFound("msg.state.context.unresolved");
      return {
        projectId: loc.workspace.id,
        spaceId: loc.space.id,
        paneId: loc.pane.id,
        // With an empty pane the answer stops at the pane and omits tabId — an empty pane location is a location.
        tabId: loc.tab?.id,
        // Caller context axis ("my position inside the terminal") — a different axis from the target
        // axis (tabId), so it has a different name.
        // Explicit > context > active tab (only when that tab has PTY observation).
        callerTab:
          (p.tab as string) ??
          ctx.pane ??
          (loc.tab && hasPtyObservation(loc.tab.id) ? loc.tab.id : undefined),
      };
    },
  });

  // ----- workspace -----
  register("workspace.list", {
    description: key("cmd.workspace.list.desc"),
    triggers: { ko: "워크스페이스 목록 워크스페이스 리스트 열린 워크스페이스" },
    params: {},
    returns: "{ workspaces: [{id,title,root,active}] }",
    message: (d) => tmsg("msg.workspace.list", { n: ((d.workspaces as unknown[]) ?? []).length }),
    examples: ["workspace.list"],
    handler: () => ({
      workspaces: S().workspaces.map((t) => ({
        id: t.id,
        title: t.title,
        root: t.root ?? null,
        active: t.id === S().activeId,
      })),
    }),
  });

  register("workspace.recent", {
    description: key("cmd.workspace.recent.desc"),
    triggers: { ko: "최근 워크스페이스 목록 최근 연 워크스페이스 픽커 레일" },
    params: {},
    returns: "{ recents: [{root, alias, lastOpenedAt}] }",
    message: (d) => tmsg("msg.workspace.recent", { n: ((d.recents as unknown[]) ?? []).length }),
    examples: ["workspace.recent"],
    handler: async () => ({ recents: await listRecentWorkspaces() }),
  });

  register("workspace.recent.remove", {
    description: key("cmd.workspace.recent.remove.desc"),
    triggers: { ko: "최근 워크스페이스 제거 최근 목록에서 지우기 잊기" },
    params: {
      root: { type: "string", description: key("cmd.workspace.recent.remove.param.root"), required: true },
    },
    returns: "{ ok }",
    message: () => tmsg("msg.workspace.recent.remove"),
    examples: ['workspace.recent.remove \'{"root":"/Users/me/old"}\''],
    handler: async (p) => {
      await removeRecentWorkspace(p.root as string);
      return {};
    },
  });

  register("workspace.open", {
    description: key("cmd.workspace.open.desc"),
    triggers: { ko: "워크스페이스 만들기 새 워크스페이스 워크스페이스 생성 열기" },
    params: {
      root: { type: "string", description: key("cmd.workspace.open.param.root") },
      folder: {
        type: "string",
        description: key("cmd.workspace.open.param.folder"),
      },
      alias: { type: "string", description: key("cmd.workspace.open.param.alias") },
      program: { ...P.program, description: key("cmd.workspace.open.param.program") },
    },
    returns:
      "{ projectId, spaceId, paneId, tabId, existing? } | { existingWindow } (already open in another window — focused instead) | { routedWindow } (called on the control-plane window — opened in a new workspace window instead)",
    message: (d) =>
      d.routedWindow
        ? tmsg("msg.workspace.open.routed", { window: String(d.routedWindow) })
        : d.existingWindow
          ? tmsg("msg.workspace.open.existingWindow")
          : d.existing
            ? tmsg("msg.workspace.open.existing")
            : tmsg("msg.workspace.open.created"),
    errors: ["INVALID_PARAMS"],
    hint: (d) => {
      // Failures go to the standard guidance (only code arrives, with no window fields).
      if (d.code) return [];
      // The control plane routed to a new workspace window — offer the moves that continue in that window.
      const routed = d.routedWindow as string | undefined;
      if (routed) {
        return [
          { cmd: `--window ${routed} state.tree`, why: tmsg("hint.flow.workspace.open.routedContinue") },
          { cmd: `--window ${routed} layout.apply dev`, why: tmsg("hint.flow.workspace.open.routedLayout") },
        ];
      }
      // Already open in another window, which was brought to the front — continue in that window.
      const existingWin = d.existingWindow as string | undefined;
      if (existingWin) {
        return [
          { cmd: `--window ${existingWin} state.tree`, why: tmsg("hint.flow.workspace.open.existingWindow") },
        ];
      }
      // Opened in this window — offer the next moves that dress the screen (possibilities, max 3).
      return [
        { cmd: "layout.apply dev", why: tmsg("hint.flow.workspace.open.layout") },
        { cmd: "window.maximize", why: tmsg("hint.flow.workspace.open.maximize") },
        { cmd: "space.create", why: tmsg("hint.flow.workspace.open.space") },
      ];
    },
    examples: [
      'workspace.open \'{"root":"/Users/me/work","program":"claude"}\'',
      'workspace.open \'{"folder":"my-workspace"}\'',
    ],
    handler: async (p) => {
      let root = p.root as string | undefined;
      const alias = (p.alias as string) ?? "";
      if (root) {
        // P2: home/root forbidden + normalization (the comparison basis for the P5 duplicate check).
        try {
          root = await validateWorkspaceRoot(root);
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
            message: tmsg("msg.workspace.open.folderRequired"),
          };
        }
        root = await ensureDefaultWorkspaceRoot(folder);
      }
      // Root initialization policy (git init etc.) is owned by plugins that subscribe to workspace.created.
      // Through the P6 gate (one global open) — if another window owns it, that window is focused and
      // existingWindow is returned.
      const r = await addWorkspaceClaimed({
        alias,
        root,
        program: p.program as Program | undefined,
      });
      if (!r.ok || "existingWindow" in r || "routedWindow" in r) return r;
      return {
        projectId: r.projectId,
        spaceId: r.contentId,
        paneId: r.groupId,
        tabId: r.viewId,
        ...(r.existing ? { existing: r.existing } : {}),
      };
    },
  });

  register("workspace.close", {
    danger: "destructive",
    description: key("cmd.workspace.close.desc"),
    triggers: { ko: "워크스페이스 닫기 워크스페이스 제거" },
    params: { workspace: { ...P.workspace, required: true } },
    returns: "{ activeProjectId }",
    message: () => tmsg("msg.workspace.close"),
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['workspace.close \'{"workspace":"t2"}\''],
    // P6: release the global claim on a successful close (so another window can open this workspace).
    handler: (p) => closeWorkspaceReleased(p.workspace as string),
  });

  register("workspace.activate", {
    description: key("cmd.workspace.activate.desc"),
    triggers: { ko: "워크스페이스 전환 워크스페이스 바꾸기 이동" },
    params: { workspace: { ...P.workspace, required: true } },
    returns: "{}",
    message: () => tmsg("msg.workspace.activate"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['workspace.activate \'{"workspace":"t2"}\''],
    handler: (p) => S().setActive(p.workspace as string),
  });

  register("workspace.rename", {
    description: key("cmd.workspace.rename.desc"),
    triggers: { ko: "워크스페이스 이름 바꾸기 이름 변경 워크스페이스 제목" },
    params: {
      workspace: { ...P.workspace, required: true },
      title: { type: "string", description: key("cmd.workspace.rename.param.title"), required: true },
    },
    returns: "{ projectId }",
    message: () => tmsg("msg.workspace.rename"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['workspace.rename \'{"workspace":"wsp-a1b2c3","title":"backend"}\''],
    handler: (p) =>
      withTargets(S().renameWorkspace(p.workspace as string, p.title as string), {
        projectId: p.workspace as string,
      }),
  });

  register("workspace.color", {
    description: key("cmd.workspace.color.desc"),
    triggers: { ko: "워크스페이스 색 색상 탭 색깔" },
    params: {
      workspace: { ...P.workspace, required: true },
      color: {
        type: "string",
        description: key("cmd.workspace.color.param.color"),
      },
    },
    returns: "{ projectId }",
    message: () => tmsg("msg.workspace.color"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['workspace.color \'{"workspace":"wsp-a2b3c4","color":"#4a8fe8"}\''],
    handler: (p) =>
      withTargets(
        S().setWorkspaceColor(p.workspace as string, (p.color as string) ?? null),
        { projectId: p.workspace as string },
      ),
  });

  register("workspace.update", {
    description: key("cmd.workspace.update.desc"),
    params: {
      workspace: { ...P.workspace, required: true },
      title: { type: "string", description: key("cmd.workspace.update.param.title") },
      color: { type: "string", description: key("cmd.workspace.update.param.color") },
    },
    returns: "{ projectId }",
    message: () => tmsg("msg.workspace.update"),
    errors: ["TARGET_NOT_FOUND"],
    examples: [
      'workspace.update \'{"workspace":"wsp-a2b3c4","title":"backend"}\'',
    ],
    handler: (p) =>
      withTargets(
        S().updateWorkspace(p.workspace as string, {
          title: p.title as string | undefined,
          color: p.color === undefined ? undefined : (p.color as string) || null,
        }),
        { projectId: p.workspace as string },
      ),
  });

  register("workspace.region.toggle", {
    description: key("cmd.workspace.region.toggle.desc"),
    triggers: { ko: "사이드바 영역 열기 닫기 토글 좌측 우측" },
    params: {
      workspace: P.workspace,
      // Read from the places themselves. Written out here, the day a place is added is the day the
      // command refuses the one thing the window grew.
      region: {
        type: "string",
        enum: [...SECTION_PLACES],
        description: key("cmd.sidebar.param.region"),
        required: true,
      },
      open: { type: "boolean", description: key("cmd.workspace.region.toggle.param.open") },
    },
    returns: "{ projectId, region, open }",
    message: (d) =>
      d.open
        ? tmsg("msg.workspace.region.toggle.opened", { region: String(d.region) })
        : tmsg("msg.workspace.region.toggle.closed", { region: String(d.region) }),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: [
      'workspace.region.toggle \'{"region":"rail"}\'',
      'workspace.region.toggle \'{"region":"right","open":true}\'',
    ],
    handler: async (p, ctx) => {
      const t = resolveWorkspace(p, ctx);
      if (!t) return notFound("msg.workspace.notFound");
      const region = p.region as SidebarRegion;
      const result = S().toggleRegion(t.id, region, p.open as boolean | undefined);
      if (!result.ok) return result;
      // The answer waits for the frame, so a caller that reads the screen next reads the new one.
      // It waits for what it changed: a region being open is not the same as being drawn, which also
      // needs a set standing there, and waiting on the width would never end for a region a person
      // opened with nothing linked to it.
      //
      // Both regions carry `data-region`; the elements have names of their own (`rail/left`,
      // `sidebar/right`) that other readers depend on.
      await waitForDomCommit(() => {
        const element = [...document.querySelectorAll<HTMLElement>(`[data-region="${region}"]`)]
          .find((el) => el.closest<HTMLElement>("[data-workspace-plane]")?.dataset.workspacePlane === t.id);
        return element?.dataset.regionOpen === String(result.open);
      });
      if (hasContentViewHost()) await contentViewHost().chromePresentationSettled();
      return withTargets(result, { projectId: t.id });
    },
  });

  // The core holds the child processes the app spawned, and there was no listing surface — a child
  // that failed to be reclaimed was invisible from outside, so neither the user nor a tool could see
  // them pile up. Read-only observation surface.
  register("process.list", {
    description: key("cmd.process.list.desc"),
    triggers: { ko: "프로세스 목록 자식 프로세스 고아 좀비 사이드카 스폰 생존" },
    params: {
      alive: { type: "boolean", description: key("cmd.process.list.param.alive") },
      window: { type: "string", description: key("cmd.process.list.param.window") },
    },
    // The owner produces the answer — the same from whichever window it runs (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ processes: [{id, pid, window, cmd, group, alive}], count }",
    message: (d) => tmsg("msg.process.list", { n: Number(d.count ?? 0) }),
    examples: ["process.list", 'process.list \'{"alive":true}\''],
    handler: async (p) => {
      const all = (await invoke("process_list")) as Array<Record<string, unknown>>;
      const processes = all.filter(
        (r) =>
          (p.alive !== true || r.alive === true) &&
          (typeof p.window !== "string" || r.window === p.window),
      );
      return { processes, count: processes.length };
    },
  });

  // A rail tab label attaches to the view kind (viewKey) — not to one content tab, but to the tab slot
  // for that kind. So the axis of these two commands is viewKey, not tab id, and the name follows.
  register("tab.label.set", {
    description: key("cmd.tab.label.set.desc"),
    triggers: { ko: "사이드바 탭 이름변경 라벨 뷰 제목 변경" },
    params: {
      viewKey: { type: "string", description: key("cmd.tab.label.set.param.viewKey"), required: true },
      label: { type: "string", description: key("cmd.tab.label.set.param.label"), required: true },
    },
    returns: "{ viewKey, label }",
    message: (d) =>
      d.label
        ? tmsg("msg.tab.label.set.set", { label: String(d.label) })
        : tmsg("msg.tab.label.set.cleared"),
    errors: ["INVALID_PARAMS"],
    examples: [
      'tab.label.set \'{"viewKey":"soksak-plugin-<id>.<view>","label":"my label"}\'',
    ],
    handler: (p) => {
      const key = p.viewKey as string;
      useViewLabels.getState().setLabel(key, p.label as string);
      return { viewKey: key, label: useViewLabels.getState().labels[key] ?? "" };
    },
  });

  register("tab.label.get", {
    description: key("cmd.tab.label.get.desc"),
    triggers: { ko: "사이드바 탭 라벨 조회 뷰 제목" },
    params: {
      viewKey: { type: "string", description: key("cmd.tab.label.get.param.viewKey") },
    },
    returns: "{ labels } or { viewKey, label }",
    message: (d) =>
      d.labels
        ? tmsg("msg.tab.label.get.all", {
            n: Object.keys((d.labels as Record<string, unknown>) ?? {}).length,
          })
        : tmsg("msg.tab.label.get.one", { label: String(d.label ?? "") }),
    examples: ["tab.label.get", 'tab.label.get \'{"viewKey":"x.y"}\''],
    handler: (p) => {
      const labels = useViewLabels.getState().labels;
      if (p.viewKey !== undefined)
        return { viewKey: p.viewKey, label: labels[p.viewKey as string] ?? "" };
      return { labels };
    },
  });

  // How an edge sidebar takes its room, for either edge.
  //
  // There was one command for the right and none for the left. The left edge holds the same setting
  // with the same two values and defaults to `push`, so the mode a person meets first was one
  // nothing outside could read or drive — measured 2026-08-19, the left edge drew on the wrong side
  // of the window in `push` and no command could put it in the other mode to tell the two apart.
  //
  // The place is a parameter, not a command name. Two commands are two places to change one rule,
  // and the second is the one that gets forgotten.
  register("sidebar.edge.mode", {
    description: key("cmd.sidebar.edge.mode.desc"),
    triggers: { ko: "사이드바 가장자리 밀기 영역차지 오버레이 모드 도킹 좌측 우측" },
    params: {
      place: {
        type: "string",
        enum: ["left", "right"],
        description: key("cmd.sidebar.edge.mode.param.place"),
        required: true,
      },
      mode: {
        type: "string",
        enum: [...EDGE_SIDEBAR_MODES],
        description: key("cmd.sidebar.edge.mode.param.mode"),
      },
    },
    returns: "{ place, mode }",
    message: (d) =>
      tmsg("msg.sidebar.edge.mode", { place: String(d.place), mode: String(d.mode) }),
    errors: ["INVALID_PARAMS"],
    examples: [
      'sidebar.edge.mode \'{"place":"left"}\'',
      'sidebar.edge.mode \'{"place":"right","mode":"push"}\'',
    ],
    handler: (p) => {
      // The rail takes its room from the panes and holds no such setting. Accepted here, the answer
      // would be about a setting that does not exist.
      const place = p.place;
      if (place !== "left" && place !== "right") {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: tmsg("msg.sidebar.edge.placeRequired"),
        };
      }
      const s = useSettings.getState();
      const mode = p.mode;
      if (mode !== undefined) {
        if (!EDGE_SIDEBAR_MODES.includes(mode as EdgeSidebarMode)) {
          return {
            ok: false as const,
            code: "INVALID_PARAMS" as const,
            message: tmsg("msg.sidebar.edge.modeRequired", {
              modes: EDGE_SIDEBAR_MODES.join(" | "),
            }),
          };
        }
        if (place === "left") s.setLeftSidebarMode(mode as EdgeSidebarMode);
        else s.setRightSidebarMode(mode as EdgeSidebarMode);
        return { place, mode };
      }
      return { place, mode: place === "left" ? s.leftSidebarMode : s.rightSidebarMode };
    },
  });

  register("sidebar.tree", {
    description: key("cmd.sidebar.tree.desc"),
    triggers: { ko: "사이드바 레이아웃 트리 탭 분할 구조" },
    params: {
      workspace: P.workspace,
      // Read from the places themselves. Written out here, the day a place is added is the day the
      // command refuses the one thing the window grew.
      region: {
        type: "string",
        enum: [...SECTION_PLACES],
        description: key("cmd.sidebar.param.region"),
        required: true,
      },
    },
    returns: "{ projectId, region, layout }",
    message: () => tmsg("msg.sidebar.tree"),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: ['sidebar.tree \'{"region":"left"}\''],
    handler: (p, ctx) => {
      const t = resolveWorkspace(p, ctx);
      if (!t) return notFound("msg.workspace.notFound");
      const region = p.region as SidebarRegion;
      return { projectId: t.id, region, layout: serializeSidebarLayout(t.sidebarLayouts[region]) };
    },
  });

  register("rail.position", {
    description: key("cmd.rail.position.desc"),
    triggers: {
      ko: "좌측 사이드바 레일 위치 플로우 포커스 추종 핀 고정 그립 스냅",
    },
    params: {
      workspace: P.workspace,
      mode: {
        type: "string",
        description: key("cmd.rail.position.param.mode"),
        enum: ["flow", "pin"],
      },
      station: {
        type: "number",
        description: key("cmd.rail.position.param.station"),
      },
    },
    returns:
      "{ projectId, railPosition:{ mode, station?(persisted), effectiveStation, cleanLines[] } }",
    message: () => tmsg("msg.rail.position"),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: [
      "rail.position",
      'rail.position \'{"mode":"pin"}\'',
      'rail.position \'{"mode":"pin","station":50}\'',
      'rail.position \'{"mode":"flow"}\'',
    ],
    handler: (p, ctx) => {
      const t = resolveWorkspace(p, ctx);
      if (!t) return notFound("msg.workspace.notFound");

      const mode = p.mode as "flow" | "pin" | undefined;
      const requested = p.station as number | undefined;
      if (mode === undefined) {
        if (requested !== undefined) {
          return {
            ok: false as const,
            code: "INVALID_PARAMS",
            message: tmsg("msg.rail.position.stationNeedsPin"),
          };
        }
        return {
          projectId: t.id,
          railPosition: serializeRailPosition(t),
        };
      }

      if (mode === "flow") {
        if (requested !== undefined) {
          return {
            ok: false as const,
            code: "INVALID_PARAMS",
            message: tmsg("msg.rail.position.flowNoStation"),
          };
        }
        const changed = S().setLeftRailPlacement(t.id, { mode: "flow" });
        if (!changed.ok) return changed;
      } else {
        if (
          requested !== undefined &&
          (!Number.isFinite(requested) || requested < 0 || requested > 100)
        ) {
          return {
            ok: false as const,
            code: "INVALID_PARAMS",
            message: tmsg("msg.rail.position.stationRange"),
          };
        }
        const current = serializeRailPosition(t);
        const station = snapRailStation(
          current.cleanLines,
          requested ?? current.effectiveStation,
        );
        const changed = S().setLeftRailPlacement(t.id, {
          mode: "pin",
          station,
        });
        if (!changed.ok) return changed;
      }

      const updated = S().workspaces.find((item) => item.id === t.id);
      if (!updated) return notFound("msg.workspace.notFound");
      return {
        projectId: updated.id,
        railPosition: serializeRailPosition(updated),
      };
    },
  });

  register("sidebar.move", {
    description: key("cmd.sidebar.move.desc"),
    triggers: { ko: "좌측 사이드바 탭 이동 합치기 분할 드래그 머지" },
    params: {
      workspace: P.workspace,
      // Read from the places themselves. Written out here, the day a place is added is the day the
      // command refuses the one thing the window grew.
      region: {
        type: "string",
        enum: [...SECTION_PLACES],
        description: key("cmd.sidebar.param.region"),
        required: true,
      },
      viewKey: { type: "string", description: key("cmd.sidebar.move.param.viewKey"), required: true },
      target: { type: "string", description: key("cmd.sidebar.move.param.target"), required: true },
      zone: {
        type: "string",
        description: key("cmd.sidebar.move.param.zone"),
        enum: ["into", "left", "right", "top", "bottom"],
        required: true,
      },
    },
    returns: "{ projectId }",
    message: () => tmsg("msg.sidebar.move"),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: [
      'sidebar.move \'{"region":"left","viewKey":"soksak-plugin-<id>.<view>","target":"soksak-plugin-<other-id>.<view>","zone":"right"}\'',
    ],
    handler: (p, ctx) => {
      const t = resolveWorkspace(p, ctx);
      if (!t) return notFound("msg.workspace.notFound");
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
      return withTargets(S().moveSidebarView(t.id, p.region as SidebarRegion, p.viewKey as string, drop), {
        projectId: t.id,
      });
    },
  });

  // The width of a place, read and set by name.
  //
  // A drag was the one layout change with no numeric handle: the width followed the pointer and
  // nothing outside could read it or set it, so "the sidebar drag stutters and the document and the
  // native layer come apart" could not be measured at all (L10).
  register("sidebar.width", {
    description: key("cmd.sidebar.width.desc"),
    triggers: { ko: "사이드바 폭 너비 드래그 크기 좌측 레일 우측" },
    params: {
      place: {
        type: "string",
        enum: [...SECTION_PLACES],
        description: key("cmd.sidebar.param.region"),
        required: true,
      },
      width: { type: "number", description: key("cmd.sidebar.width.param.width") },
    },
    returns: "{ place, width, min, max }",
    message: (d) =>
      tmsg("msg.sidebar.width", { place: String(d.place), width: Number(d.width ?? 0) }),
    errors: ["INVALID_PARAMS"],
    examples: ['sidebar.width \'{"place":"rail"}\'', 'sidebar.width \'{"place":"left","width":320}\''],
    handler: async (p) => {
      const place = p.place as SectionPlace;
      if (!(SECTION_PLACES as readonly string[]).includes(place)) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: tmsg("msg.sidebar.width.placeRequired", { places: SECTION_PLACES.join(" | ") }),
        };
      }
      const bounds = PLACE_WIDTH_BOUNDS[place];
      const width = p.width as number | undefined;
      if (width !== undefined) {
        // The same bounds a drag is clamped to. Accepted past them, this sets a width no pointer can
        // produce, and then the reading is of a state nobody can reach.
        if (!widthWithinBounds(place, width)) {
          return {
            ok: false as const,
            code: "INVALID_PARAMS" as const,
            message: tmsg("msg.sidebar.width.outOfBounds", {
              min: bounds.min,
              max: bounds.max,
              width,
            }),
          };
        }
        setPlaceWidth(place, width);
        // One caller, one width, so it is written down here — a drag writes at the end of the
        // gesture instead, because a synchronous disk write per frame stalls it.
        persistPlaceWidth(place);
        // The answer waits for the frame, so a caller reading the screen next reads the new one —
        // and only while the place is standing. A place with no set standing in it is zero wide by
        // rule, so waiting for the element to be this wide waits for something that will never
        // happen: measured 2026-08-19, every call in a window like that took the full two-second
        // timeout, and the reading taken from it was of the timeout rather than of the window.
        const element = () => document.querySelector<HTMLElement>(`[data-region="${place}"]`);
        const standing = Math.round(element()?.getBoundingClientRect().width ?? 0) > 0;
        if (standing) {
          await waitForDomCommit(
            () => Math.round(element()?.getBoundingClientRect().width ?? -1) === Math.round(width),
          );
        }
      }
      return { place, width: placeWidth(place), min: bounds.min, max: bounds.max };
    },
  });

  register("sidebar.resize", {
    description: key("cmd.sidebar.resize.desc"),
    triggers: { ko: "좌측 사이드바 분할 비율 크기 조절" },
    params: {
      workspace: P.workspace,
      // Read from the places themselves. Written out here, the day a place is added is the day the
      // command refuses the one thing the window grew.
      region: {
        type: "string",
        enum: [...SECTION_PLACES],
        description: key("cmd.sidebar.param.region"),
        required: true,
      },
      viewKey: {
        type: "string",
        description: key("cmd.sidebar.resize.param.viewKey"),
        required: true,
      },
      sizes: { type: "number[]", description: key("cmd.sidebar.resize.param.sizes"), required: true },
    },
    returns: "{ projectId, sizes }",
    message: () => tmsg("msg.sidebar.resize"),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: [
      'sidebar.resize \'{"region":"left","viewKey":"soksak-plugin-<id>.<view>","sizes":[0.6,0.4]}\'',
    ],
    handler: (p, ctx) => {
      const t = resolveWorkspace(p, ctx);
      if (!t) return notFound("msg.workspace.notFound");
      const key = p.viewKey as string;
      const region = p.region as SidebarRegion;
      const splitId = sidebarSplitIdOf(t.sidebarLayouts[region], key);
      if (!splitId) {
        return notFound("msg.sidebar.resize.notSplit", { key });
      }
      const sizes = p.sizes as number[];
      const r = S().resizeSidebar(t.id, region, splitId, sizes);
      return r.ok ? { projectId: t.id, sizes } : r;
    },
  });

  // ----- space -----
  register("space.list", {
    description: key("cmd.space.list.desc"),
    params: { workspace: P.workspace },
    returns: "{ projectId, spaces: [{id,title,active}] }",
    message: (d) => tmsg("msg.space.list", { n: ((d.spaces as unknown[]) ?? []).length }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["space.list"],
    handler: (p, ctx) => {
      const t = resolveWorkspace(p, ctx);
      if (!t) return notFound("msg.workspace.notFound");
      return {
        projectId: t.id,
        spaces: t.spaces.map((c) => ({
          id: c.id,
          title: c.title,
          active: c.id === t.activeSpaceId,
        })),
      };
    },
  });

  register("space.create", {
    description: key("cmd.space.create.desc"),
    triggers: { ko: "새 탭 스페이스 탭 추가 새로 열기" },
    params: { workspace: P.workspace, program: P.program },
    returns: "{ projectId, spaceId, paneId, tabId? }",
    message: () => tmsg("msg.space.create"),
    errors: ["TARGET_NOT_FOUND"],
    hint: (d) => {
      // A new space becomes the active space, so follow-up moves target the context as is (no target id needed).
      if (d.code) return [];
      return [
        { cmd: "pane.split right", why: tmsg("hint.flow.space.create.split") },
        { cmd: `tab.open ${exampleProgramId()}`, why: tmsg("hint.flow.space.create.view") },
        { cmd: "window.snapshot", why: tmsg("hint.flow.space.create.snapshot") },
      ];
    },
    examples: ['space.create \'{"program":"browser"}\''],
    handler: (p, ctx) => {
      const t = resolveWorkspace(p, ctx);
      if (!t) return notFound("msg.workspace.notFound");
      const r = S().addContent(t.id, p.program as Program | undefined);
      if (!r.ok) return r;
      return {
        projectId: t.id,
        spaceId: r.contentId,
        paneId: r.groupId,
        tabId: r.viewId,
      };
    },
  });

  register("space.close", {
    danger: "destructive",
    description: key("cmd.space.close.desc"),
    triggers: { ko: "탭 닫기 스페이스 닫기" },
    params: {
      workspace: P.workspace,
      space: { ...P.space, required: true },
    },
    returns: "{ projectId, spaceId(closed), activeSpaceId }",
    message: () => tmsg("msg.space.close"),
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['space.close \'{"space":"spc-d5e6f7"}\''],
    handler: (p, ctx) => {
      const t = resolveWorkspace(p, ctx);
      if (!t) return notFound("msg.workspace.notFound");
      return withTargets(S().closeContent(t.id, p.space as string), {
        projectId: t.id,
        spaceId: p.space as string,
      });
    },
  });

  const switchScanParams = () => ({
    frames: { type: "number" as const, description: key("cmd.space.switchScan.param.frames") },
    intervalMs: { type: "number" as const, description: key("cmd.space.switchScan.param.intervalMs") },
    applyAtFrame: { type: "number" as const, description: key("cmd.space.switchScan.param.applyAtFrame") },
    region: { type: "json" as const, description: key("cmd.space.switchScan.param.region") },
    threshold: { type: "number" as const, description: key("cmd.space.switchScan.param.threshold") },
  });
  const switchScanSettings = (params: Record<string, unknown>): {
    frames: number;
    intervalMs: number;
    applyAtFrame: number;
    region: SwitchScanRegion;
    threshold: number;
  } | null => {
    const frames = (params.frames as number | undefined) ?? 30;
    const intervalMs = (params.intervalMs as number | undefined) ?? 16;
    const applyAtFrame = (params.applyAtFrame as number | undefined) ?? 4;
    const region = (params.region as SwitchScanRegion | undefined) ?? {
      x0: 0.23,
      y0: 0.1,
      x1: 0.99,
      y1: 0.96,
    };
    const threshold = (params.threshold as number | undefined) ?? 0.003;
    if (!validWindowRecordFrames(frames)
        || frames < 3
        || !validWindowRecordIntervalMs(intervalMs)
        || !Number.isSafeInteger(applyAtFrame)
        || applyAtFrame < 0
        || applyAtFrame >= frames - 1
        || !Number.isFinite(threshold)
        || threshold < 0
        || threshold > 1
        || !region
        || ![region.x0, region.y0, region.x1, region.y1].every(Number.isFinite)
        || region.x0 < 0
        || region.y0 < 0
        || region.x1 > 1
        || region.y1 > 1
        || region.x0 >= region.x1
        || region.y0 >= region.y1) {
      return null;
    }
    return { frames, intervalMs, applyAtFrame, region, threshold };
  };
  const layoutSequence = (): number => layoutTransitionJournal().reduce(
    (maximum, entry) => Math.max(maximum, entry.sequence),
    0,
  );
  const committedLayoutTransaction = async (
    causeTraceId: string,
    afterSequence: number,
  ): Promise<SwitchScanLayoutTransaction> => {
    const receipt = await waitForLayoutTransaction({
      causeTraceId,
      afterSequence,
      timeoutMs: 15_000,
    });
    if (receipt.entry.phase !== "committed") {
      throw new Error(`layout transaction ${receipt.entry.transactionId} ${receipt.entry.phase}`);
    }
    return {
      transactionId: receipt.entry.transactionId,
      sequence: receipt.entry.sequence,
      phase: "committed",
    };
  };
  const waitForTabPresentationCommit = async (viewId: string): Promise<void> => {
    const node = (): HTMLElement | undefined => [...document.querySelectorAll<HTMLElement>(
      '[data-node^="layout/tab/"]',
    )].find((candidate) => candidate.dataset.node === `layout/tab/${viewId}`);
    await waitForDomCommit(() => node()?.dataset.contentVisible === "true");
  };
  const activateForSwitchScan = async (
    command: "space.activate" | "tab.activate",
    params: Record<string, unknown>,
    ctx: CommandContext,
    causeTraceId: string,
  ): Promise<SwitchScanActivationReceipt> => {
    const afterSequence = layoutSequence();
    const activated = await execute(
      command,
      { ...params, causeTraceId },
      { ...ctx, origin: "switch-scan" },
    );
    if (!activated.ok) {
      throw new Error(`${command} ${activated.code}: ${activated.message}`);
    }
    if (command === "space.activate") {
      if (activated.data?.moved !== true) {
        throw new Error(`${command} did not change the active space`);
      }
      return {
        changed: true,
        layoutMoved: true,
        presentation: {
          kind: "space",
          id: String(params.space),
          phase: "dom-committed",
        },
        transaction: await committedLayoutTransaction(causeTraceId, afterSequence),
      };
    }
    if (activated.data?.changed !== true) {
      throw new Error(`${command} did not change the active tab`);
    }
    const layoutMoved = activated.data.layoutMoved === true;
    const transaction = layoutMoved
      ? await committedLayoutTransaction(causeTraceId, afterSequence)
      : null;
    const viewId = String(params.tab);
    await waitForTabPresentationCommit(viewId);
    return {
      changed: true,
      layoutMoved,
      presentation: { kind: "tab", id: viewId, phase: "dom-committed" },
      transaction,
    };
  };
  const visibleSpaceViews = (space: Space): string[] => {
    if (space.maximizedTabId) return [space.maximizedTabId];
    return allGroups(space.layout)
      .map((pane) => pane.tabs.find((view) => view.id === pane.activeTabId)?.id)
      .filter((view): view is string => typeof view === "string");
  };
  const switchScanDir = async (): Promise<string> => {
    const { tempDir, join } = frameworkPath;
    return join(await tempDir(), "soksak", `switchscan-${crypto.randomUUID()}`);
  };

  register("space.activate", {
    description: key("cmd.space.activate.desc"),
    triggers: { ko: "탭 이동 탭 전환 탭 바꾸기" },
    params: {
      workspace: P.workspace,
      space: { ...P.space, required: true },
      causeTraceId: { type: "string", description: key("cmd.space.activate.param.causeTraceId") },
    },
    returns: "{ projectId, spaceId, moved, causeTraceId? }",
    message: () => tmsg("msg.space.activate"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['space.activate \'{"space":"spc-d5e6f7"}\''],
    handler: (p, ctx) => {
      const t = resolveWorkspace(p, ctx);
      if (!t) return notFound("msg.workspace.notFound");
      const causeTraceId = p.causeTraceId as string | undefined;
      if (causeTraceId !== undefined && causeTraceId.length === 0) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.cause.empty") };
      }
      const moved = t.activeSpaceId !== p.space;
      if (moved && causeTraceId !== undefined) declareLayoutCause(causeTraceId);
      const done = S().setActiveContent(t.id, p.space as string);
      if (!done.ok) return done;
      return {
        ...done,
        projectId: t.id,
        spaceId: p.space as string,
        moved,
        ...(moved && causeTraceId !== undefined ? { causeTraceId } : {}),
      };
    },
  });

  register("space.switchScan", {
    description: key("cmd.space.switchScan.desc"),
    triggers: { ko: "탭 전환 측정 깜빡임 jank 스페이스 전환 검사 단일프레임" },
    params: {
      workspace: P.workspace,
      to: { ...P.space, required: true },
      from: {
        type: "string",
        description: key("cmd.space.switchScan.param.from"),
      },
      ...switchScanParams(),
    },
    returns:
      "{ projectId, fromSpaceId, spaceId, frames, frameMs, switchFrame, switchFrames, flickerFrames, blankFrames, overlapFrames, nativeMismatchFrames, clean, diffsPct, presentationFrames, activation, recordingDir }",
    message: (d) =>
      d.clean
        ? tmsg("msg.space.switchScan.clean")
        : tmsg("msg.space.switchScan.jank", { n: Number(d.switchFrames) }),
    examples: [
      'space.switchScan \'{"from":"spc-d5e6f7","to":"spc-h2j3k4"}\'',
      'space.switchScan \'{"to":"spc-h2j3k4","frames":40}\'',
    ],
    handler: async (p, ctx) => {
      const t = resolveWorkspace(p, ctx);
      if (!t) return notFound("msg.workspace.notFound");
      const settings = switchScanSettings(p);
      if (!settings) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.switchScan.invalid") };
      }
      const original = t.activeSpaceId;
      const to = p.to as string;
      const from = (p.from as string | undefined) ?? original;
      const fromSpace = t.spaces.find((space) => space.id === from);
      const toSpace = t.spaces.find((space) => space.id === to);
      if (!fromSpace || !toSpace) return notFound("msg.space.notFound", { id: !fromSpace ? from : to });
      if (from === to) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.switchScan.sameTarget") };
      }
      if (original !== from) {
        await activateForSwitchScan(
          "space.activate",
          { workspace: t.id, space: from },
          ctx,
          `switch-scan-start-${crypto.randomUUID()}`,
        );
      }
      try {
        const scanned = await runSwitchScan({
          dir: await switchScanDir(),
          ...settings,
          fromViews: visibleSpaceViews(fromSpace),
          toViews: visibleSpaceViews(toSpace),
          activate: () => activateForSwitchScan(
            "space.activate",
            { workspace: t.id, space: to },
            ctx,
            `switch-scan-target-${crypto.randomUUID()}`,
          ),
        });
        return { projectId: t.id, fromSpaceId: from, spaceId: to, ...scanned };
      } finally {
        const current = S().workspaces.find((workspace) => workspace.id === t.id)?.activeSpaceId;
        if (current !== original) {
          await activateForSwitchScan(
            "space.activate",
            { workspace: t.id, space: original },
            ctx,
            `switch-scan-restore-${crypto.randomUUID()}`,
          );
        }
      }
    },
  });

  register("space.rename", {
    description: key("cmd.space.rename.desc"),
    params: {
      workspace: P.workspace,
      space: { ...P.space, required: true },
      title: { type: "string", description: key("cmd.space.rename.param.title"), required: true },
    },
    returns: "{ projectId, spaceId }",
    message: () => tmsg("msg.space.rename"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['space.rename \'{"space":"spc-d5e6f7","title":"build"}\''],
    handler: (p, ctx) => {
      const t = resolveWorkspace(p, ctx);
      if (!t) return notFound("msg.workspace.notFound");
      return withTargets(
        S().renameContent(t.id, p.space as string, p.title as string),
        { projectId: t.id, spaceId: p.space as string },
      );
    },
  });

  // ----- pane -----
  register("pane.list", {
    description: key("cmd.pane.list.desc"),
    params: { workspace: P.workspace, space: P.space },
    returns:
      "{ projectId, spaceId, activePaneId, layout, canonicalLayout, projection, railRelation:{boundTabId,boundPaneId,relationId,placement,connected,side:left|right|detached,borderMode:union|independent|none,pathCount:1|2|0}, panes[] }",
    message: (d) => tmsg("msg.pane.list", { n: ((d.panes as unknown[]) ?? []).length }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["pane.list"],
    handler: (p, ctx) => {
      const t = resolveWorkspace(p, ctx);
      if (!t) return notFound("msg.workspace.notFound");
      const c = p.space
        ? t.spaces.find((x) => x.id === p.space)
        : (resolveCtx(ctx)?.space ??
          t.spaces.find((x) => x.id === t.activeSpaceId));
      if (!c) return notFound("msg.space.notFoundId", { id: String(p.space) });
      const arrangement =
        c.id === t.activeSpaceId ? projectArrangement(t) : null;
      const out = serializeSpace(
        c,
        t.activeSpaceId,
        arrangement,
        t.regionOpen.rail,
        (t.railPlacement ?? DEFAULT_RAIL_PLACEMENT).mode,
      );
      return {
        projectId: t.id,
        spaceId: c.id,
        activePaneId: out.activePaneId,
        layout: out.layout,
        canonicalLayout: out.canonicalLayout,
        projection: out.projection,
        railRelation: out.railRelation,
        panes: out.panes,
      };
    },
  });

  // A split that cannot be drawn is refused instead of performed.
  //
  // The .pane rule takes --pane-inset off both edges of a cell, so a cell narrower than the inset pair
  // has no interior: CSS clamps the negative width to 0, and the screen no longer shows the tree.
  //
  // Every resulting cell is checked, not the target alone. A split inserts a sibling and equalSizes
  // redistributes the whole row, so the cell that runs out of room is usually one nobody touched.
  // Measured 2026-08-16: checking only the halved target let a 999px space reach panes at 0.2% declared
  // width, drawn at 0, with layout.verify reporting 10.4px of difference across 6 panes.
  //
  // splitAtGroup is the same function the store applies — the rule is reused here, not restated.
  //
  // The floor is a measurement, never an assumption: with nothing on screen — headless, or before the
  // first paint — the split goes through, because a refusal there would be a guess. The rail is not in
  // the arithmetic either; it only ever takes width away, so a cell that spans the station can still be
  // clamped, and layout.verify is what reports that.
  const splitFloor = (workspaceId: string, paneId: string, side: Side): CmdErr | null => {
    const t = S().workspaces.find((w) => w.id === workspaceId);
    const space = t?.spaces.find((c) => c.id === t.activeSpaceId);
    if (!space) return null;
    const host = document.querySelector<HTMLElement>(`[data-node="layout/space/${space.id}"]`);
    if (!host) return null;
    const inset = Number.parseFloat(getComputedStyle(host).getPropertyValue("--pane-inset"));
    if (!Number.isFinite(inset)) return null;
    const box = host.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;

    const placeholder = { id: "pan-floor", activeTabId: undefined, tabs: [] } as unknown as Pane;
    const { cells } = computeSplitLayout(splitAtGroup(space.layout, paneId, side, placeholder));
    // The rail is inserted into the row: every cell keeps its percentage and loses pixels in
    // proportion, so the row is narrower than the space box by the rail's whole width. Leaving it
    // out reads a row 160px wider than the one on screen — measured 2026-08-16, a single pane in a
    // 999px space with the rail open was 827px, which is 999 less 160 of rail and 12 of inset pair.
    const rowWidth = box.width - railWidthOf(space.layout, host);
    const floor = inset * 2;
    let tightest = Infinity;
    for (const cell of cells) {
      tightest = Math.min(
        tightest,
        (rowWidth * cell.rect.width) / 100,
        (box.height * cell.rect.height) / 100,
      );
    }
    if (tightest > floor) return null;
    return err(
      "TOO_SMALL",
      tmsg("msg.pane.split.tooSmall", {
        along: String(Math.round(tightest * 10) / 10),
        floor: String(Math.round(floor)),
      }),
    );
  };

  // What the rail takes out of the row, in pixels, read from a pane that is already drawn.
  //
  // A pane holds its own share in --rail-dw, which the projection sets to -(width/100) of the
  // rail width. Dividing that share back out gives the whole, and every cell in the row loses the
  // same proportion. Reading it from the pane rather than hunting for the rail element keeps this
  // from depending on a second node's address.
  //
  // Zero when the rail is closed, when no pane is drawn yet, or when the pane's declared width is
  // zero — all three are "nothing measurable", and guessing a width there would refuse splits that
  // are fine.
  const railWidthOf = (layout: PaneNode, host: HTMLElement): number => {
    for (const cell of computeSplitLayout(layout).cells) {
      const el = host.querySelector<HTMLElement>(`[data-node="layout/pane/${cell.value.id}"]`);
      if (!el) continue;
      const share = Number.parseFloat(getComputedStyle(el).getPropertyValue("--rail-dw"));
      if (!Number.isFinite(share)) continue;
      if (share === 0 || cell.rect.width <= 0) continue;
      return (-share * 100) / cell.rect.width;
    }
    return 0;
  };

  register("pane.split", {
    description: key("cmd.pane.split.desc"),
    triggers: { ko: "칸 나누기 분할 화면 분할 옆에 열기 나란히" },
    params: {
      workspace: P.workspace,
      pane: P.pane,
      side: { ...P.side, required: true },
      program: P.program,
      mountTimeoutMs: {
        type: "number",
        description: key("cmd.pane.split.param.mountTimeoutMs"),
      },
    },
    returns:
      "{ projectId, paneId(new pane), tabId?, arrangement:{station,switched,cleanLines[],cells[]} }",
    message: () => tmsg("msg.pane.split"),
    errors: ["TARGET_NOT_FOUND", "TOO_SMALL"],
    hint: (d) => {
      if (d.code) return [];
      const out: CommandHint[] = [];
      const pane = d.paneId as string | undefined;
      // More programs can be opened as tabs in the newly created pane — target that pane explicitly.
      if (pane)
        out.push({
          cmd: `tab.open '{"pane":"${pane}","program":"${exampleProgramId()}"}'`,
          why: tmsg("hint.flow.pane.split.view"),
        });
      out.push({ cmd: "window.snapshot", why: tmsg("hint.flow.pane.split.snapshot") });
      return out;
    },
    examples: ['pane.split \'{"side":"right"}\'', 'pane.split \'{"side":"bottom","program":"browser"}\''],
    handler: async (p, ctx) => {
      const loc = resolvePane(p, ctx);
      if (!loc) return notFound("msg.pane.notFound");
      const wall = splitFloor(loc.workspace.id, loc.pane.id, p.side as Side);
      if (wall) return wall;
      const r = S().splitWithNewView(
        loc.workspace.id,
        loc.pane.id,
        p.side as Side,
        p.program as Program,
      );
      if (!r.ok) return r;
      const openedViewId = r.viewId;
      let ready: boolean | undefined;
      if (openedViewId) {
        const timeout = typeof p.mountTimeoutMs === "number"
          ? Math.max(0, p.mountTimeoutMs)
          : 5000;
        ready = timeout > 0 ? await awaitViewMounted(openedViewId, timeout) : false;
      }
      return withArrangement(loc.workspace.id, {
        projectId: loc.workspace.id,
        paneId: r.groupId,
        tabId: r.viewId,
        ...(ready === undefined ? {} : { mounted: ready }),
      });
    },
  });

  register("pane.merge", {
    description: key("cmd.pane.merge.desc"),
    triggers: { ko: "칸 합치기 병합 탭 이동 합병" },
    params: {
      workspace: P.workspace,
      src: { type: "string", description: key("cmd.pane.merge.param.src"), required: true },
      dst: { type: "string", description: key("cmd.pane.merge.param.dst"), required: true },
    },
    returns: "{ projectId, paneId(merged pane) }",
    message: () => tmsg("msg.pane.merge"),
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['pane.merge \'{"src":"pan-p2q3r4","dst":"pan-g2h3j4"}\''],
    handler: (p, ctx) => {
      const loc = locatePane(p.src as string) ?? resolvePane(p, ctx);
      if (!loc) return notFound("msg.pane.notFoundId", { id: String(p.src) });
      const r = S().moveGroupToGroup(
        loc.workspace.id,
        p.src as string,
        p.dst as string,
        "center",
      );
      if (!r.ok) return r;
      return withArrangement(loc.workspace.id, {
        projectId: loc.workspace.id,
        paneId: r.groupId,
      });
    },
  });

  register("pane.move", {
    description: key("cmd.pane.move.desc"),
    triggers: { ko: "칸 이동 재배치 위치 옮기기" },
    params: {
      workspace: P.workspace,
      src: { type: "string", description: key("cmd.pane.move.param.src"), required: true },
      dst: { type: "string", description: key("cmd.pane.move.param.dst"), required: true },
      zone: { ...P.zone, required: true },
    },
    returns: "{ projectId, paneId }",
    message: () => tmsg("msg.pane.move"),
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['pane.move \'{"src":"pan-p2q3r4","dst":"pan-g2h3j4","zone":"left"}\''],
    handler: (p) => {
      const loc = locatePane(p.src as string);
      if (!loc) return notFound("msg.pane.notFoundId", { id: String(p.src) });
      const r = S().moveGroupToGroup(
        loc.workspace.id,
        p.src as string,
        p.dst as string,
        p.zone as DropZone,
      );
      if (!r.ok) return r;
      return withArrangement(loc.workspace.id, {
        projectId: loc.workspace.id,
        paneId: r.groupId,
      });
    },
  });

  register("pane.close", {
    danger: "destructive",
    description: key("cmd.pane.close.desc"),
    triggers: { ko: "칸 닫기 칸 제거" },
    params: { pane: { ...P.pane, required: true } },
    returns: "{ paneId(closed), activePaneId }",
    message: () => tmsg("msg.pane.close"),
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['pane.close \'{"pane":"pan-p2q3r4"}\''],
    handler: (p) => {
      const loc = locatePane(p.pane as string);
      if (!loc) return notFound("msg.pane.notFoundId", { id: String(p.pane) });
      return withArrangement(
        loc.workspace.id,
        withTargets(S().closeGroup(loc.workspace.id, p.pane as string), {
          paneId: p.pane as string,
        }),
      );
    },
  });

  register("pane.activate", {
    description: key("cmd.pane.activate.desc"),
    triggers: { ko: "칸 포커스 칸 활성화 선택" },
    params: { pane: { ...P.pane, required: true } },
    returns: "{ paneId }",
    message: () => tmsg("msg.pane.activate"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['pane.activate \'{"pane":"pan-p2q3r4"}\''],
    handler: (p) => {
      const loc = locatePane(p.pane as string);
      if (!loc) return notFound("msg.pane.notFoundId", { id: String(p.pane) });
      const echo = { paneId: p.pane as string };
      if (!loc.pane.activeTabId)
        return withTargets(S().setActiveGroup(loc.workspace.id, p.pane as string), echo);
      return withTargets(
        transferViewFocus(activeSessionViewId(), loc.pane.activeTabId, () =>
          S().setActiveGroup(loc.workspace.id, p.pane as string),
        ),
        echo,
      );
    },
  });

  register("pane.resize", {
    description: key("cmd.pane.resize.desc"),
    triggers: { ko: "칸 크기 조절 비율 골 조정 크기 바꾸기 경계 끌기" },
    params: {
      pane: P.pane,
      edge: { ...P.edge, required: true },
      ratio: {
        type: "number",
        description: key("cmd.pane.resize.param.ratio"),
        required: true,
      },
    },
    returns: "{ paneId, gutter:{pane,edge}(canonical), sizes }",
    message: () => tmsg("msg.pane.resize"),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: [
      'pane.resize \'{"edge":"right","ratio":0.7}\'',
      'pane.resize \'{"pane":"pan-g2h3j4","edge":"bottom","ratio":0.35}\'',
    ],
    handler: (p, ctx) => {
      const loc = resolvePane(p, ctx);
      if (!loc) return notFound("msg.pane.notFound");
      const edge = p.edge as GutterSide;
      if (!EDGES.includes(edge)) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: `edge: ${EDGES.join(" | ")}`,
        };
      }
      const ratio = p.ratio as number;
      if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: tmsg("msg.pane.resize.ratioRange"),
        };
      }
      const layout = loc.space.layout;
      const gutter = resolveGutter(layout, loc.pane.id, edge, paneIdOf);
      const current = gutter ? splitSizesOf(layout, gutter.splitId) : null;
      if (!gutter || !current) {
        return notFound("msg.pane.noGutter", { pane: loc.pane.id, edge });
      }
      const sizes = [...current];
      const pair = sizes[gutter.index] + sizes[gutter.index + 1];
      // One gutter moves only the two neighbouring slots (that is what dragging a gutter does) — the
      // rest stay unchanged. A gutter named by left/top is the preceding sibling's forward gutter, so
      // the requested pane is in the trailing slot.
      sizes[gutter.index] = isCanonicalSide(edge) ? pair * ratio : pair * (1 - ratio);
      sizes[gutter.index + 1] = pair - sizes[gutter.index];
      const r = S().resizeSplit(loc.workspace.id, gutter.splitId, sizes);
      return r.ok
        ? {
            paneId: loc.pane.id,
            gutter: gutterEcho(layout, loc.pane.id, edge),
            sizes,
          }
        : r;
    },
  });

  register("pane.equalize", {
    description: key("cmd.pane.equalize.desc"),
    triggers: { ko: "칸 균등 같은 크기 반반 균등화" },
    params: {
      pane: P.pane,
      edge: { ...P.edge, required: true },
      all: {
        type: "boolean",
        description: key("cmd.pane.equalize.param.all"),
      },
    },
    returns: "{ paneId, gutter:{pane,edge}(canonical), sizes }",
    message: () => tmsg("msg.pane.equalize"),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: [
      'pane.equalize \'{"edge":"right"}\'',
      'pane.equalize \'{"pane":"pan-g2h3j4","edge":"bottom","all":true}\'',
    ],
    handler: (p, ctx) => {
      const loc = resolvePane(p, ctx);
      if (!loc) return notFound("msg.pane.notFound");
      const edge = p.edge as GutterSide;
      if (!EDGES.includes(edge)) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: `edge: ${EDGES.join(" | ")}`,
        };
      }
      const layout = loc.space.layout;
      const gutter = resolveGutter(layout, loc.pane.id, edge, paneIdOf);
      const current = gutter ? splitSizesOf(layout, gutter.splitId) : null;
      if (!gutter || !current) {
        return notFound("msg.pane.noGutter", { pane: loc.pane.id, edge });
      }
      const sizes = [...current];
      if (p.all === true) {
        sizes.fill(1 / sizes.length);
      } else {
        const half = (sizes[gutter.index] + sizes[gutter.index + 1]) / 2;
        sizes[gutter.index] = half;
        sizes[gutter.index + 1] = half;
      }
      const r = S().resizeSplit(loc.workspace.id, gutter.splitId, sizes);
      return r.ok
        ? {
            paneId: loc.pane.id,
            gutter: gutterEcho(layout, loc.pane.id, edge),
            sizes,
          }
        : r;
    },
  });

  register("layout.apply", {
    description: key("cmd.layout.apply.desc"),
    triggers: { ko: "화면 구성 레이아웃 적용 스페이스 배치 나란히 배치" },
    params: {
      spaces: {
        type: "json",
        required: true,
        description: key("cmd.layout.apply.param.spaces"),
      },
      workspace: P.workspace,
    },
    returns:
      "{ projectId, spaces: [{ spaceId, title, panes: [{ paneId, program }] }], skipped? } — skipped lists panes dropped because their program is missing",
    message: (d) => tmsg("msg.layout.apply", { n: ((d.spaces as unknown[]) ?? []).length }),
    errors: ["INVALID_PARAMS", "TARGET_NOT_FOUND"],
    hint: (d) => {
      if (d.code) return [];
      const out: CommandHint[] = [];
      const spaces = (d.spaces as { spaceId?: string }[] | undefined) ?? [];
      const skipped = (d.skipped as unknown[] | undefined) ?? [];
      // When panes were skipped (browser not installed etc.), offer the install path first.
      if (skipped.length)
        out.push({ cmd: "plugin.catalog", why: tmsg("hint.flow.layout.apply.install") });
      const first = spaces[0]?.spaceId;
      if (first)
        out.push({ cmd: `space.activate ${first}`, why: tmsg("hint.flow.layout.apply.activate") });
      out.push({ cmd: "window.snapshot", why: tmsg("hint.flow.layout.apply.snapshot") });
      return out;
    },
    examples: [
      `layout.apply '{"spaces":[{"title":"docs","panes":[{"program":"${exampleProgramId()}"}]}]}'`,
    ],
    handler: (p, ctx) => {
      const t = resolveWorkspace(p, ctx);
      if (!t) return notFound("msg.workspace.notFound");
      const skipped: {
        space: string;
        program: string;
        side?: Side;
        reason: string;
      }[] = [];
      let spaceSpecs: LayoutSpaceSpec[];
      {
        // The spaces the caller named, as they were named.
        //
        // A `dev` preset stood beside this until 2026-08-16: a terminal and a browser side by side,
        // The caller defines a working layout by passing each program.
        const raw = p.spaces;
        if (!Array.isArray(raw) || raw.length === 0) {
          return {
            ok: false as const,
            code: "INVALID_PARAMS" as const,
            message: tmsg("msg.layout.apply.facetsNeedSpaces"),
          };
        }
        spaceSpecs = raw as LayoutSpaceSpec[];
      }
      const builtSpaces: {
        spaceId: string;
        title: string;
        panes: { paneId: string; program: string }[];
      }[] = [];
      for (const spec of spaceSpecs) {
        const title = typeof spec.title === "string" ? spec.title : "";
        // New space (empty) — created without a program so the first pane is controlled explicitly. Existing spaces are unchanged.
        const created = S().addContent(t.id);
        if (!created.ok) continue; // Unreachable after the workspace check — defensive.
        const spaceId = created.contentId;
        const firstPaneId = created.groupId;
        if (title) S().renameContent(t.id, spaceId, title);
        const builtPanes: { paneId: string; program: string }[] = [];
        let firstFilled = false;
        for (const pane of spec.panes ?? []) {
          const program = pane.program;
          if (typeof program !== "string" || !getRegisteredProgram(program)) {
            skipped.push({
              space: title || spaceId,
              program: String(program),
              side: pane.side,
              reason: tmsg("layout.skip.unregistered", { program: String(program) }),
            });
            continue;
          }
          if (!firstFilled) {
            // First pane = put the tab into the space's initial (empty) pane.
            S().addViewToGroup(t.id, program, firstPaneId);
            builtPanes.push({ paneId: firstPaneId, program });
            firstFilled = true;
          } else {
            // Later panes = create a split next to the first pane.
            const r = S().splitWithNewView(t.id, firstPaneId, pane.side ?? "right", program);
            if (r.ok) builtPanes.push({ paneId: r.groupId, program });
          }
        }
        builtSpaces.push({ spaceId, title, panes: builtPanes });
      }
      return skipped.length
        ? { projectId: t.id, spaces: builtSpaces, skipped }
        : { projectId: t.id, spaces: builtSpaces };
    },
  });

  // ----- tab -----
  register("tab.list", {
    description: key("cmd.tab.list.desc"),
    params: { pane: P.pane },
    returns: "{ paneId, activeTabId, tabs[] }",
    message: (d) => tmsg("msg.tab.list", { n: ((d.tabs as unknown[]) ?? []).length }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["tab.list"],
    handler: (p, ctx) => {
      const loc = resolvePane(p, ctx);
      if (!loc) return notFound("msg.pane.notFound");
      return {
        paneId: loc.pane.id,
        activeTabId: loc.pane.activeTabId,
        tabs: loc.pane.tabs.map(serializeTab),
      };
    },
  });

  register("tab.open", {
    description: key("cmd.tab.open.desc"),
    triggers: { ko: "탭 열기 탭 추가 claude 열기 터미널 열기" },
    params: {
      pane: P.pane,
      program: { ...P.program, required: true },
      mountTimeoutMs: {
        type: "number",
        description: key("cmd.tab.open.param.mountTimeoutMs"),
      },
    },
    returns: "{ paneId, tabId, mounted }",
    message: () => tmsg("msg.tab.open"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['tab.open \'{"program":"claude"}\''],
    handler: async (p, ctx) => {
      const loc = resolvePane(p, ctx);
      if (!loc) return notFound("msg.pane.notFound");
      const r = S().addViewToGroup(loc.workspace.id, p.program as Program, loc.pane.id);
      if (!r.ok) return r; // Do not mix mounted into a failure envelope.
      // When the answer is ok, its result must be usable. The state changes immediately but a plugin
      // view mounts on the next render, so a command sent with this tabId in between finds the plugin
      // without its view (measured: navigate right after tab.open returned NO_VIEW). The answer waits
      // for the mount signal — the mount point wakes it, not polling.
      const wait = typeof p.mountTimeoutMs === "number" ? Math.max(0, p.mountTimeoutMs) : 5000;
      const mounted = wait > 0 ? await awaitViewMounted(r.viewId, wait) : false;
      return { paneId: r.groupId, tabId: r.viewId, mounted };
    },
  });

  register("tab.close", {
    danger: "destructive",
    description: key("cmd.tab.close.desc"),
    triggers: { ko: "탭 닫기" },
    params: { tab: { ...P.tab, required: true } },
    returns: "{ tabId(closed), activePaneId, activeTabId }",
    message: () => tmsg("msg.tab.close"),
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['tab.close \'{"tab":"tab-k5m6n7"}\''],
    handler: async (p) => {
      const loc = locateTab(p.tab as string);
      if (!loc) return notFound("msg.tab.notFoundId", { id: String(p.tab) });
      const closed = await closeViewPermanently(loc.workspace.id, p.tab as string);
      return withTargets(closed, {
        tabId: p.tab as string,
      });
    },
  });

  // Activation changes the workspace→space→pane→tab chain. Geometry is a separate fact: switching
  // tabs inside one pane commits presentation without opening a layout transaction.
  register("tab.activate", {
    description: key("cmd.tab.activate.desc"),
    triggers: { ko: "탭 전환 탭 선택 탭 활성화" },
    params: {
      tab: { ...P.tab, required: true },
      causeTraceId: { type: "string", description: key("cmd.tab.activate.param.causeTraceId") },
    },
    returns: "{ tabId, changed, layoutMoved, causeTraceId? } — causeTraceId is answered only when layoutMoved is true",
    message: () => tmsg("msg.tab.activate"),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: ['tab.activate \'{"tab":"tab-k5m6n7"}\''],
    handler: (p) => {
      const causeTraceId = p.causeTraceId as string | undefined;
      if (causeTraceId !== undefined && causeTraceId.length === 0) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.cause.empty") };
      }
      const loc = locateTab(p.tab as string);
      if (!loc) return notFound("msg.tab.notFoundId", { id: String(p.tab) });
      const done = transferViewFocus(activeSessionViewId(), p.tab as string, () =>
        S().setActiveView(
          loc.workspace.id,
          p.tab as string,
          causeTraceId === undefined ? undefined : () => declareLayoutCause(causeTraceId),
        ),
      );
      if (!done.ok) return done;
      return withTargets(done, {
        tabId: p.tab as string,
        ...(causeTraceId !== undefined && done.layoutMoved ? { causeTraceId } : {}),
      });
    },
  });

  register("tab.switchScan", {
    description: key("cmd.tab.switchScan.desc"),
    triggers: { ko: "탭 전환 측정 깜빡임 프레임 공백 겹침" },
    params: {
      to: { type: "string", required: true, description: key("cmd.tab.switchScan.param.to") },
      from: { type: "string", description: key("cmd.tab.switchScan.param.from") },
      ...switchScanParams(),
    },
    returns:
      "{ fromTabId, tabId, frames, frameMs, switchFrame, switchFrames, flickerFrames, blankFrames, overlapFrames, nativeMismatchFrames, clean, diffsPct, presentationFrames, activation, recordingDir }",
    message: (data) => data.clean
      ? tmsg("msg.tab.switchScan.clean")
      : tmsg("msg.tab.switchScan.jank", { n: Number(data.flickerFrames) }),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: [
      'tab.switchScan \'{"from":"tab-a1b2c3","to":"tab-d4e5f6"}\'',
      'tab.switchScan \'{"to":"tab-d4e5f6","frames":30,"applyAtFrame":4}\'',
    ],
    handler: async (params, ctx) => {
      const settings = switchScanSettings(params);
      if (!settings) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.switchScan.invalid") };
      }
      const original = activeSessionViewId();
      if (!original) return notFound("msg.tab.noActive");
      const from = (params.from as string | undefined) ?? original;
      const to = params.to as string;
      if (!locateTab(from)) return notFound("msg.tab.notFoundId", { id: from });
      if (!locateTab(to)) return notFound("msg.tab.notFoundId", { id: to });
      if (from === to) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.switchScan.sameTarget") };
      }
      if (original !== from) {
        await activateForSwitchScan(
          "tab.activate",
          { tab: from },
          ctx,
          `switch-scan-start-${crypto.randomUUID()}`,
        );
      }
      try {
        const scanned = await runSwitchScan({
          dir: await switchScanDir(),
          ...settings,
          fromViews: [from],
          toViews: [to],
          activate: () => activateForSwitchScan(
            "tab.activate",
            { tab: to },
            ctx,
            `switch-scan-target-${crypto.randomUUID()}`,
          ),
        });
        return { fromTabId: from, tabId: to, ...scanned };
      } finally {
        if (activeSessionViewId() !== original) {
          await activateForSwitchScan(
            "tab.activate",
            { tab: original },
            ctx,
            `switch-scan-restore-${crypto.randomUUID()}`,
          );
        }
      }
    },
  });

  register("tab.rename", {
    description: key("cmd.tab.rename.desc"),
    triggers: { ko: "탭 이름변경 탭명 변경 라벨" },
    params: {
      tab: { ...P.tab, required: true },
      title: { type: "string", description: key("cmd.tab.rename.param.title"), required: true },
    },
    returns: "{ tabId, label }",
    message: (d) =>
      d.label ? tmsg("msg.tab.rename.set", { label: String(d.label) }) : tmsg("msg.tab.rename.cleared"),
    errors: ["TARGET_NOT_FOUND"],
    examples: [
      'tab.rename \'{"tab":"tab-k5m6n7","title":"work browser"}\'',
      'tab.rename \'{"tab":"tab-k5m6n7","title":""}\'',
    ],
    handler: (p) => {
      const loc = locateTab(p.tab as string);
      if (!loc) return notFound("msg.tab.notFoundId", { id: String(p.tab) });
      return withTargets(
        S().renameView(loc.workspace.id, p.tab as string, p.title as string),
        { tabId: p.tab as string },
      );
    },
  });

  register("tab.maximize", {
    description: key("cmd.tab.maximize.desc"),
    triggers: { ko: "최대화 전체화면 탭 최대화 크게 보기" },
    params: {
      tab: P.tab,
      causeTraceId: {
        type: "string",
        description: key("cmd.tab.maximize.param.causeTraceId"),
      },
    },
    returns: "{ tabId, causeTraceId? }",
    message: () => tmsg("msg.tab.maximize"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['tab.maximize \'{"tab":"tab-k5m6n7"}\'', "tab.maximize"],
    handler: (p, ctx) => {
      const causeTraceId = p.causeTraceId as string | undefined;
      if (causeTraceId !== undefined && causeTraceId.length === 0) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.cause.empty") };
      }
      const loc = p.tab ? locateTab(p.tab as string) : resolveCtx(ctx);
      if (!loc?.tab)
        return p.tab
          ? notFound("msg.tab.notFoundId", { id: String(p.tab) })
          : notFound("msg.tab.noActive");
      const changesGeometry = loc.space.maximizedTabId !== loc.tab.id;
      const r = S().maximizeView(loc.workspace.id, loc.tab.id);
      if (!r.ok) return r;
      if (causeTraceId !== undefined && changesGeometry) declareLayoutCause(causeTraceId);
      return {
        tabId: r.viewId,
        ...(causeTraceId === undefined ? {} : { causeTraceId }),
      };
    },
  });

  register("tab.restore", {
    description: key("cmd.tab.restore.desc"),
    triggers: { ko: "최대화 해제 원래대로 레이아웃 복원" },
    params: {
      workspace: P.workspace,
      causeTraceId: {
        type: "string",
        description: key("cmd.tab.restore.param.causeTraceId"),
      },
    },
    returns: "{ projectId, tabId(restored tab | null = was not maximized), causeTraceId? }",
    message: (d) =>
      d.tabId ? tmsg("msg.tab.restore.restored") : tmsg("msg.tab.restore.none"),
    examples: ["tab.restore"],
    handler: (p, ctx) => {
      const causeTraceId = p.causeTraceId as string | undefined;
      if (causeTraceId !== undefined && causeTraceId.length === 0) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.cause.empty") };
      }
      const t = resolveWorkspace(p, ctx);
      if (!t) return notFound("msg.workspace.notFound");
      const changesGeometry = t.spaces.some((space) => space.id === t.activeSpaceId && space.maximizedTabId !== null);
      const r = S().restoreView(t.id);
      if (!r.ok) return r;
      if (causeTraceId !== undefined && changesGeometry) declareLayoutCause(causeTraceId);
      return {
        projectId: t.id,
        tabId: r.viewId,
        ...(causeTraceId === undefined ? {} : { causeTraceId }),
      };
    },
  });

  register("tab.move", {
    description: key("cmd.tab.move.desc"),
    triggers: { ko: "탭 이동 다른 칸으로" },
    params: {
      tab: { ...P.tab, required: true },
      dst: { type: "string", description: key("cmd.tab.move.param.dst"), required: true },
      zone: { ...P.zone, required: true },
    },
    returns: "{ tabId, paneId(moved or created pane) }",
    message: () => tmsg("msg.tab.move"),
    errors: ["TARGET_NOT_FOUND", "LAST_ITEM"],
    examples: ['tab.move \'{"tab":"tab-k5m6n7","dst":"pan-g2h3j4","zone":"right"}\''],
    handler: (p) => {
      const loc = locateTab(p.tab as string);
      if (!loc) return notFound("msg.tab.notFoundId", { id: String(p.tab) });
      const r = S().moveViewToGroup(
        loc.workspace.id,
        p.tab as string,
        p.dst as string,
        p.zone as DropZone,
      );
      return r.ok ? { tabId: p.tab as string, paneId: r.groupId } : r;
    },
  });

  // ----- status (view report replies, R8) -----
  register("status.query", {
    description: key("cmd.status.query.desc"),
    triggers: { ko: "상태 조회 뷰 상태 status 조회 무엇이 도는지" },
    params: { tab: P.tab },
    returns: "{ statuses: Array<{ tabId, code, message? }> }",
    message: (d) => tmsg("msg.status.query", { n: ((d.statuses as unknown[]) ?? []).length }),
    examples: ["status.query", 'status.query \'{"tab":"tab-k5m6n7"}\''],
    handler: (p) => {
      const only = p.tab as string | undefined;
      const statuses: { tabId: string; code: string; message?: string }[] = [];
      for (const t of S().workspaces)
        for (const c of t.spaces)
          for (const g of allGroups(c.layout))
            for (const v of g.tabs)
              if (v.status && (!only || v.id === only))
                statuses.push({
                  tabId: v.id,
                  code: v.status.code,
                  message: v.status.message,
                });
      return { statuses };
    },
  });

  // ----- explorer (file explorer) -----
  // ----- Delegated catalogs (split into files — the single truth is the same registry) -----
  registerFsWatchCatalog();
  registerSectionsCatalog();
  registerHealthCatalog();
  registerWindowCatalog();
  registerCaptureCatalog();
  registerSettingsCatalog();
  registerPluginCatalog();
  registerDaemonCatalog();
  registerUpdateCatalog();
  registerUiCatalog();
  registerDomCatalog();
  registerDataCatalog();
  registerSecretsCatalog();
  registerNetworkCatalog();
  registerClipboardCatalog();
  registerNotifyCatalog();
  registerScheduleCatalog();
  registerServiceCatalog();
  registerRuntimeCatalog();
  registerSystemCatalog();
  registerSidecarCatalog();
  registerWebviewCatalog();
  registerLayoutAlignmentCatalog();
  registerLayoutTraceCatalog();
  reportOwnerAnswered();
}

/**
 * Report the names in this window's catalog whose answer is the owner's.
 *
 * With two apps in one home, both hold a name like `main` (one orchestrator per app). Delivery then
 * goes to all of them, which is correct for window-local commands. But when owner-answered commands
 * go to all as well, **the same work runs twice** — measured 2026-08-01: `data.kv.set` ran in each of
 * two processes. Which kind it is comes from the command itself (`CommandSpec.windowScoped`), and
 * that fact is at the catalog — this window. So the window reports it.
 *
 * Failures are swallowed — without the report, delivery falls back to all as before and no feature
 * dies. Not passed over silently: the fact is recorded.
 */
function reportOwnerAnswered(): void {
  if (framework.name === "test") return;
  const names = catalogJson()
    .filter((c) => !c.windowScoped)
    .map((c) => c.name);
  if (names.length === 0) return;
  void invoke("control_owner_answered", { names }).catch((e) =>
    console.warn(`[commands] owner-answered report failed — with two windows under one label the command executes twice: ${e}`),
  );
}
