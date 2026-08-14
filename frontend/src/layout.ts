export type Axis = "row" | "column";

/**
 * A leaf holds a program id and nothing more.
 *
 * The id is opaque here on purpose. The moment this file enumerates the
 * programs that exist, adding one costs an edit to the layout — and the tree
 * has no business knowing what fills its panes.
 */
export type LeafNode = {
  kind: "leaf";
  id: string;
  programId: string;
};

export type SplitNode = {
  kind: "split";
  id: string;
  axis: Axis;
  ratio: number;
  first: WorkspaceNode;
  second: WorkspaceNode;
};

export type WorkspaceNode = LeafNode | SplitNode;

/** One pane running the given program. What runs there is the caller's choice. */
export function createWorkspace(programId: string): WorkspaceNode {
  return { kind: "leaf", id: "leaf-1", programId };
}

export function leaves(node: WorkspaceNode): LeafNode[] {
  if (node.kind === "leaf") return [node];
  return [...leaves(node.first), ...leaves(node.second)];
}

function maxNumericId(node: WorkspaceNode, kind: "leaf" | "split"): number {
  if (node.kind === "leaf") {
    return kind === "leaf" ? Number(node.id.slice("leaf-".length)) || 0 : 0;
  }
  const own = kind === "split" ? Number(node.id.slice("split-".length)) || 0 : 0;
  return Math.max(own, maxNumericId(node.first, kind), maxNumericId(node.second, kind));
}

export function splitLeaf(
  root: WorkspaceNode,
  targetId: string,
  axis: Axis,
  programId: string,
): WorkspaceNode {
  const targetExists = leaves(root).some((leaf) => leaf.id === targetId);
  if (!targetExists) throw new Error(`layout target does not exist: ${targetId}`);

  const nextLeafId = `leaf-${maxNumericId(root, "leaf") + 1}`;
  const nextSplitId = `split-${maxNumericId(root, "split") + 1}`;

  const replace = (node: WorkspaceNode): WorkspaceNode => {
    if (node.kind === "leaf") {
      if (node.id !== targetId) return node;
      return {
        kind: "split",
        id: nextSplitId,
        axis,
        ratio: 0.5,
        first: node,
        second: { kind: "leaf", id: nextLeafId, programId },
      };
    }
    return { ...node, first: replace(node.first), second: replace(node.second) };
  };

  return replace(root);
}

export function resizeSplit(root: WorkspaceNode, splitId: string, ratio: number): WorkspaceNode {
  const boundedRatio = Math.min(0.95, Math.max(0.05, ratio));
  let found = false;

  const update = (node: WorkspaceNode): WorkspaceNode => {
    if (node.kind === "leaf") return node;
    if (node.id === splitId) {
      found = true;
      return { ...node, ratio: boundedRatio };
    }
    return { ...node, first: update(node.first), second: update(node.second) };
  };

  const next = update(root);
  if (!found) throw new Error(`split target does not exist: ${splitId}`);
  return next;
}

export function closeLeaf(root: WorkspaceNode, targetId: string): WorkspaceNode {
  const currentLeaves = leaves(root);
  if (!currentLeaves.some((leaf) => leaf.id === targetId)) {
    throw new Error(`layout target does not exist: ${targetId}`);
  }
  if (currentLeaves.length === 1) {
    throw new Error("cannot close the last workspace leaf");
  }

  const remove = (node: WorkspaceNode): WorkspaceNode | null => {
    if (node.kind === "leaf") return node.id === targetId ? null : node;

    const first = remove(node.first);
    const second = remove(node.second);
    if (!first) return second;
    if (!second) return first;
    return { ...node, first, second };
  };

  const next = remove(root);
  if (!next) throw new Error("cannot close the last workspace leaf");
  return next;
}
