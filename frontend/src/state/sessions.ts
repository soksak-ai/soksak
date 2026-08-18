import { create } from "zustand";
import { moduleState } from "../lib/moduleState";
import { issueId } from "./ids";
import { noteActivation } from "../lib/motionDebug";
import {
  DEFAULT_RAIL_PLACEMENT,
  cleanRailLines,
  isCleanRailStation,
  type RailPlacement,
} from "../lib/railPlacement";
import { useSettings } from "./settings";
import {
  projectionGeometryChanged,
  solveArrangement,
  type Arrangement,
} from "../lib/railArrangement";
import {
  autorunCommandOf,
  getRegisteredProgram,
} from "../plugins/programRegistry";
import { localize, tmsg } from "../i18n";
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
import { viewIdFromSurfaceLabel } from "../lib/surfaceLabels";
import { invalidateLayout } from "../lib/layoutSettlement";
import { publishLayoutTransitionIntent } from "../lib/layoutTransitionIntent";
import { computeSplitLayout } from "../lib/splitLayout";

// Three-level structure:
//   - Top = Workspace: its own sidebar (file tree) + spaces
//   - Space = layout tree (PaneNode): recursive left/right/top/bottom splits.
//       Each leaf = Pane (own header + active tab). Split, move, merge by drag or command.
//   - Tab = file (viewer plugin) / plugin (terminal, browser, editor — the core owns no terminal).
// Inactive workspaces/spaces/tabs are hidden rather than unmounted, which keeps the sessions
// (PTY/editor/webview) intact.
//
// Design rules (the base of the AI command interface):
//   - Every mutating action returns CmdResult — created id and post-change state (verifiable).
//   - No silent failure — an impossible operation returns a structured error ({code, message}).
//   - Targeting searches the whole workspace, not only the active space (arbitrary position targeting).
//   - When the requested intent already holds, return idempotent success (ok).

// ── Result types ─────────────────────────────────────────────────────────────

export type CmdErrCode =
  | "TARGET_NOT_FOUND"
  | "LAST_ITEM"
  | "INVALID_PARAMS"
  // The request is valid, but the requested cell is smaller than the chrome that has to fit inside
  // it. Performing it anyway leaves a pane the tree names and the screen draws at zero width.
  | "TOO_SMALL"
  // The request itself is valid, but the layout change would make a panel cross the pinned rail line.
  | "LAYOUT_CONFLICT"
  | "PRESENTATION_PROVIDER_FAILED"
  | "LAYOUT_SETTLEMENT_FAILED"
  // The request is valid, but the persistent state / OS boundary failed. Do not disguise the cause
  // as INVALID_PARAMS.
  | "INTERNAL"
  // Plugin activation needs user consent (remote enable rejected — plugin spec §0-5).
  | "CONSENT_REQUIRED"
  // Plugin delete would cascade to dependents — blocked without consent (cascade:true), which
  // prevents dangling references.
  | "CASCADE_REQUIRED"
  // The DOM address is not on an exposed node (data-node) — no selector guessing, access only what
  // is exposed (ui.tree).
  | "NOT_EXPOSED"
  // One address resolved to more than one target (address axiom A1 violation) — do not pick one of
  // them. The defect is on the address-producing side, so the caller narrows with the instance axis
  // (inst), or the mount supplies an instance.
  | "AMBIGUOUS";

// data = per-code extra information (optional). E.g. the unconsented chain of CONSENT_REQUIRED
// (for the consecutive consent popup).
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

// ── Model types ──────────────────────────────────────────────────────────────

// State a view reports to the core continuously (R1) — code = machine identifier, message = human text.
// A blocking code (STATUS_BLOCKING) triggers the close guard (R2). Reclaim is view-scoped (R4) —
// deleting the view deletes the status.
export interface TabStatus {
  code: string;
  message?: string;
}

// Content view: one kind, and it is a plugin's.
//
// There were two until 2026-08-16 — a "file" arm carrying a path and a code/preview mode, branched
// on in eighteen places. No plugin ever declared a viewer for it, so it opened a tab that resolved
// to nothing, and it was a second code path for one kind of content (CORE-CENSUS 1). A file is drawn
// the way a page and a shell are: by a plugin view.
// title is the content fact (file name, page <title> — kept current by setViewTitle), customLabel is
// user intent (view.rename). Display prefers customLabel — the same rule as sidebar viewLabels
// (default = fact, override = user intent only). An empty override is not stored.
// One shape, because there is one kind of content view: a plugin's. PluginViewHost draws the
// provider of the global key "<pluginId>.<view>", and close, move and drag are the same for any of
// them. `kind` is kept because it is written into every snapshot; it holds one value.
export type Tab =
  | {
      id: string;
      kind: "plugin";
      title: string;
      customLabel?: string;
      // Tab icon (content fact — e.g. a browser favicon URL). Same shape as title: the plugin
      // reports it through setIcon, empty = cleared (falls back to the manifest icon). Display
      // only — the core assigns it no meaning.
      icon?: string;
      pluginId: string;
      view: string; // view id inside the plugin
      // Autorun command this view receives at mount (agent program — the terminal view runs it once
      // on the PTY). Passed as PluginViewContext.command. A channel independent of view kind (only
      // the terminal view actually autoruns).
      command?: string;
      status?: TabStatus;
      // Observed working directory (OSC 7/633) — persisted (B3): a restored view starts at the last cwd.
      cwd?: string;
      // Plugin-observed runtime state (B3 generalization) — stored on the view record with the same
      // lifetime as the view (view close = state gone, no id-reuse collision). E.g. the current
      // browser URL. Do not persist it in plugin kv under a viewId key — viewId is not unique across
      // sessions (reseed reuse). ctx.setRestoreState writes it, and it comes back as
      // ctx.restore.state on the restore mount. JSON-serializable values only.
      state?: unknown;
      // Last activity time (epoch ms) — events are the only basis (command start/end, turn,
      // activation, PTY output). Data for restore hydration priority (B4) and the "last used" display.
      lastActivity?: number;
      // Old tab id planted by the entity id migration — preserves the old key of the PTY reattach
      // and the checkpoint (zero loss). Removal condition: snapshot cleanup after that checkpoint
      // is re-sealed (adopt).
      legacyPaneId?: string;
    };

// Pane: a tab bundle + the active tab. The leaf of the layout tree.
export interface Pane {
  id: string;
  tabs: Tab[];
  activeTabId: string;
}

// Recursive layout tree. leaf = one pane, split = panes grouped by row/column (sizes = split ratio).
// A space's split tree = the generic SplitTree (leaf value = Pane). split/remove/resize/find come
// from the single splitTree.ts abstraction (same code as the sidebar SidebarLayout — no duplication).
export type PaneNode = SplitTree<Pane>;

// Drop position (drag split direction). center = move, the rest = split toward that direction.
export type DropZone = "center" | "left" | "right" | "top" | "bottom";

export type Side = "left" | "right" | "top" | "bottom";

// Program shown when content first opens (first screen). Built-in "terminal" (core capability) +
// plugin-registered program ids (programRegistry). An unregistered id falls back to the terminal.
export type Program = string;

// Content tab: an independent content area inside one workspace (split grid). Several per workspace,
// switchable. Program autorun is handled by the terminal view autorun (generalized per view).
export interface Space {
  id: string;
  title: string; // 1,2,3,… (renameable)
  layout: PaneNode; // group (split) tree
  activePaneId: string;
  // The single sidebar-owning view this space workspaces. Independent of panel focus, persisted in
  // the snapshot.
  railBindingTabId?: string;
  // Maximized view (fills the whole content area). The layout tree is unchanged — display override
  // only. undefined = normal. normalize clears it when the view is gone.
  maximizedTabId?: string;
}

/** A window region a set can stand in. Centre holds panes, not sections. */
export type SidebarRegion = "left" | "right";

/** One region's layout replaced, the rest of the workspace untouched. Written in one place so a
 *  region cannot be updated by a path that forgets the other. */
function withSidebarLayout(
  workspaces: Workspace[],
  id: string,
  region: SidebarRegion,
  layout: SidebarLayout,
): Workspace[] {
  return workspaces.map((x) =>
    x.id === id ? { ...x, sidebarLayouts: { ...x.sidebarLayouts, [region]: layout } } : x,
  );
}

export interface Workspace {
  id: string;
  title: string; // alias
  // Whether each region is open. One shape for both: `sidebarOpen` and `rightOpen` were two fields,
  // two actions and two commands for one question, and the two drifted — the left had no way to be
  // set to a state, only flipped.
  regionOpen: Record<SidebarRegion, boolean>;
  // Position mode of the left rail frame. A separate axis from the projection ref pin (the content
  // inside the rail). Absence in old snapshots and test fixtures is read as FLOW.
  leftRailPlacement?: RailPlacement;
  // How the sections of the set standing in each region are arranged (B2) — SplitTree<SidebarGroup>,
  // tab bundle + split + active, the same drag-merge as the content area. Reconciled against
  // registration changes by the host.
  //
  // One shape for both regions. The right held a single `rightView` and an icon rail of every view
  // placed there until 2026-08-16 — a region with a rule of its own, so `sections.link region=right`
  // answered OK and the screen never changed (measured). A2a: a region is a place, and the workspace
  // arranges what stands in it.
  sidebarLayouts: Record<SidebarRegion, SidebarLayout>;
  // Workspace root directory (P1 root required — workspaceRoot.ts constitution). Identity = this path
  // (P4). The terminal start location and the basis for the file tree and git.
  root: string;
  // On restore, root is absent from the filesystem (volatile — excluded from serialization). Keep
  // the tabs, report it with a banner, and let the user clean up (no unauthorized delete — B1
  // consistency). Resolved on the next restart restore once the path is back.
  rootMissing?: boolean;
  // Workspace identity color (rail chip/tab accent). Unset falls back to the theme default.
  color?: string;
  // Content tabs + the active one.
  spaces: Space[];
  activeSpaceId: string;
}

