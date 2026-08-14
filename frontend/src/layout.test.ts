import { describe, expect, it } from "vitest";

import { closeLeaf, createWorkspace, leaves, resizeSplit, splitLeaf, type WorkspaceNode } from "./layout";

// Program ids the layout has never heard of. If any of these tests needed a
// real plugin name, the tree would be enumerating what may run inside it.
const A = "acme.a";
const B = "acme.b";

describe("recursive workspace", () => {
  it("starts as one pane running the requested program", () => {
    expect(createWorkspace(A)).toEqual({ kind: "leaf", id: "leaf-1", programId: A });
  });

  it("replaces the addressed leaf with a split", () => {
    expect(splitLeaf(createWorkspace(A), "leaf-1", "row", B)).toEqual({
      kind: "split",
      id: "split-1",
      axis: "row",
      ratio: 0.5,
      first: { kind: "leaf", id: "leaf-1", programId: A },
      second: { kind: "leaf", id: "leaf-2", programId: B },
    });
  });

  it("refuses to split a leaf that does not exist", () => {
    expect(() => splitLeaf(createWorkspace(A), "leaf-9", "row", B)).toThrow(/leaf-9/);
  });

  it("survives sixty-four successive splits", () => {
    let tree: WorkspaceNode = createWorkspace(A);
    for (let index = 0; index < 64; index += 1) {
      const current = leaves(tree);
      const last = current[current.length - 1];
      tree = splitLeaf(tree, last.id, index % 2 === 0 ? "row" : "column", B);
    }
    expect(leaves(tree)).toHaveLength(65);
  });

  it("promotes the sibling when a leaf closes", () => {
    const split = splitLeaf(createWorkspace(A), "leaf-1", "row", B);
    expect(closeLeaf(split, "leaf-1")).toEqual({ kind: "leaf", id: "leaf-2", programId: B });
  });

  it("refuses to close the last leaf", () => {
    expect(() => closeLeaf(createWorkspace(A), "leaf-1")).toThrow(/last/);
  });

  it("bounds a split ratio to keep both sides reachable", () => {
    const split = splitLeaf(createWorkspace(A), "leaf-1", "row", B);
    expect(resizeSplit(split, "split-1", 9)).toMatchObject({ ratio: 0.95 });
    expect(resizeSplit(split, "split-1", -9)).toMatchObject({ ratio: 0.05 });
  });

  it("refuses to resize a split that does not exist", () => {
    const split = splitLeaf(createWorkspace(A), "leaf-1", "row", B);
    expect(() => resizeSplit(split, "split-9", 0.5)).toThrow(/split-9/);
  });
});
