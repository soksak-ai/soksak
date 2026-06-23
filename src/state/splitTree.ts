// 제네릭 split-tree — 뷰 그룹(leaf=ViewGroup)·좌측 사이드바(leaf=SidebarGroup)가 공유하는 단일 추상.
// [RULE] split 트리의 데이터·연산(split/remove/resize/find)·직렬화는 여기 하나뿐이다(중복 구현 금지).
// 소비자는 leaf 페이로드 L 만 다르다. 렌더링만 각자 특화(GroupArea / 사이드바 호스트).

export type SplitTree<L> =
  | { type: "leaf"; value: L }
  | {
      type: "split";
      id: string;
      dir: "row" | "col";
      sizes: number[]; // children 와 같은 길이, 합 1
      children: SplitTree<L>[];
    };

type SplitNode<L> = Extract<SplitTree<L>, { type: "split" }>;

// 균등 분할 비율(합 1).
export const equalSizes = (n: number): number[] =>
  Array.from({ length: n }, () => 1 / n);

export const splitLeaf = <L>(value: L): SplitTree<L> => ({ type: "leaf", value });

// split 노드 sizes 교체(splitId 매칭, children 길이 일치 시만). 불변 — 새 객체 반환.
export function resizeSplitTree<L>(
  node: SplitTree<L>,
  splitId: string,
  sizes: number[],
): SplitTree<L> {
  if (node.type === "leaf") return node;
  if (node.id === splitId && sizes.length === node.children.length) {
    return { ...node, sizes };
  }
  return {
    ...node,
    children: node.children.map((c) => resizeSplitTree(c, splitId, sizes)),
  };
}

// splitId 가 트리에 존재하는가.
export function findSplitTree<L>(node: SplitTree<L>, splitId: string): boolean {
  if (node.type === "leaf") return false;
  if (node.id === splitId) return true;
  return node.children.some((c) => findSplitTree(c, splitId));
}

// leaf 값들을 좌→우/상→하 순서로 수집.
export function leavesOf<L>(node: SplitTree<L>): L[] {
  return node.type === "leaf" ? [node.value] : node.children.flatMap(leavesOf);
}

// 모든 leaf 값을 fn 으로 변환(구조 보존). 특정 leaf 만 바꾸려면 fn 안에서 분기.
export function mapLeaves<L>(
  node: SplitTree<L>,
  fn: (v: L) => L,
): SplitTree<L> {
  if (node.type === "leaf") return { type: "leaf", value: fn(node.value) };
  return { ...node, children: node.children.map((c) => mapLeaves(c, fn)) };
}

// pred 매칭 leaf 제거. 빈 split=null, 자식 1개=붕괴, 자식 수가 줄면 sizes 균등 재정규화.
export function removeLeaf<L>(
  node: SplitTree<L>,
  pred: (v: L) => boolean,
): { tree: SplitTree<L> | null; removed: L | null } {
  if (node.type === "leaf") {
    return pred(node.value)
      ? { tree: null, removed: node.value }
      : { tree: node, removed: null };
  }
  let removed: L | null = null;
  const children: SplitTree<L>[] = [];
  for (const c of node.children) {
    const r = removeLeaf(c, pred);
    if (r.removed != null) removed = r.removed;
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

// pred 매칭 leaf 를 fresh 와 분할(dir 방향, before=새 leaf 가 앞). 같은 dir split 의 직속 형제면
// 중첩 없이 형제로 삽입(splitAtGroup/splitInTree 의 중첩 회피와 동일). 삽입 시 sizes 균등 재정규화.
export function insertBeside<L>(
  node: SplitTree<L>,
  pred: (v: L) => boolean,
  dir: "row" | "col",
  before: boolean,
  fresh: L,
  newSplitId: () => string,
): SplitTree<L> {
  if (node.type === "leaf") {
    if (!pred(node.value)) return node;
    const target = splitLeaf(node.value);
    const freshNode = splitLeaf(fresh);
    return {
      type: "split",
      id: newSplitId(),
      dir,
      sizes: equalSizes(2),
      children: before ? [freshNode, target] : [target, freshNode],
    };
  }
  if (node.dir === dir) {
    const idx = node.children.findIndex(
      (c) => c.type === "leaf" && pred(c.value),
    );
    if (idx !== -1) {
      const children = [...node.children];
      children.splice(before ? idx : idx + 1, 0, splitLeaf(fresh));
      return { ...node, children, sizes: equalSizes(children.length) };
    }
  }
  return {
    ...node,
    children: node.children.map((c) =>
      insertBeside(c, pred, dir, before, fresh, newSplitId),
    ),
  };
}

// ── 직렬화 ───────────────────────────────────────────────────────────────────
// split id 는 담지 않는다(복원 시 재생성). leaf 는 변환기로 L↔S 매핑(L=ViewGroup→스냅샷 등).

export type SplitSnapshot<S> =
  | { t: "l"; v: S }
  | { t: "s"; dir: "row" | "col"; sizes: number[]; children: SplitSnapshot<S>[] };

export function serializeSplitTree<L, S>(
  node: SplitTree<L>,
  serializeLeaf: (v: L) => S,
): SplitSnapshot<S> {
  if (node.type === "leaf") return { t: "l", v: serializeLeaf(node.value) };
  return {
    t: "s",
    dir: node.dir,
    sizes: node.sizes,
    children: node.children.map((c) => serializeSplitTree(c, serializeLeaf)),
  };
}

export function deserializeSplitTree<L, S>(
  snap: SplitSnapshot<S>,
  deserializeLeaf: (v: S) => L,
  newSplitId: () => string,
): SplitTree<L> {
  if (snap.t === "l") return { type: "leaf", value: deserializeLeaf(snap.v) };
  return {
    type: "split",
    id: newSplitId(),
    dir: snap.dir,
    sizes: snap.sizes,
    children: snap.children.map((c) =>
      deserializeSplitTree(c, deserializeLeaf, newSplitId),
    ),
  };
}

export type { SplitNode };