export interface NewWorkspaceOpts {
  alias: string;
  root: string; // P1 — the caller has already validated and normalized this path (validateWorkspaceRoot)
  // Initial view program of the first content. Omitted = empty skeleton (same as the makeContent
  // contract).
  program?: Program;
}

// ── Action result shapes ─────────────────────────────────────────────────────

// Result of creating a new view.
export interface NewViewIds {
  viewId: string;
}

interface SessionsStore {
  workspaces: Workspace[]; // open workspaces
  activeId: string;

  // Workspace level
  // Once at boot: create the first workspace (t1/"P1") at the default root — main.tsx only (P3).
  bootstrapFirstWorkspace: (root: string, opts?: { alias?: string }) => void;
  // Restore the persisted layout (A5) — the main.tsx boot deserializes the snapshot and injects it
  // whole. Exclusive with bootstrap: use this when a restore exists, bootstrap otherwise. reseed is
  // the caller's job (persistence).
  restoreWorkspaces: (workspaces: Workspace[], activeId: string) => void;
  addWorkspace: (
    opts: NewWorkspaceOpts,
  ) => CmdResult<
    { projectId: string; contentId: string; groupId: string; existing?: true } & Partial<NewViewIds>
  >;
  closeTab: (id: string) => CmdResult<{ activeProjectId: string }>;
  setActive: (id: string) => CmdResult;
  renameWorkspace: (id: string, title: string) => CmdResult;
  // Set the workspace identity color (null = remove).
  setWorkspaceColor: (id: string, color: string | null) => CmdResult;
  // Bulk workspace settings change (undefined = keep, null = remove → default). root is immutable.
  updateWorkspace: (
    id: string,
    patch: {
      title?: string;
      color?: string | null;
    },
  ) => CmdResult;
  // With open given, set that state (idempotent); omitted, flip it.
  toggleRegion: (
    id: string,
    region: SidebarRegion,
    open?: boolean,
  ) => CmdResult<{ region: SidebarRegion; open: boolean }>;
  setLeftRailPlacement: (
    id: string,
    placement: RailPlacement,
  ) => CmdResult<{ placement: RailPlacement }>;
  // Sidebar active tab — make viewKey the active one in the leaf group that holds it.
  setSidebarTab: (
    id: string,
    region: SidebarRegion,
    viewKey: string,
  ) => CmdResult<{ sidebarTab: string }>;
  // Reconcile with the registered views of that region (the host calls it on render). set only on
  // change.
  reconcileSidebar: (id: string, region: SidebarRegion, registeredKeys: string[]) => void;
  // Sidebar view drag-merge (into = join tabs, split = vertical separation).
  moveSidebarView: (
    id: string,
    region: SidebarRegion,
    viewKey: string,
    drop: SidebarDrop,
  ) => CmdResult;
  // Adjust the sidebar split ratio (handle drag/command).
  resizeSidebar: (
    id: string,
    region: SidebarRegion,
    splitId: string,
    sizes: number[],
  ) => CmdResult;

  // Content tab level. With program given, use that program (+ menu); otherwise the workspace then
  // global setting.
  addContent: (
    projectId: string,
    program?: Program,
  ) => CmdResult<{ contentId: string; groupId: string } & Partial<NewViewIds>>;
  closeContent: (
    projectId: string,
    contentId: string,
  ) => CmdResult<{ activeSpaceId: string }>;
  setActiveContent: (projectId: string, contentId: string) => CmdResult;
  renameContent: (
    projectId: string,
    contentId: string,
    title: string,
  ) => CmdResult;
  bindContentRail: (
    projectId: string,
    contentId: string,
    viewId: string,
  ) => CmdResult<{ viewId: string }>;

  // Content view/group level. A new view tab per program in the group (terminal/claude/codex/browser).
  // opts.command = set the terminal autorun command directly (internal — bypasses program resolve.
  // Host flows only, such as the install terminal on plugin activation; not exposed to remote commands).
  addViewToGroup: (
    projectId: string,
    program: Program,
    groupId?: string,
    opts?: { command?: string },
  ) => CmdResult<{ groupId: string } & NewViewIds>;
  // Close a whole group (panel) — remove every view inside (rejected for the last group).
  closeGroup: (
    projectId: string,
    groupId: string,
  ) => CmdResult<{ activePaneId: string }>;
  // Open a plugin view as a content tab (duplicate key = pluginId+view).
  openPluginView: (
    projectId: string,
    pluginId: string,
    view: string,
    title: string,
  ) => CmdResult<{ viewId: string; groupId: string; existing: boolean }>;
  closeView: (
    projectId: string,
    viewId: string,
  ) => CmdResult<{ activePaneId: string; activeTabId: string }>;
  // moved is whether the activation changed the arrangement and opened a layout transition.
  // Activating the tab that is already active changes nothing, and a caller that cannot tell the
  // two apart waits for a transaction that was never opened.
  setActiveView: (projectId: string, viewId: string) => CmdResult<{ moved: boolean }>;
  setActiveGroup: (projectId: string, groupId: string) => CmdResult;
  // Maximize a view — one view fills the whole content area (split tree unchanged, display only).
  // Restore = the original split.
  maximizeView: (
    projectId: string,
    viewId: string,
  ) => CmdResult<{ viewId: string }>;
  restoreView: (projectId: string) => CmdResult<{ viewId: string | null }>;
  setFileDirty: (projectId: string, viewId: string, dirty: boolean) => CmdResult;
  // View status report (R1) — null reclaims it (R4). Common to every view kind.
  setViewStatus: (
    projectId: string,
    viewId: string,
    status: TabStatus | null,
  ) => CmdResult;
  // Update the tab title of any view (dynamic title from a content plugin — e.g. page <title>).
  // Empty is ignored.
  setViewTitle: (projectId: string, viewId: string, title: string) => void;
  // Update the tab icon (content fact — e.g. favicon URL). Empty = cleared (the fact became
  // "no icon").
  setViewIcon: (projectId: string, viewId: string, icon: string) => void;
  // Set the user-defined tab label (view.rename). Empty = drop the override (back to the dynamic title).
  renameView: (projectId: string, viewId: string, label: string) => CmdResult<{ label: string }>;
  // View runtime observations (B3) — cwd (OSC observation), lastActivity (event-based), state
  // (plugin-observed state). undefined = keep.
  // projectId may be null: when the event has no workspace, search every tab for the view
  // (pane→view mapping stays stable).
  setViewRuntime: (
    projectId: string | null,
    viewId: string,
    patch: { cwd?: string; lastActivity?: number; state?: unknown },
  ) => void;
  // Drag/command split and move: put viewId at the zone position of targetGroup.
  moveViewToGroup: (
    projectId: string,
    viewId: string,
    targetGroupId: string,
    zone: DropZone,
  ) => CmdResult<{ groupId: string }>;
  // Put a whole group (titlebar drag/command) at the zone position of targetGroup. center = merge.
  moveGroupToGroup: (
    projectId: string,
    sourceGroupId: string,
    targetGroupId: string,
    zone: DropZone,
  ) => CmdResult<{ groupId: string }>;
  // Adjust the split ratio (resizer drag/command).
  resizeSplit: (
    projectId: string,
    splitId: string,
    sizes: number[],
  ) => CmdResult;
  // sizes of several splits in one commit (vertical line dragged along — no half-applied state).
  // The rail conflict check runs once on the final state — on rejection nothing changes.
  resizeSplits: (
    projectId: string,
    updates: { splitId: string; sizes: number[] }[],
  ) => CmdResult;
  // Create a new view group beside targetGroup by splitting (split button / title mode ⌘T / command).
  // With program unset or unregistered, an empty group (empty panel) — no viewId (Partial).
  splitWithNewView: (
    projectId: string,
    targetGroupId: string,
    side: Side,
    program?: Program,
  ) => CmdResult<{ groupId: string } & Partial<NewViewIds>>;
}

// ids.ts issues ids (single source of truth) — counters and reseed were removed. Random ids never
// reappear across restarts or windows, so the "raise the counter above preserved ids" coordination
// is not needed at all. Split nodes use the same issuer — those ids are stored and go out as the
// canonicalLayout of `state.tree`, so a counter that restarts at 1 per window would give the trees
// of two windows the same names.
const newViewId = () => issueId("tab");
const newGroupId = () => issueId("pane");
const newSplitId = () => issueId("split");
const newContentId = () => issueId("space");
// split id generator (injected into windowSnapshot.deserialize on restore — A2 regenerates split ids).
export const nextSplitIdGen = (): string => newSplitId();

