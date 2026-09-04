// Generic split tree — the single abstraction shared by view groups (leaf=Pane) and the left sidebar (leaf=SidebarGroup).
// [RULE] The split tree data, its operations (split/remove/resize/find), and its serialization exist here only (no duplicate implementation).
// Consumers differ only in the leaf payload L. Rendering alone is specialized per consumer (GroupArea / the sidebar host).

export type SplitTree<L> =
  | { type: "leaf"; value: L }
  | {
      type: "split";
      id: string;
      dir: "row" | "col";
      sizes: number[]; // same length as children, sums to 1
      children: SplitTree<L>[];
    };

type SplitNode<L> = Extract<SplitTree<L>, { type: "split" }>;

// Equal split ratios (sum 1).
export const equalSizes = (n: number): number[] =>
  Array.from({ length: n }, () => 1 / n);

export const splitLeaf = <L>(value: L): SplitTree<L> => ({ type: "leaf", value });

// Replaces the sizes of a split node (matching splitId, only when the children length matches). Immutable — returns a new object.
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

// Whether splitId exists in the tree.
export function findSplitTree<L>(node: SplitTree<L>, splitId: string): boolean {
  if (node.type === "leaf") return false;
  if (node.id === splitId) return true;
  return node.children.some((c) => findSplitTree(c, splitId));
}

// Collects leaf values in left→right / top→bottom order.
export function leavesOf<L>(node: SplitTree<L>): L[] {
  return node.type === "leaf" ? [node.value] : node.children.flatMap(leavesOf);
}

// Maps every leaf value through fn (structure preserved). Branch inside fn to change specific leaves only.
export function mapLeaves<L>(
  node: SplitTree<L>,
  fn: (v: L) => L,
): SplitTree<L> {
  if (node.type === "leaf") return { type: "leaf", value: fn(node.value) };
  return { ...node, children: node.children.map((c) => mapLeaves(c, fn)) };
}

// Removes leaves matching pred. Empty split=null, one child=collapse, sizes re-normalized to equal when the child count drops.
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

// Splits the leaf matching pred against fresh (along dir, before = the new leaf goes first). When it is a
// direct sibling in a split of the same dir, inserts as a sibling without nesting (the same nesting avoidance
// as splitAtGroup/splitInTree). sizes re-normalized to equal on insert.
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

// ── Serialization ───────────────────────────────────────────────────────────
// split ids are not stored (regenerated on restore). Leaves map L↔S through converters (L=Pane→snapshot, etc.).

export type SplitSnapshot<S> =
  | { t: "l"; v: S }
  | {
      t: "s";
      id: string;
      dir: "row" | "col";
      sizes: number[];
      children: SplitSnapshot<S>[];
    };

export function serializeSplitTree<L, S>(
  node: SplitTree<L>,
  serializeLeaf: (v: L) => S,
): SplitSnapshot<S> {
  if (node.type === "leaf") return { t: "l", v: serializeLeaf(node.value) };
  return {
    t: "s",
    // The split id is stored like every other. It was omitted on the ground that
    // it is referenced nowhere, which left one kind of id whose name a restore
    // changed — so a reader had to know which kind it was holding before it
    // could tell whether the name would still be there. One rule is worth more
    // than an exception nobody can act on (NAMING N2a).
    id: node.id,
    dir: node.dir,
    sizes: node.sizes,
    children: node.children.map((c) => serializeSplitTree(c, serializeLeaf)),
  };
}

// No generator. Every id is in the snapshot (NAMING N2a) and one that is not is a record this
// build refuses before this point (windowSnapshotShape.ts), so a fallback would have nothing to do.
export function deserializeSplitTree<L, S>(
  snap: SplitSnapshot<S>,
  deserializeLeaf: (v: S) => L,
): SplitTree<L> {
  if (snap.t === "l") return { type: "leaf", value: deserializeLeaf(snap.v) };
  return {
    type: "split",
    id: snap.id,
    dir: snap.dir,
    sizes: snap.sizes,
    children: snap.children.map((c) => deserializeSplitTree(c, deserializeLeaf)),
  };
}

export type { SplitNode };
