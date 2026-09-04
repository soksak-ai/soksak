// Left sidebar layout = SplitTree<SidebarGroup>. Reuses the SplitTree abstraction (splitTree.ts)
// for the same drag-merge as the content area — leaf = tab bundle (viewKeys + active), split =
// vertical split.
//
// [RULE] The registry owns sidebar views (viewsForPlacement); the layout holds only the *placement*
// of those viewKeys. It reconciles with registration changes (plugin enable/disable): new views are
// appended to the first leaf, vanished views are removed. Traversal, split and remove are the
// single implementation in splitTree.ts (same code as PaneNode).

import {
  type SplitTree,
  splitLeaf,
  leavesOf,
  mapLeaves,
  removeLeaf,
  insertBeside,
  findSplitTree,
} from "./splitTree";

export interface SidebarGroup {
  viewKeys: string[];
  activeViewKey: string;
}

export type SidebarLayout = SplitTree<SidebarGroup>;

const group = (viewKeys: string[]): SidebarGroup => ({
  viewKeys,
  activeViewKey: viewKeys[0] ?? "",
});

// All registered views as one leaf tab bundle (first view active). Initial state and restore fallback.
export function initialSidebarLayout(registeredKeys: string[]): SidebarLayout {
  return splitLeaf(group(registeredKeys));
}

// Every viewKey in the layout (left→right / top→bottom, assumed duplicate-free).
export function sidebarViewKeys(layout: SidebarLayout): string[] {
  return leavesOf(layout).flatMap((g) => g.viewKeys);
}

// Active viewKey of each leaf (the actual render target).
export function activeKeysOf(layout: SidebarLayout): string[] {
  return leavesOf(layout)
    .map((g) => g.activeViewKey)
    .filter(Boolean);
}

// Reconcile with registered views: drop vanished viewKeys (and collapse empty leaves), append new
// viewKeys to the first leaf. If the active one is gone, the leaf active falls back to the first
// view. No change returns the input as-is (the caller compares references).
export function reconcileSidebarLayout(
  layout: SidebarLayout,
  registeredKeys: string[],
): SidebarLayout {
  const reg = new Set(registeredKeys);
  // 1) Drop vanished views and fix the active one (per leaf).
  let pruned = mapLeaves(layout, (g) => {
    const viewKeys = g.viewKeys.filter((k) => reg.has(k));
    if (viewKeys.length === g.viewKeys.length && viewKeys.includes(g.activeViewKey)) {
      return g; // no change
    }
    const activeViewKey = viewKeys.includes(g.activeViewKey)
      ? g.activeViewKey
      : (viewKeys[0] ?? "");
    return { viewKeys, activeViewKey };
  });
  // Collapse empty leaves (if all are empty, one empty leaf remains).
  const { tree } = removeLeaf(pruned, (g) => g.viewKeys.length === 0);
  pruned = tree ?? splitLeaf(group([]));
  // 2) Append new views to the first leaf (registration order preserved).
  const present = new Set(sidebarViewKeys(pruned));
  const fresh = registeredKeys.filter((k) => !present.has(k));
  if (fresh.length === 0) return pruned;
  let added = false;
  return mapLeaves(pruned, (g) => {
    if (added) return g;
    added = true;
    const viewKeys = [...g.viewKeys, ...fresh];
    return { viewKeys, activeViewKey: g.activeViewKey || viewKeys[0] || "" };
  });
}

// Drop target: into = join the target leaf group (as a tab), split = separate into a new leaf beside
// the target. dir=row (left/right split) or col (top/bottom split) — the same 4 directions as the
// content area. before = insert ahead (left/top).
export type SidebarDrop =
  | { type: "into"; targetKey: string }
  | { type: "split"; targetKey: string; dir: "row" | "col"; before: boolean };

// Finds the leaf holding viewKey and returns that group (null when absent).
function groupOf(layout: SidebarLayout, viewKey: string): SidebarGroup | null {
  return leavesOf(layout).find((g) => g.viewKeys.includes(viewKey)) ?? null;
}

// Move a sidebar view (drag-merge). into = join the target group as a tab (moved = active), split = new leaf beside the target.
export function moveSidebarView(
  layout: SidebarLayout,
  viewKey: string,
  drop: SidebarDrop,
  newSplitId: () => string,
): SidebarLayout {
  const src = groupOf(layout, viewKey);
  if (!src) return layout;
  // Ignore the meaningless action of splitting the last remaining view out of its own group.
  if (drop.type === "split" && src.viewKeys.length <= 1 && src.viewKeys.includes(drop.targetKey)) {
    return layout;
  }
  // 1) Remove viewKey from the source group (and fix the active one). Empty groups collapse.
  let next = mapLeaves(layout, (g) => {
    if (!g.viewKeys.includes(viewKey)) return g;
    const viewKeys = g.viewKeys.filter((k) => k !== viewKey);
    const activeViewKey = viewKeys.includes(g.activeViewKey)
      ? g.activeViewKey
      : (viewKeys[0] ?? "");
    return { viewKeys, activeViewKey };
  });

  if (drop.type === "into") {
    // Join the target group (moved = active).
    next = mapLeaves(next, (g) =>
      g.viewKeys.includes(drop.targetKey)
        ? { viewKeys: [...g.viewKeys, viewKey], activeViewKey: viewKey }
        : g,
    );
  } else {
    // New leaf beside the target leaf (separate) — dir (row=horizontal / col=vertical) gives the same 4 directions as the content area.
    next = insertBeside(
      next,
      (g) => g.viewKeys.includes(drop.targetKey),
      drop.dir,
      drop.before,
      group([viewKey]),
      newSplitId,
    );
  }
  // Collapse empty leaves (when the source group is empty).
  const { tree } = removeLeaf(next, (g) => g.viewKeys.length === 0);
  return tree ?? splitLeaf(group([]));
}

// Whether viewKey is in the layout (validity after reconcile).
export function hasSidebarView(layout: SidebarLayout, viewKey: string): boolean {
  return sidebarViewKeys(layout).includes(viewKey);
}

// Whether a split id exists (resize target validity) — re-export shared by render and actions.
export const hasSidebarSplit = (layout: SidebarLayout, splitId: string): boolean =>
  findSplitTree(layout, splitId);
