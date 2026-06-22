// 좌측 사이드바 레이아웃 = SplitTree<SidebarGroup>. 콘텐츠 영역과 동일한 drag-merge 를 위해
// SplitTree 추상(splitTree.ts)을 재사용한다 — leaf = 탭 묶음(viewKeys + 활성), split = 세로 분할.
//
// [RULE] 사이드바 뷰는 registry 가 소유(viewsForPlacement)하고, 레이아웃은 그 viewKey 들의 *배치*만
// 담는다. 등록 변화(플러그인 활성/비활성)와 reconcile 해 새 뷰는 첫 leaf 에 추가, 사라진 뷰는 제거한다.
// 순회·split·remove 는 splitTree.ts 단일 구현(GroupNode/PaneNode 와 동일 코드).

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

// 등록 뷰 전부를 한 leaf 탭 묶음으로(첫 뷰 활성). 최초 상태·복원 폴백.
export function initialSidebarLayout(registeredKeys: string[]): SidebarLayout {
  return splitLeaf(group(registeredKeys));
}

// 레이아웃의 모든 viewKey(좌→우/상→하, 중복 없음 가정).
export function sidebarViewKeys(layout: SidebarLayout): string[] {
  return leavesOf(layout).flatMap((g) => g.viewKeys);
}

// 각 leaf 의 활성 viewKey(실제 렌더 대상).
export function activeKeysOf(layout: SidebarLayout): string[] {
  return leavesOf(layout)
    .map((g) => g.activeViewKey)
    .filter(Boolean);
}

// 등록 뷰와 reconcile: 사라진 viewKey 제거(+빈 leaf 붕괴), 새 viewKey 는 첫 leaf 에 추가.
// 활성이 사라지면 leaf 활성을 첫 뷰로 보정. 변화 없으면 입력 그대로(참조 보존은 호출부 비교).
export function reconcileSidebarLayout(
  layout: SidebarLayout,
  registeredKeys: string[],
): SidebarLayout {
  const reg = new Set(registeredKeys);
  // 1) 사라진 뷰 제거 + 활성 보정(leaf 별).
  let pruned = mapLeaves(layout, (g) => {
    const viewKeys = g.viewKeys.filter((k) => reg.has(k));
    if (viewKeys.length === g.viewKeys.length && viewKeys.includes(g.activeViewKey)) {
      return g; // 변화 없음
    }
    const activeViewKey = viewKeys.includes(g.activeViewKey)
      ? g.activeViewKey
      : (viewKeys[0] ?? "");
    return { viewKeys, activeViewKey };
  });
  // 빈 leaf 붕괴(전부 비면 빈 leaf 하나).
  const { tree } = removeLeaf(pruned, (g) => g.viewKeys.length === 0);
  pruned = tree ?? splitLeaf(group([]));
  // 2) 새 뷰는 첫 leaf 에 추가(등록 순서 보존).
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

// 드롭 타겟: into=대상 leaf 그룹에 합류(탭), split=대상 옆에 새 leaf 로 분리(세로).
export type SidebarDrop =
  | { type: "into"; targetKey: string }
  | { type: "split"; targetKey: string; before: boolean };

// viewKey 를 가진 leaf 를 찾아 그 그룹 반환(없으면 null).
function groupOf(layout: SidebarLayout, viewKey: string): SidebarGroup | null {
  return leavesOf(layout).find((g) => g.viewKeys.includes(viewKey)) ?? null;
}

// 사이드바 뷰 이동(drag-merge). into=대상 그룹에 탭 합류(이동=활성), split=대상 옆 새 leaf.
export function moveSidebarView(
  layout: SidebarLayout,
  viewKey: string,
  drop: SidebarDrop,
  newSplitId: () => string,
): SidebarLayout {
  const src = groupOf(layout, viewKey);
  if (!src) return layout;
  // 마지막 한 뷰를 자기 그룹에서 split/분리하려는 무의미한 동작은 무시.
  if (drop.type === "split" && src.viewKeys.length <= 1 && src.viewKeys.includes(drop.targetKey)) {
    return layout;
  }
  // 1) 원 그룹에서 viewKey 제거(+활성 보정). 빈 그룹은 붕괴.
  let next = mapLeaves(layout, (g) => {
    if (!g.viewKeys.includes(viewKey)) return g;
    const viewKeys = g.viewKeys.filter((k) => k !== viewKey);
    const activeViewKey = viewKeys.includes(g.activeViewKey)
      ? g.activeViewKey
      : (viewKeys[0] ?? "");
    return { viewKeys, activeViewKey };
  });

  if (drop.type === "into") {
    // 대상 그룹에 합류(이동=활성).
    next = mapLeaves(next, (g) =>
      g.viewKeys.includes(drop.targetKey)
        ? { viewKeys: [...g.viewKeys, viewKey], activeViewKey: viewKey }
        : g,
    );
  } else {
    // 대상 leaf 옆에 새 leaf(분리). insertBeside 의 pred 는 leaf 그룹 단위.
    next = insertBeside(
      next,
      (g) => g.viewKeys.includes(drop.targetKey),
      "col", // 사이드바 분할은 세로
      drop.before,
      group([viewKey]),
      newSplitId,
    );
  }
  // 빈 leaf 붕괴(원 그룹이 비었으면).
  const { tree } = removeLeaf(next, (g) => g.viewKeys.length === 0);
  return tree ?? splitLeaf(group([]));
}

// viewKey 가 레이아웃에 있나(reconcile 후 유효성).
export function hasSidebarView(layout: SidebarLayout, viewKey: string): boolean {
  return sidebarViewKeys(layout).includes(viewKey);
}

// split id 존재 여부(resize 타겟 유효성) — 재export(렌더/액션 공용).
export const hasSidebarSplit = (layout: SidebarLayout, splitId: string): boolean =>
  findSplitTree(layout, splitId);