// Non-destructive preview of the issue format — for diagnostics and gates. Issue is random, so the
// contract is the format, not the value.
export function newIds(): {
  workspace: string;
  view: string;
  group: string;
  split: string;
  content: string;
} {
  return {
    workspace: issueId("workspace"),
    view: issueId("tab"),
    group: issueId("pane"),
    split: issueId("split"),
    content: issueId("space"),
  };
}

const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

function makeGroup(view?: Tab): Pane {
  // view omitted = empty group (empty tab) — no first-screen autorun (pure skeleton). Views are
  // added from the + menu.
  return view
    ? { id: newGroupId(), tabs: [view], activeTabId: view.id }
    : { id: newGroupId(), tabs: [], activeTabId: "" };
}

// New plugin view (content placement) — a program opens one of some plugin's contributes.views.
// PluginViewHost draws the "<pluginId>.<view>" provider. The core is plugin-agnostic — the same path
// for any plugin (zero lock-in to a specific plugin). command is the autorun command passed to the
// view at mount (agent program — the terminal view runs it once on the PTY). Unset = no autorun.
function newPluginViewFor(
  pluginId: string,
  view: string,
  title: string,
  command?: string,
): Tab {
  return {
    id: newViewId(),
    kind: "plugin",
    title,
    pluginId,
    view,
    ...(command ? { command } : {}),
  };
}

// Program → new view. There is no built-in program concept (§2.6) — resolve from the registered
// program spec. Every program is kind:"view" (core terminal removed — a terminal is a plugin view
// too). The view-owning plugin comes from two axes: viewPlugin (name-pin, that plugin's view) or
// viewContract (contract-pin, the view of the implementation the user chose). Unset = the program's
// own plugin. command is the autorun command passed to that view. An unregistered id cannot create
// a view (null). Zero active implementations for the contract is null as well (degrades to an empty group).
function newViewFor(
  program: Program,
  opts?: { command?: string },
): Tab | null {
  const reg = getRegisteredProgram(program);
  if (!reg || !reg.decl.view) return null;
  // command priority: caller-supplied (opts) > program declaration (autorun).
  const command = opts?.command ?? autorunCommandOf(reg.decl);
  // viewPlugin set = that plugin's view (cross-plugin), unset = the program's own plugin.
  //
  // A `viewContract` stood beside it until 2026-08-16 — the same reference through an interface id,
  // resolved from a user setting. Two ways to say one thing, one of them a second identity for what
  // the plugin id already names (C3, C4).
  const pluginId = reg.decl.viewPlugin ?? reg.pluginId;
  return newPluginViewFor(pluginId, reg.decl.view, localize(reg.decl.title), command);
}

// New id bundle of a view — for the create command response.
function idsOfView(v: Tab): NewViewIds {
  return { viewId: v.id };
}

// New content area. program omitted = empty group (empty tab, no first-screen autorun — pure
// skeleton). program given (new content tab from the + menu) = start with that program's view.
function makeContent(title: string, program?: Program): Space {
  // program unset or unregistered (newViewFor=null) = empty group (empty tab, pure skeleton).
  const g = makeGroup(program ? (newViewFor(program) ?? undefined) : undefined);
  return {
    id: newContentId(),
    title,
    layout: splitLeaf(g),
    activePaneId: g.id,
  };
}


// ── Group tree helpers ───────────────────────────────────────────────────────

export function allGroups(node: PaneNode, acc: Pane[] = []): Pane[] {
  acc.push(...leavesOf(node)); // leaf value (Pane) = SplitTree leavesOf
  return acc;
}

export function allViews(node: PaneNode): Tab[] {
  return allGroups(node).flatMap((g) => g.tabs);
}

function findGroupOfView(
  node: PaneNode,
  viewId: string,
): Pane | undefined {
  return allGroups(node).find((g) => g.tabs.some((v) => v.id === viewId));
}

function hasGroup(node: PaneNode, groupId: string): boolean {
  return allGroups(node).some((g) => g.id === groupId);
}

function findGroup(node: PaneNode, groupId: string): Pane | undefined {
  return allGroups(node).find((g) => g.id === groupId);
}

// ── PaneNode operations = delegated to the generic SplitTree (single source, same code as SidebarLayout) ──
// Traversal and structural operations (map/find/resize/remove/insert) exist only in splitTree.ts.
// This file provides leaf (Pane) predicates and transforms only.

// Transform the Pane of a specific group.
function mapGroupNode(
  node: PaneNode,
  groupId: string,
  fn: (g: Pane) => Pane,
): PaneNode {
  return mapLeaves(node, (g) => (g.id === groupId ? fn(g) : g));
}

// Transform a view in whichever group holds it (kind preserved).
function mapViewNode(
  node: PaneNode,
  viewId: string,
  fn: (v: Tab) => Tab,
): PaneNode {
  return mapLeaves(node, (g) =>
    g.tabs.some((v) => v.id === viewId)
      ? { ...g, tabs: g.tabs.map((v) => (v.id === viewId ? fn(v) : v)) }
      : g,
  );
}

// split node existence / sizes transform — delegated to the generic.
const findSplit = (node: PaneNode, splitId: string): boolean =>
  findSplitTree(node, splitId);
const mapSplitNode = (
  node: PaneNode,
  splitId: string,
  sizes: number[],
): PaneNode => resizeSplitTree(node, splitId, sizes);

// Remove a view: (1) drop only that view from its group and fix the active one (mapLeaves),
// (2) collapse the empty group leaf with removeLeaf. split cleanup (collapse, sizes renormalization)
// reuses the single removeLeaf implementation.
function removeView(
  node: PaneNode,
  viewId: string,
): { tree: PaneNode | null; removed: Tab | null } {
  let removed: Tab | null = null;
  const mapped = mapLeaves(node, (g) => {
    const found = g.tabs.find((v) => v.id === viewId);
    if (!found) return g;
    removed = found;
    const tabs = g.tabs.filter((v) => v.id !== viewId);
    let activeTabId = g.activeTabId;
    if (activeTabId === viewId) {
      const idx = g.tabs.findIndex((v) => v.id === viewId);
      activeTabId = (tabs[idx] ?? tabs[idx - 1] ?? tabs[0])?.id ?? "";
    }
    return { ...g, tabs, activeTabId };
  });
  if (!removed) return { tree: node, removed: null };
  const { tree } = removeLeaf(mapped, (g) => g.tabs.length === 0);
  return { tree, removed };
}

// Remove one whole group (leaf) = removeLeaf (matching that group id, collapse included).
function removeGroup(
  node: PaneNode,
  groupId: string,
): { tree: PaneNode | null; removed: Pane | null } {
  return removeLeaf(node, (g) => g.id === groupId);
}

// Split targetGroup with the fresh group (toward side) = insertBeside (avoids nesting when the
// sibling has the same dir).
/**
 * The tree a split would produce. Exported so a caller can ask what the split
 * lands on before performing it — the answer has to come from this function,
 * not from a second one that agrees with it today.
 */
