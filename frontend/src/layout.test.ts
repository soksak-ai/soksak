import { describe, expect, it } from "vitest";

import { closeLeaf, createWorkspace, leaves, resizeSplit, splitLeaf, type WorkspaceNode } from "./layout";

describe("recursive terminal/browser workspace", () => {
  it("starts with a terminal and browser side by side", () => {
    expect(createWorkspace()).toEqual({
      kind: "split",
      id: "split-1",
      axis: "row",
      ratio: 0.5,
      first: { kind: "leaf", id: "leaf-1", program: "terminal" },
      second: { kind: "leaf", id: "leaf-2", program: "browser" },
    });
  });

  it("replaces the addressed leaf with a split", () => {
    const initial = createWorkspace();
    expect(splitLeaf(initial, "leaf-1", "row", "browser")).toEqual({
      kind: "split",
      id: "split-1",
      axis: "row",
      ratio: 0.5,
      first: {
        kind: "split",
        id: "split-2",
        axis: "row",
        ratio: 0.5,
        first: { kind: "leaf", id: "leaf-1", program: "terminal" },
        second: { kind: "leaf", id: "leaf-3", program: "browser" },
      },
      second: { kind: "leaf", id: "leaf-2", program: "browser" },
    });
  });

  it("has no artificial nesting limit", () => {
    let tree: WorkspaceNode = createWorkspace();
    let target = "leaf-2";
    for (let depth = 0; depth < 64; depth += 1) {
      tree = splitLeaf(tree, target, depth % 2 === 0 ? "row" : "column", depth % 2 === 0 ? "browser" : "terminal");
      target = `leaf-${depth + 3}`;
    }
    expect(leaves(tree)).toHaveLength(66);
  });

  it("rejects a stale target", () => {
    expect(() => splitLeaf(createWorkspace(), "missing", "row", "browser")).toThrow(
      "layout target does not exist: missing",
    );
  });

  it("resizes only the addressed split and clamps against collapsed leaves", () => {
    const workspace = splitLeaf(createWorkspace(), "leaf-2", "column", "terminal");
    const resized = resizeSplit(workspace, "split-2", 0.72);
    expect(resized).toMatchObject({
      id: "split-1",
      ratio: 0.5,
      second: { id: "split-2", ratio: 0.72 },
    });
    expect(resizeSplit(resized, "split-2", -1)).toMatchObject({ second: { ratio: 0.05 } });
    expect(resizeSplit(resized, "split-2", 2)).toMatchObject({ second: { ratio: 0.95 } });
  });

  it("closes the addressed leaf and promotes its sibling subtree", () => {
    const workspace = splitLeaf(createWorkspace(), "leaf-2", "column", "terminal");
    const closed = closeLeaf(workspace, "leaf-2");

    expect(closed).toEqual({
      kind: "split",
      id: "split-1",
      axis: "row",
      ratio: 0.5,
      first: { kind: "leaf", id: "leaf-1", program: "terminal" },
      second: { kind: "leaf", id: "leaf-3", program: "terminal" },
    });
  });

  it("rejects closing the last leaf or a stale target", () => {
    const only = { kind: "leaf", id: "leaf-1", program: "terminal" } as const;
    expect(() => closeLeaf(only, "leaf-1")).toThrow("cannot close the last workspace leaf");
    expect(() => closeLeaf(createWorkspace(), "missing")).toThrow("layout target does not exist: missing");
  });
});