export function splitAtGroup(
  node: PaneNode,
  targetGroupId: string,
  side: Side,
  fresh: Pane,
): PaneNode {
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

// Fix the active group to the first one when it is gone, and clear maximize when the maximized
// view is gone.
function normalizeActiveGroupC(c: Space): Space {
  const groups = allGroups(c.layout);
  let next =
    c.maximizedTabId &&
    !groups.some((g) => g.tabs.some((v) => v.id === c.maximizedTabId))
      ? { ...c, maximizedTabId: undefined }
      : c;
  if (
    next.railBindingTabId &&
    !groups.some((g) => g.tabs.some((v) => v.id === next.railBindingTabId))
  ) {
    next = { ...next, railBindingTabId: undefined };
  }
  if (groups.some((g) => g.id === next.activePaneId)) return next;
  return { ...next, activePaneId: groups[0]?.id ?? next.activePaneId };
}

/**
 * Group the maximize fills — the group that actually holds the maximized view. null when there is
 * no maximize (or when the target is in no group), and then the split layout displays as is. A
 * target that cannot be found does not collapse to an empty screen: no maximize is always better
 * than a screen that disappears.
 */
function maximizedGroupId(content: Space): string | null {
  const target = content.maximizedTabId;
  if (!target) return null;
  const owner = allGroups(content.layout).find((g) =>
    g.tabs.some((v) => v.id === target),
  );
  return owner?.id ?? null;
}

/**
 * The layout actually displayed on screen — a single call to the layout solver. No content means no
 * plane (null).
 * fallbackStation: the current position to hold during an unresolved focus render (the caller passes
 * the last settled value).
 */
export function projectArrangement(
  workspace: Workspace,
  fallbackStation = 0,
  /**
   * How to attach — **the caller supplies it.**
   *
   * Reading the store here in secret leaves the value outside React's inputs. Changing the setting
   * then redraws nothing and the screen stays on the old layout (measured 2026-08-02: the value
   * changed and the screen did not). When the subscriber passes the value in, its change becomes an
   * input of the render.
   *
   * Outside React (commands, internal computation) pass the store value as is — it is read at the
   * same place, so the two cannot diverge.
   */
  pullFocused = useSettings.getState().railPullFocused,
): Arrangement<Pane> | null {
  const content =
    workspace.spaces.find((item) => item.id === workspace.activeSpaceId) ??
    workspace.spaces[0];
  if (!content) return null;
  return solveArrangement<Pane>({
    layout: content.layout,
    focusId: content.activePaneId,
    placement: workspace.leftRailPlacement ?? DEFAULT_RAIL_PLACEMENT,
    railOpen: workspace.regionOpen.left,
    // Maximize is not a move on top of the underlying split but an atomic switch to the single
    // [rail | feature] plane. The filling panel is the group holding the maximized view — not the
    // active group. The two can diverge (double-clicking a tab of another group does exactly that),
    // and collapsing to the active group while diverged leaves only a panel without the maximized
    // view, so nothing is drawn (measured: maximizedTabId=v35 is in g3 while
    // layout={"panel":"g5"}, 0 DOM slots, the whole window blank).
    maximizedId: maximizedGroupId(content),
    fallbackStation,
    pullFocused,
  });
}

/** Whether an active-chain change alters the actual display geometry. Opening a revision on focus
 * identity alone makes even a no-move activation such as PIN create a barrier; skipping the revision
 * without this comparison leaves the FLOW WorkspacePlane on the old display solution. The layout
 * solver and the movement solver are the only judges. */
function openProjectArrangementTransition(before: Workspace, after: Workspace): boolean {
  const from = projectArrangement(before);
  const to = projectArrangement(after);
  if (!from || !to) return false;
  if (!projectionGeometryChanged(from, to)) return false;
  const revision = invalidateLayout(before.id);
  publishLayoutTransitionIntent({
    ownerKey: before.id,
    revision,
    from,
    to,
  });
  return true;
}

function leftRailLayoutConflict(workspace: Workspace): CmdErr | null {
  const placement = workspace.leftRailPlacement ?? DEFAULT_RAIL_PLACEMENT;
  if (placement.mode !== "pin") return null;
  const content =
    workspace.spaces.find((item) => item.id === workspace.activeSpaceId) ??
    workspace.spaces[0];
  // PIN validity is judged against the split tree, the persisted canonical form. Maximize is a
  // temporary projection on top of it and folds the clean line to [0,100], but rejecting the stored
  // station on that basis would make maximize itself impossible under PIN. Real split/move/resize do
  // change the canonical rect, so they go through this check as is.
  const cleanLines = content
    ? cleanRailLines(computeSplitLayout(content.layout).cells.map((cell) => cell.rect))
    : [0, 100];
  return isCleanRailStation(cleanLines, placement.station)
    ? null
    : err(
        "LAYOUT_CONFLICT",
        tmsg("layout.rail.stationCrossed", { station: placement.station }),
        { station: placement.station, cleanLines },
      );
}

// ── Terminal pane resolver (plugin terminal = substrate) ─────────────────────

// Candidate PTY substrate key the tab drives (when there is one). The terminal test is generic — a
// candidate id with a PTY observation (one that drives app.pty) is a terminal (no pluginId or kind
// hardcoded, hasPty injected). The core does not own the terminal view, so the candidate is always
// the tab id (the key the plugin passed to app.pty.spawn).
function ptyKeyOfTab(v: Tab, hasPty: (id: string) => boolean): string | undefined {
  return hasPty(v.id) ? v.id : undefined;
}

// Terminal pane the workspace sidebar (file tree) takes the current cwd from. A pure resolver — it
// takes the PTY observation predicate (hasPty) as an injection, so it works for any plugin terminal
// (generic). If the active (focused) view of the active group of the active content is a terminal,
// that pane; otherwise the pane of any terminal view.
export function cwdTabOf(
  workspace: Workspace,
  hasPty: (id: string) => boolean,
): string | undefined {
  const content =
    workspace.spaces.find((c) => c.id === workspace.activeSpaceId) ??
    workspace.spaces[0];
  if (!content) return undefined;
  const groups = allGroups(content.layout);
  const activeGroup =
    groups.find((g) => g.id === content.activePaneId) ?? groups[0];
  const active = activeGroup?.tabs.find(
    (v) => v.id === activeGroup.activeTabId,
  );
  if (active) {
    const key = ptyKeyOfTab(active, hasPty);
    if (key) return key;
  }
  for (const g of groups) {
    for (const v of g.tabs) {
      const key = ptyKeyOfTab(v, hasPty);
      if (key) return key;
    }
  }
  return undefined;
}

// Single source of truth for the view tab display name — customLabel (user intent) first, title
// (content fact) as fallback. Every user surface (tabs, badges) displays through this function
// (no inline `customLabel ?? title` redefinition).
export function viewDisplayTitle(v: Tab): string {
  return v.customLabel ?? v.title;
}

// Search every workspace of this window for the view record with viewId. null when absent.
export function findViewById(workspaces: Workspace[], viewId: string): Tab | null {
  for (const t of workspaces)
    for (const c of t.spaces)
      for (const v of allViews(c.layout)) if (v.id === viewId) return v;
  return null;
}

// Human display name of a webview label — for user surfaces only (recovery badge etc.). For a
// browser view of this window (b-<window>-<viewId>) it resolves to the tab display name; with no
// matching view it keeps the label as is (for a webview with no human name the identifier is the
// only fact).
export function webviewDisplayName(label: string, workspaces: Workspace[]): string {
  const viewId = viewIdFromSurfaceLabel(label);
  const v = viewId ? findViewById(workspaces, viewId) : null;
  return v ? viewDisplayTitle(v) : label;
}

// {projectId, viewId} of paneId (= plugin terminal view.id) (M5 — for the terminal status bridge).
// null when absent.
export function locateTab(
  workspaces: Workspace[],
  paneId: string,
): { projectId: string; viewId: string } | null {
  for (const t of workspaces)
    for (const c of t.spaces)
      for (const v of allViews(c.layout))
        if (v.id === paneId) return { projectId: t.id, viewId: v.id };
  return null;
}

// ── Search/transform helpers ─────────────────────────────────────────────────

function mapWorkspace(
  workspaces: Workspace[],
  projectId: string,
  fn: (t: Workspace) => Workspace,
): Workspace[] {
  return workspaces.map((t) => (t.id === projectId ? fn(t) : t));
}

function activeContentOf(t: Workspace): Space | undefined {
  return t.spaces.find((c) => c.id === t.activeSpaceId);
}

// Search the whole workspace for the content holding a group/view (arbitrary position targeting).
function contentOfGroup(
  t: Workspace,
  groupId: string,
): Space | undefined {
  return t.spaces.find((c) => hasGroup(c.layout, groupId));
}

function contentOfView(
  t: Workspace,
  viewId: string,
): Space | undefined {
  return t.spaces.find((c) =>
    allViews(c.layout).some((v) => v.id === viewId),
  );
}

function mapContent(
  t: Workspace,
  contentId: string,
  fn: (c: Space) => Space,
): Workspace {
  return {
    ...t,
    spaces: t.spaces.map((c) => (c.id === contentId ? fn(c) : c)),
  };
}

// Workspace holding a view id (terminal panes included — pane = terminal view) — the single utility
// for caller context (ctx.pane) routing. null when absent.
export function projectIdOfView(viewId: string): string | null {
  for (const t of useSessions.getState().workspaces) {
    for (const c of t.spaces) {
      if (allViews(c.layout).some((v) => v.id === viewId)) return t.id;
    }
  }
  return null;
}

// Transform a view in whichever content holds it (mounted views of hidden content included —
// dirty/mode/focus etc.).
function mapViewEverywhere(
  t: Workspace,
  viewId: string,
  fn: (v: Tab) => Tab,
): Workspace {
  return {
    ...t,
    spaces: t.spaces.map((c) => ({
      ...c,
      layout: mapViewNode(c.layout, viewId, fn),
    })),
  };
}

// Extract the number of an auto space title — a localized "Space 3", an English "Space 3", and a
// bare "3" all read the trailing integer (locale- and prefix-independent).
// Keeps nextNum incrementing correctly for prefixed auto titles (avoids a plain parseInt on a
// localized title returning NaN).
export function spaceAutoNum(title: string): number {
  const m = String(title).match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : 0;
}

// Load-time migration — promotes an old pure-numeric space title ("3") to the localized
// space.autoTitle form (i18n). Excel-style naming makes it explicit that the thing is a space. Only
// pure numbers are targeted, so a title the user renamed is preserved. Idempotent (after conversion
// the title is no longer pure numeric, so a re-run changes nothing). Applied once right after the
// windowBoot restore.
export function migrateSpaceTitle(title: string): string {
  return /^\d+$/.test(title.trim()) ? tmsg("space.autoTitle", { n: title.trim() }) : title;
}

function makeWorkspace(id: string, opts: NewWorkspaceOpts): Workspace {
  const c = makeContent(tmsg("space.autoTitle", { n: 1 }), opts.program);
  const alias = opts.alias.trim() || baseName(opts.root);
  return {
    id,
    title: alias,
    regionOpen: { left: true, right: false },
    leftRailPlacement: DEFAULT_RAIL_PLACEMENT, // flow — the rail attaches to the focused panel
    sidebarLayouts: { left: initialSidebarLayout([]), right: initialSidebarLayout([]) },
    root: opts.root,
    spaces: [c],
    activeSpaceId: c.id,
  };
}

// Frequently used error.
const noWorkspace = (id: string): CmdErr =>
  err("TARGET_NOT_FOUND", tmsg("workspace.notFound", { id }));

// The store is outside the module boundary — if a hot swap replaced it, registration, subscription,
// and screen state would all become new, while the filling side treats the fill as already done and
// never refills (empty forever).
export const useSessions = moduleState("state/sessions#store", () =>
  create<SessionsStore>((set, get) => ({
  // The boot (main.tsx) prepares the default root (~/.soksak/workspaces/workspace1) and then creates the
  // first workspace through bootstrapFirstWorkspace (P3) — that happens before render, so the
  // zero-workspace state never appears on screen (an exception state of boot failure only).
  workspaces: [],
  activeId: "",

  bootstrapFirstWorkspace: (root, opts) => {
    if (get().workspaces.length > 0) return; // idempotent — boot only, once
    // Automatic workspace1 is "P1"; otherwise the default display name is the folder name — an alias
    // set by the creator (control plane) wins (init query alias).
    const alias = opts?.alias || (baseName(root) === "workspace1" ? "P1" : "");
    // Issued, not written down. "t1" was a counter with no prefix — the one
    // shape docs/tech/NAMING.md N4 names as the thing a fixture must never be,
    // and the workspace every pane and space hangs off was the one entity
    // outside N1 (measured 2026-08-16: state.tree answered "t1" beside
    // pan-axhgio and spc-tbsgmi).
    const t = makeWorkspace(issueId("workspace"), { alias, root });
    set({ workspaces: [t], activeId: t.id });
  },

  restoreWorkspaces: (workspaces, activeId) => {
    if (get().workspaces.length > 0) return; // idempotent — boot only, once (exclusive with bootstrap)
    if (workspaces.length === 0) return; // an empty restore is ignored (boot falls back to bootstrap)
    const active = workspaces.some((t) => t.id === activeId) ? activeId : workspaces[0].id;
    set({ workspaces, activeId: active });
  },

  addWorkspace: (opts) => {
    // P5 no duplicates — when a workspace with the same root exists (normalization is the caller's
    // job), activate that workspace and report existing.
    const dup = get().workspaces.find((t) => t.root === opts.root);
    if (dup) {
      set({ activeId: dup.id });
      const c = dup.spaces.find((x) => x.id === dup.activeSpaceId)!;
      const g = allGroups(c.layout)[0];
      const v = g.tabs[0];
      return ok({
        projectId: dup.id,
        contentId: c.id,
        groupId: g.id,
        ...(v ? idsOfView(v) : {}),
        existing: true,
      });
    }
    const id = issueId("workspace");
    const t = makeWorkspace(id, opts);
    set((s) => ({ workspaces: [...s.workspaces, t], activeId: id }));
    const c = t.spaces[0];
    const g = allGroups(c.layout)[0];
    const v = g.tabs[0];
    return ok({
      projectId: id,
      contentId: c.id,
      groupId: g.id,
      ...(v ? idsOfView(v) : {}),
    });
  },

  closeTab: (id) => {
    let r: CmdResult<{ activeProjectId: string }> = noWorkspace(id);
    set((s) => {
      if (!s.workspaces.some((t) => t.id === id)) return s;
      if (s.workspaces.length <= 1) {
        r = err("LAST_ITEM", tmsg("workspace.lastCannotClose"));
        return s;
      }
      const idx = s.workspaces.findIndex((t) => t.id === id);
      const workspaces = s.workspaces.filter((t) => t.id !== id);
      let activeId = s.activeId;
      if (activeId === id) {
        activeId = (workspaces[idx] ?? workspaces[idx - 1] ?? workspaces[0]).id;
      }
      r = ok({ activeProjectId: activeId });
      return { workspaces, activeId };
    });
    return r;
  },

  setActive: (id) => {
    let r: CmdResult = noWorkspace(id);
    set((s) => {
      if (!s.workspaces.some((t) => t.id === id)) return s;
      r = ok({});
      return s.activeId === id ? s : { activeId: id };
    });
    return r;
  },

  renameWorkspace: (id, title) => {
    let r: CmdResult = noWorkspace(id);
    set((s) => {
      if (!s.workspaces.some((t) => t.id === id)) return s;
      r = ok({});
      return { workspaces: s.workspaces.map((t) => (t.id === id ? { ...t, title } : t)) };
    });
    return r;
  },

  setWorkspaceColor: (id, color) => {
    let r: CmdResult = noWorkspace(id);
    set((s) => {
      if (!s.workspaces.some((t) => t.id === id)) return s;
      r = ok({});
      return {
        workspaces: s.workspaces.map((t) =>
          t.id === id ? { ...t, color: color ?? undefined } : t,
        ),
      };
    });
    return r;
  },

  updateWorkspace: (id, patch) => {
    let r: CmdResult = noWorkspace(id);
    set((s) => {
      if (!s.workspaces.some((t) => t.id === id)) return s;
      r = ok({});
      return {
        workspaces: s.workspaces.map((t) => {
          if (t.id !== id) return t;
          const next = { ...t };
          // Ignore an empty title (keeps the invariant that a title is never empty).
          if (patch.title !== undefined && patch.title.trim()) {
            next.title = patch.title.trim();
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

  toggleRegion: (id, region, open) => {
    let r: CmdResult<{ region: SidebarRegion; open: boolean }> = noWorkspace(id);
    set((s) => {
      const t = s.workspaces.find((x) => x.id === id);
      if (!t) return s;
      const next = open ?? !t.regionOpen[region];
      r = ok({ region, open: next });
      if (next === t.regionOpen[region]) return s; // idempotent
      return {
        workspaces: s.workspaces.map((x) =>
          x.id === id ? { ...x, regionOpen: { ...x.regionOpen, [region]: next } } : x,
        ),
      };
    });
    return r;
  },

  setLeftRailPlacement: (id, placement) => {
    let r: CmdResult<{ placement: RailPlacement }> = noWorkspace(id);
    if (
      placement.mode === "pin" &&
      (!Number.isFinite(placement.station) ||
        placement.station < 0 ||
        placement.station > 100)
    ) {
      return err("INVALID_PARAMS", tmsg("layout.rail.stationRange"));
    }
    set((s) => {
      const workspace = s.workspaces.find((item) => item.id === id);
      if (!workspace) return s;
      const current = workspace.leftRailPlacement ?? DEFAULT_RAIL_PLACEMENT;
      if (
        current.mode === placement.mode &&
        (current.mode === "flow" ||
          (placement.mode === "pin" && current.station === placement.station))
      ) {
        r = ok({ placement: current });
        return s;
      }
      const nextWorkspace = { ...workspace, leftRailPlacement: placement };
      const conflict = leftRailLayoutConflict(nextWorkspace);
      if (conflict) {
        r = err(
          "INVALID_PARAMS",
          tmsg("layout.rail.pinNotClean"),
          conflict.data,
        );
        return s;
      }
      r = ok({ placement });
      // Even with a different persisted mode, an identical resolved station/cells/topology leaves
      // the display owner nothing to do. When the actual display solution does change, open a
      // revision before the WorkspacePlane publish so that render consumes the exact revision.
      openProjectArrangementTransition(workspace, nextWorkspace);
      return {
        workspaces: s.workspaces.map((item) =>
          item.id === id ? { ...item, leftRailPlacement: placement } : item,
        ),
      };
    });
    return r;
  },

  setSidebarTab: (id, region, viewKey) => {
    let r: CmdResult<{ sidebarTab: string }> = noWorkspace(id);
    set((s) => {
      const t = s.workspaces.find((x) => x.id === id);
      if (!t) return s;
      if (!hasSidebarView(t.sidebarLayouts[region], viewKey)) {
        r = err("TARGET_NOT_FOUND", tmsg("sidebar.view.notFound", { viewKey }));
        return s;
      }
      r = ok({ sidebarTab: viewKey });
      // Make viewKey the active one only in the leaf group that holds it (other leaves unchanged).
      const next = mapLeaves(t.sidebarLayouts[region], (g) =>
        g.viewKeys.includes(viewKey) && g.activeViewKey !== viewKey
          ? { ...g, activeViewKey: viewKey }
          : g,
      );
      return { workspaces: withSidebarLayout(s.workspaces, id, region, next) };
    });
    return r;
  },

  reconcileSidebar: (id, region, registeredKeys) => {
    set((s) => {
      const t = s.workspaces.find((x) => x.id === id);
      if (!t) return s;
      const next = reconcileSidebarLayout(t.sidebarLayouts[region], registeredKeys);
      // No change keeps the reference — a new one every render is an endless reconcile.
      if (next === t.sidebarLayouts[region]) return s;
      return { workspaces: withSidebarLayout(s.workspaces, id, region, next) };
    });
  },

  moveSidebarView: (id, region, viewKey, drop) => {
    let r: CmdResult = noWorkspace(id);
    set((s) => {
      const t = s.workspaces.find((x) => x.id === id);
      if (!t) return s;
      if (!hasSidebarView(t.sidebarLayouts[region], viewKey)) {
        r = err("TARGET_NOT_FOUND", tmsg("sidebar.view.notFound", { viewKey }));
        return s;
      }
      const next = moveSidebarViewT(t.sidebarLayouts[region], viewKey, drop, newSplitId);
      r = ok({});
      return { workspaces: withSidebarLayout(s.workspaces, id, region, next) };
    });
    return r;
  },

  resizeSidebar: (id, region, splitId, sizes) => {
    let r: CmdResult = noWorkspace(id);
    set((s) => {
      const t = s.workspaces.find((x) => x.id === id);
      if (!t) return s;
      if (!findSplitTree(t.sidebarLayouts[region], splitId)) {
        r = err("TARGET_NOT_FOUND", tmsg("sidebar.split.notFound", { splitId }));
        return s;
      }
      r = ok({});
      const next = resizeSplitTree(t.sidebarLayouts[region], splitId, sizes);
      return { workspaces: withSidebarLayout(s.workspaces, id, region, next) };
    });
    return r;
  },

  addContent: (projectId, program) => {
    let r: CmdResult<
      { contentId: string; groupId: string } & Partial<NewViewIds>
    > = noWorkspace(projectId);
    set((s) => {
      const t = s.workspaces.find((x) => x.id === projectId);
      if (!t) return s;
      const nextNum =
        Math.max(0, ...t.spaces.map((c) => spaceAutoNum(c.title))) + 1;
      const c = makeContent(tmsg("space.autoTitle", { n: nextNum }), program);
      const g = allGroups(c.layout)[0];
      const v = g.tabs[0];
      const nextWorkspace = {
        ...t,
        spaces: [...t.spaces, c],
        activeSpaceId: c.id,
      };
      const conflict = leftRailLayoutConflict(nextWorkspace);
      if (conflict) {
        r = conflict;
        return s;
      }
      r = ok({ contentId: c.id, groupId: g.id, ...(v ? idsOfView(v) : {}) });
      return {
        workspaces: mapWorkspace(s.workspaces, projectId, () => nextWorkspace),
      };
    });
    return r;
  },

  closeContent: (projectId, contentId) => {
    let r: CmdResult<{ activeSpaceId: string }> = noWorkspace(projectId);
    set((s) => {
      const t = s.workspaces.find((x) => x.id === projectId);
      if (!t) return s;
      const idx = t.spaces.findIndex((c) => c.id === contentId);
      if (idx === -1) {
        r = err("TARGET_NOT_FOUND", tmsg("space.notFound", { id: contentId }));
        return s;
      }
      if (t.spaces.length <= 1) {
        r = err("LAST_ITEM", tmsg("space.lastCannotClose"));
        return s;
      }
      const spaces = t.spaces.filter((c) => c.id !== contentId);
      let activeSpaceId = t.activeSpaceId;
      if (activeSpaceId === contentId) {
        activeSpaceId = (spaces[idx] ?? spaces[idx - 1] ?? spaces[0]).id;
      }
      const nextWorkspace = { ...t, spaces, activeSpaceId };
      const conflict = leftRailLayoutConflict(nextWorkspace);
      if (conflict) {
        r = conflict;
        return s;
      }
      r = ok({ activeSpaceId });
      return {
        workspaces: mapWorkspace(s.workspaces, projectId, () => nextWorkspace),
      };
    });
    return r;
  },

  setActiveContent: (projectId, contentId) => {
    let r: CmdResult = noWorkspace(projectId);
    set((s) => {
      const t = s.workspaces.find((x) => x.id === projectId);
      if (!t) return s;
      if (!t.spaces.some((c) => c.id === contentId)) {
        r = err("TARGET_NOT_FOUND", tmsg("space.notFound", { id: contentId }));
        return s;
      }
      if (t.activeSpaceId === contentId) {
        r = ok({});
        return s; // already active (prevents a needless re-render)
      }
      const nextWorkspace = { ...t, activeSpaceId: contentId };
      const conflict = leftRailLayoutConflict(nextWorkspace);
      if (conflict) {
        r = conflict;
        return s;
      }
      r = ok({});
      return {
        workspaces: mapWorkspace(s.workspaces, projectId, () => nextWorkspace),
      };
    });
    return r;
  },

  renameContent: (projectId, contentId, title) => {
    let r: CmdResult = noWorkspace(projectId);
    set((s) => {
      const t = s.workspaces.find((x) => x.id === projectId);
      if (!t) return s;
      if (!t.spaces.some((c) => c.id === contentId)) {
        r = err("TARGET_NOT_FOUND", tmsg("space.notFound", { id: contentId }));
        return s;
      }
      r = ok({});
      return {
        workspaces: mapWorkspace(s.workspaces, projectId, (x) =>
          mapContent(x, contentId, (c) => ({ ...c, title })),
        ),
      };
    });
    return r;
  },

  bindContentRail: (projectId, contentId, viewId) => {
    let r: CmdResult<{ viewId: string }> = noWorkspace(projectId);
    set((s) => {
      const workspace = s.workspaces.find((item) => item.id === projectId);
      const content = workspace?.spaces.find((item) => item.id === contentId);
      if (!workspace || !content) {
        r = err("TARGET_NOT_FOUND", tmsg("space.notFound", { id: contentId }));
        return s;
      }
      // Rebinding allowed: the active content view sets the space binding — the same view is
      // idempotent, a different view replaces it. On the same resolution (instanceKey) R1 blocks the
      // slot switch so the rail stays calm, and empty-group focus does not take this path (the
      // caller calls only with an active view), so the existing binding is kept.
      if (content.railBindingTabId === viewId) {
        r = ok({ viewId });
        return s;
      }
      if (!allGroups(content.layout).some((g) => g.tabs.some((v) => v.id === viewId))) {
        r = err("TARGET_NOT_FOUND", tmsg("view.notFound", { viewId }));
        return s;
      }
      r = ok({ viewId });
      return {
        workspaces: mapWorkspace(s.workspaces, projectId, (item) => ({
          ...item,
          spaces: item.spaces.map((candidate) =>
            candidate.id === contentId
              ? { ...candidate, railBindingTabId: viewId }
              : candidate,
          ),
        })),
      };
    });
    return r;
  },

  addViewToGroup: (projectId, program, groupId, opts) => {
    let r: CmdResult<{ groupId: string } & NewViewIds> = noWorkspace(projectId);
    set((s) => {
      const t = s.workspaces.find((x) => x.id === projectId);
      if (!t) return s;
      // Target group: an explicit id (searched across all content) or the active group of the
      // active content.
      const content = groupId
        ? contentOfGroup(t, groupId)
        : activeContentOf(t);
      if (!content) {
        r = err(
          "TARGET_NOT_FOUND",
          tmsg("panel.notFound", {
            groupId: groupId ?? tmsg("panel.activeFallback"),
          }),
        );
        return s;
      }
      const target = groupId ?? content.activePaneId;
      const v = newViewFor(program, opts);
      if (!v) {
        // Unregistered program — the core no longer has a terminal fallback (a terminal is a plugin
        // view too).
        r = err("TARGET_NOT_FOUND", tmsg("program.notFound", { program }));
        return s;
      }
      r = ok({ groupId: target, ...idsOfView(v) });
      return {
        workspaces: mapWorkspace(s.workspaces, projectId, (x) =>
          mapContent(x, content.id, (c) => ({
            ...c,
            layout: mapGroupNode(c.layout, target, (g) => ({
              ...g,
              tabs: [...g.tabs, v],
              activeTabId: v.id,
            })),
            activePaneId: target,
          })),
        ),
      };
    });
    return r;
  },



  openPluginView: (projectId, pluginId, view, title) => {
    let r: CmdResult<{ viewId: string; groupId: string; existing: boolean }> =
      noWorkspace(projectId);
    set((s) => {
      const t = s.workspaces.find((x) => x.id === projectId);
      if (!t) return s;
      const content = activeContentOf(t);
      if (!content) return s;
      // When the same plugin view is already open, activate that group/view (reuse).
      const existing = allViews(content.layout).find(
        (v) => v.pluginId === pluginId && v.view === view,
      );
      if (existing) {
        const grp = findGroupOfView(content.layout, existing.id);
        if (!grp) return s;
        r = ok({ viewId: existing.id, groupId: grp.id, existing: true });
        return {
          workspaces: mapWorkspace(s.workspaces, projectId, (x) =>
            mapContent(x, content.id, (c) => ({
              ...c,
              layout: mapGroupNode(c.layout, grp.id, (g) => ({
                ...g,
                activeTabId: existing.id,
              })),
              activePaneId: grp.id,
            })),
          ),
        };
      }
      const v: Tab = {
        id: newViewId(),
        kind: "plugin",
        title,
        pluginId,
        view,
      };
      r = ok({ viewId: v.id, groupId: content.activePaneId, existing: false });
      return {
        workspaces: mapWorkspace(s.workspaces, projectId, (x) =>
          mapContent(x, content.id, (c) => ({
            ...c,
            layout: mapGroupNode(c.layout, c.activePaneId, (g) => ({
              ...g,
              tabs: [...g.tabs, v],
              activeTabId: v.id,
            })),
          })),
        ),
      };
    });
    return r;
  },

  closeView: (projectId, viewId) => {
    let r: CmdResult<{ activePaneId: string; activeTabId: string }> =
      noWorkspace(projectId);
    set((s) => {
      const t = s.workspaces.find((x) => x.id === projectId);
      if (!t) return s;
      const content = contentOfView(t, viewId);
      if (!content) {
        r = err("TARGET_NOT_FOUND", tmsg("view.notFound", { viewId }));
        return s;
      }
      // When the content empties completely after the close, keep it as a single empty tab — content
      // and group stay (pure skeleton: an empty tab is a legitimate state). This holds both for the
      // last view of a single leaf group and for the case where one side of a split is an empty
      // group so removeView cleans the empty groups up and the whole tree empties (removeView →
      // tree=null). Leave the closed view's group empty. Do not mistake tree=null for "no workspace"
      // (the r initial-value trap).
      const grp = findGroupOfView(content.layout, viewId);
      const { tree } = removeView(content.layout, viewId);
      if (!tree) {
        const next = normalizeActiveGroupC({
          ...content,
          layout: splitLeaf({ ...grp!, tabs: [], activeTabId: "" }),
        });
        const nextWorkspace = mapContent(t, content.id, () => next);
        const conflict = leftRailLayoutConflict(nextWorkspace);
        if (conflict) {
          r = conflict;
          return s;
        }
        r = ok({ activePaneId: next.activePaneId, activeTabId: "" });
        return {
          workspaces: mapWorkspace(s.workspaces, projectId, () => nextWorkspace),
        };
      }
      let next = normalizeActiveGroupC({ ...content, layout: tree });
      // R6 succession (plans/sidebar-projection-spec.md) — when the closed view was the bound view
      // of this workspace (the end of the active chain), move the binding back to the most recent
      // surviving view in the focusHistory of the same space. The adjacent tab is the next fallback
      // (the default succession of removeView above already did that).
      const activeGroup = findGroup(next.layout, next.activePaneId);
      const nextWorkspace = mapContent(t, content.id, () => next);
      const conflict = leftRailLayoutConflict(nextWorkspace);
      if (conflict) {
        r = conflict;
        return s;
      }
      r = ok({
        activePaneId: next.activePaneId,
        activeTabId: activeGroup?.activeTabId ?? "",
      });
      return {
        workspaces: mapWorkspace(s.workspaces, projectId, () => nextWorkspace),
      };
    });
    return r;
  },

  setActiveView: (projectId, viewId) => {
    noteActivation("setActiveView", viewId); // activation ledger — call count and call path (observation)
    let r: CmdResult<{ moved: boolean }> = noWorkspace(projectId);
    set((s) => {
      const t = s.workspaces.find((x) => x.id === projectId);
      if (!t) return s;
      const content = contentOfView(t, viewId);
      if (!content) {
        r = err("TARGET_NOT_FOUND", tmsg("view.notFound", { viewId }));
        return s;
      }
      const grp = findGroupOfView(content.layout, viewId);
      if (!grp) return s;
      const nextWorkspace = mapContent(t, content.id, (c) => ({
        ...c,
        layout: mapGroupNode(c.layout, grp.id, (g) => ({
          ...g,
          activeTabId: viewId,
        })),
        activePaneId: grp.id,
      }));
      const moved = openProjectArrangementTransition(t, nextWorkspace);
      r = ok({ moved });
      // The WorkspacePlane adapter starts preparing the exact revision before the new workspace
      // subscriber. The React layout commit does not reopen this transaction; it claims the same
      // revision promise.
      return {
        workspaces: mapWorkspace(s.workspaces, projectId, () => nextWorkspace),
      };
    });
    return r;
  },

  setActiveGroup: (projectId, groupId) => {
    noteActivation("setActiveGroup", groupId); // activation ledger (observation)
    let r: CmdResult = noWorkspace(projectId);
    set((s) => {
      const t = s.workspaces.find((x) => x.id === projectId);
      if (!t) return s;
      const content = contentOfGroup(t, groupId);
      if (!content) {
        r = err("TARGET_NOT_FOUND", tmsg("panel.notFound", { groupId }));
        return s;
      }
      // Already active means no state change (prevents a needless re-render on every body click).
      if (
        content.id === t.activeSpaceId &&
        content.activePaneId === groupId
      ) {
        r = ok({});
        return s;
      }
      const nextWorkspace = {
        ...mapContent(t, content.id, (c) => ({
          ...c,
          activePaneId: groupId,
        })),
        activeSpaceId: content.id,
      };
      const conflict = leftRailLayoutConflict(nextWorkspace);
      if (conflict) {
        r = conflict;
        return s;
      }
      openProjectArrangementTransition(t, nextWorkspace);
      r = ok({});
      return {
        workspaces: mapWorkspace(s.workspaces, projectId, () => nextWorkspace),
      };
    });
    return r;
  },

  maximizeView: (projectId, viewId) => {
    let r: CmdResult<{ viewId: string }> = noWorkspace(projectId);
    set((s) => {
      const t = s.workspaces.find((x) => x.id === projectId);
      if (!t) return s;
      const content = contentOfView(t, viewId);
      if (!content) {
        r = err("TARGET_NOT_FOUND", tmsg("view.notFound", { viewId }));
        return s;
      }
      const grp = findGroupOfView(content.layout, viewId);
      if (!grp) return s;
      const nextWorkspace = {
        ...mapContent(t, content.id, (c) => ({
            ...c,
            maximizedTabId: viewId,
            // Maximized view = the active view of that group + the active group (display matches input).
            layout: mapGroupNode(c.layout, grp.id, (g) => ({
              ...g,
              activeTabId: viewId,
            })),
            activePaneId: grp.id,
          })),
        activeSpaceId: content.id,
      };
      const conflict = leftRailLayoutConflict(nextWorkspace);
      if (conflict) {
        r = conflict;
        return s;
      }
      openProjectArrangementTransition(t, nextWorkspace);
      r = ok({ viewId });
      return {
        workspaces: mapWorkspace(s.workspaces, projectId, () => nextWorkspace),
      };
    });
    return r;
  },

  restoreView: (projectId) => {
    let r: CmdResult<{ viewId: string | null }> = noWorkspace(projectId);
    set((s) => {
      const t = s.workspaces.find((x) => x.id === projectId);
      if (!t) return s;
      const content = t.spaces.find((c) => c.id === t.activeSpaceId);
      if (!content) return s;
      r = ok({ viewId: content.maximizedTabId ?? null });
      if (!content.maximizedTabId) return s;
      const nextWorkspace = mapContent(t, content.id, (c) => ({
        ...c,
        maximizedTabId: undefined,
      }));
      openProjectArrangementTransition(t, nextWorkspace);
      return {
        workspaces: mapWorkspace(s.workspaces, projectId, () => nextWorkspace),
      };
    });
    return r;
  },



  // An unsaved file is unified into status.code "dirty" (R5 — double truth removed). Delegates to
  // setViewStatus.
  setFileDirty: (projectId, viewId, dirty) =>
    get().setViewStatus(projectId, viewId, dirty ? { code: "dirty" } : null),

  // View status report/reclaim (R1, R4) — common to every view. null = the field is removed. Same
  // shape as setFileDirty.
  setViewRuntime: (projectId, viewId, patch) => {
    set((s) => {
      const targets = projectId
        ? s.workspaces.filter((t) => t.id === projectId)
        : s.workspaces.filter((t) => contentOfView(t, viewId));
      if (targets.length === 0) return s;
      let workspaces = s.workspaces;
      for (const t of targets) {
        workspaces = mapWorkspace(workspaces, t.id, (x) =>
          mapViewEverywhere(x, viewId, (v) => ({ ...v, ...patch })),
        );
      }
      return { workspaces };
    });
  },

  setViewStatus: (projectId, viewId, status) => {
    let r: CmdResult = noWorkspace(projectId);
    set((s) => {
      const t = s.workspaces.find((x) => x.id === projectId);
      if (!t) return s;
      if (!contentOfView(t, viewId)) {
        r = err("TARGET_NOT_FOUND", tmsg("view.notFound", { viewId }));
        return s;
      }
      r = ok({});
      return {
        workspaces: mapWorkspace(s.workspaces, projectId, (x) =>
          mapViewEverywhere(x, viewId, (v) => ({
            ...v,
            status: status ?? undefined,
          })),
        ),
      };
    });
    return r;
  },

  // Update the tab title for any view kind (dynamic title from a content plugin — e.g. page
  // <title>). Empty is ignored.
  setViewTitle: (projectId, viewId, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    set((s) => ({
      workspaces: mapWorkspace(s.workspaces, projectId, (x) =>
        mapViewEverywhere(x, viewId, (v) => ({ ...v, title: trimmed })),
      ),
    }));
  },

  setViewIcon: (projectId, viewId, icon) => {
    const trimmed = icon.trim();
    set((s) => ({
      workspaces: mapWorkspace(s.workspaces, projectId, (x) =>
        mapViewEverywhere(x, viewId, (v) => {
          if (v.kind !== "plugin") return v;
          if (!trimmed) {
            const { icon: _drop, ...rest } = v;
            return rest as Tab;
          }
          return { ...v, icon: trimmed };
        }),
      ),
    }));
  },

  renameView: (projectId, viewId, label) => {
    const trimmed = label.trim();
    let r: CmdResult<{ label: string }> = err(
      "TARGET_NOT_FOUND",
      tmsg("view.notFound", { viewId }),
    );
    set((s) => ({
      workspaces: mapWorkspace(s.workspaces, projectId, (x) =>
        mapViewEverywhere(x, viewId, (v) => {
          r = ok({ label: trimmed });
          if (!trimmed) {
            const { customLabel: _drop, ...rest } = v;
            return rest as Tab;
          }
          return { ...v, customLabel: trimmed };
        }),
      ),
    }));
    return r;
  },

  moveViewToGroup: (projectId, viewId, targetGroupId, zone) => {
    let r: CmdResult<{ groupId: string }> = noWorkspace(projectId);
    set((s) => {
      const t = s.workspaces.find((x) => x.id === projectId);
      if (!t) return s;
      const content = contentOfView(t, viewId);
      if (!content) {
        r = err("TARGET_NOT_FOUND", tmsg("view.notFound", { viewId }));
        return s;
      }
      // Only a target group inside the same content is allowed (moving across content is a separate
      // concept).
      if (!hasGroup(content.layout, targetGroupId)) {
        r = err(
          "TARGET_NOT_FOUND",
          tmsg("panel.targetNotFound", { targetGroupId }),
        );
        return s;
      }
      const src = findGroupOfView(content.layout, viewId);
      if (!src) return s;
      const view = src.tabs.find((v) => v.id === viewId);
      if (!view) return s;

      if (zone === "center") {
        if (src.id === targetGroupId) {
          r = ok({ groupId: targetGroupId }); // already that group — idempotent
          return s;
        }
        const { tree } = removeView(content.layout, viewId);
        if (!tree || !hasGroup(tree, targetGroupId)) return s;
        const nextContent = normalizeActiveGroupC({
          ...content,
          layout: mapGroupNode(tree, targetGroupId, (g) => ({
            ...g,
            tabs: [...g.tabs, view],
            activeTabId: view.id,
          })),
          activePaneId: targetGroupId,
        });
        const nextWorkspace = mapContent(t, content.id, () => nextContent);
        const conflict = leftRailLayoutConflict(nextWorkspace);
        if (conflict) {
          r = conflict;
          return s;
        }
        r = ok({ groupId: targetGroupId });
        return {
          workspaces: mapWorkspace(s.workspaces, projectId, () => nextWorkspace),
        };
      }

      // Split: detach from src and place it as a new group beside target.
      if (allViews(content.layout).length <= 1) {
        r = err("LAST_ITEM", tmsg("view.onlyCannotSplit"));
        return s;
      }
      const { tree } = removeView(content.layout, viewId);
      if (!tree || !hasGroup(tree, targetGroupId)) return s;
      const fresh = makeGroup(view);
      const nextContent = normalizeActiveGroupC({
        ...content,
        layout: splitAtGroup(tree, targetGroupId, zone, fresh),
        activePaneId: fresh.id,
      });
      const nextWorkspace = mapContent(t, content.id, () => nextContent);
      const conflict = leftRailLayoutConflict(nextWorkspace);
      if (conflict) {
        r = conflict;
        return s;
      }
      r = ok({ groupId: fresh.id });
      return {
        workspaces: mapWorkspace(s.workspaces, projectId, () => nextWorkspace),
      };
    });
    return r;
  },

  closeGroup: (projectId, groupId) => {
    let r: CmdResult<{ activePaneId: string }> = noWorkspace(projectId);
    set((s) => {
      const t = s.workspaces.find((x) => x.id === projectId);
      if (!t) return s;
      const content = contentOfGroup(t, groupId);
      if (!content) {
        r = err("TARGET_NOT_FOUND", tmsg("panel.notFound", { groupId }));
        return s;
      }
      if (allGroups(content.layout).length <= 1) {
        r = err("LAST_ITEM", tmsg("panel.lastCannotClose"));
        return s;
      }
      const { tree } = removeGroup(content.layout, groupId);
      if (!tree) return s;
      const next = normalizeActiveGroupC({ ...content, layout: tree });
      const nextWorkspace = mapContent(t, content.id, () => next);
      const conflict = leftRailLayoutConflict(nextWorkspace);
      if (conflict) {
        r = conflict;
        return s;
      }
      r = ok({ activePaneId: next.activePaneId });
      return {
        workspaces: mapWorkspace(s.workspaces, projectId, () => nextWorkspace),
      };
    });
    return r;
  },

  moveGroupToGroup: (projectId, sourceGroupId, targetGroupId, zone) => {
    let r: CmdResult<{ groupId: string }> = noWorkspace(projectId);
    set((s) => {
      const t = s.workspaces.find((x) => x.id === projectId);
      if (!t) return s;
      const content = contentOfGroup(t, sourceGroupId);
      if (!content) {
        r = err("TARGET_NOT_FOUND", tmsg("panel.notFound", { groupId: sourceGroupId }));
        return s;
      }
      if (sourceGroupId === targetGroupId) {
        r = ok({ groupId: targetGroupId }); // idempotent
        return s;
      }
      if (!hasGroup(content.layout, targetGroupId)) {
        r = err(
          "TARGET_NOT_FOUND",
          tmsg("panel.targetNotFound", { targetGroupId }),
        );
        return s;
      }
      if (allGroups(content.layout).length <= 1) {
        r = err("LAST_ITEM", tmsg("panel.onlyCannotMove"));
        return s;
      }
      const source = findGroup(content.layout, sourceGroupId);
      if (!source) return s;
      const { tree } = removeGroup(content.layout, sourceGroupId);
      if (!tree || !hasGroup(tree, targetGroupId)) return s;

      if (zone === "center") {
        // Merge every tab of source into target (group join).
        const nextContent = normalizeActiveGroupC({
          ...content,
          layout: mapGroupNode(tree, targetGroupId, (g) => ({
            ...g,
            tabs: [...g.tabs, ...source.tabs],
            activeTabId: source.activeTabId,
          })),
          activePaneId: targetGroupId,
        });
        const nextWorkspace = mapContent(t, content.id, () => nextContent);
        const conflict = leftRailLayoutConflict(nextWorkspace);
        if (conflict) {
          r = conflict;
          return s;
        }
        r = ok({ groupId: targetGroupId });
        return {
          workspaces: mapWorkspace(s.workspaces, projectId, () => nextWorkspace),
        };
      }
      // Relocate the whole group beside target (same id and views kept → no body remount).
      const nextContent = normalizeActiveGroupC({
        ...content,
        layout: splitAtGroup(tree, targetGroupId, zone, source),
        activePaneId: source.id,
      });
      const nextWorkspace = mapContent(t, content.id, () => nextContent);
      const conflict = leftRailLayoutConflict(nextWorkspace);
      if (conflict) {
        r = conflict;
        return s;
      }
      r = ok({ groupId: source.id });
      return {
        workspaces: mapWorkspace(s.workspaces, projectId, () => nextWorkspace),
      };
    });
    return r;
  },

  resizeSplit: (projectId, splitId, sizes) =>
    get().resizeSplits(projectId, [{ splitId, sizes }]),

  resizeSplits: (projectId, updates) => {
    let r: CmdResult = noWorkspace(projectId);
    set((s) => {
      const t = s.workspaces.find((x) => x.id === projectId);
      if (!t) return s;
      if (updates.length === 0) {
        r = ok({});
        return s;
      }
      // A batch is the lines of one layout — applied only to the one content that holds every
      // splitId.
      const content = t.spaces.find((c) =>
        updates.every((u) => findSplit(c.layout, u.splitId)),
      );
      if (!content) {
        r = err(
          "TARGET_NOT_FOUND",
          tmsg("layout.split.notFound", { splitIds: updates.map((u) => u.splitId).join(", ") }),
        );
        return s;
      }
      const nextWorkspace = mapContent(t, content.id, (c) => ({
        ...c,
        layout: updates.reduce(
          (layout, u) => mapSplitNode(layout, u.splitId, u.sizes),
          c.layout,
        ),
      }));
      const conflict = leftRailLayoutConflict(nextWorkspace);
      if (conflict) {
        r = conflict;
        return s;
      }
      r = ok({});
      return {
        workspaces: mapWorkspace(s.workspaces, projectId, () => nextWorkspace),
      };
    });
    return r;
  },

  splitWithNewView: (projectId, targetGroupId, side, program) => {
    let r: CmdResult<{ groupId: string } & Partial<NewViewIds>> =
      noWorkspace(projectId);
    set((s) => {
      const t = s.workspaces.find((x) => x.id === projectId);
      if (!t) return s;
      const content = contentOfGroup(t, targetGroupId);
      if (!content) {
        r = err("TARGET_NOT_FOUND", tmsg("panel.notFound", { groupId: targetGroupId }));
        return s;
      }
      // With program given, that program's view; unset or unregistered gives an empty group
      // (empty panel — pure skeleton).
      const v = program ? newViewFor(program) : null;
      const fresh = makeGroup(v ?? undefined);
      r = ok({ groupId: fresh.id, ...(v ? idsOfView(v) : {}) });
      return {
        workspaces: mapWorkspace(s.workspaces, projectId, (x) =>
          mapContent(x, content.id, (c) =>
            normalizeActiveGroupC({
              ...c,
              layout: splitAtGroup(c.layout, targetGroupId, side, fresh),
              activePaneId: fresh.id,
            }),
          ),
        ),
      };
    });
    return r;
  },

})),
);
