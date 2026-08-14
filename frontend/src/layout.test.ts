import { describe, expect, it } from "vitest";

import { createWorkspace, leaves, splitLeaf, type WorkspaceNode } from "./layout";

describe("recursive terminal/browser workspace", () => {
  it("starts with one terminal", () => {
    expect(createWorkspace()).toEqual({ kind: "leaf", id: "leaf-1", program: "terminal" });
  });

  it("replaces the addressed leaf with a split", () => {
    const initial = createWorkspace();
    expect(splitLeaf(initial, "leaf-1", "row", "browser")).toEqual({
      kind: "split",
      id: "split-1",
      axis: "row",
      ratio: 0.5,
      first: initial,
      second: { kind: "leaf", id: "leaf-2", program: "browser" },
    });
  });

  it("has no artificial nesting limit", () => {
    let tree: WorkspaceNode = createWorkspace();
    let target = "leaf-1";
    for (let depth = 0; depth < 64; depth += 1) {
      tree = splitLeaf(tree, target, depth % 2 === 0 ? "row" : "column", depth % 2 === 0 ? "browser" : "terminal");
      target = `leaf-${depth + 2}`;
    }
    expect(leaves(tree)).toHaveLength(65);
  });

  it("rejects a stale target", () => {
    expect(() => splitLeaf(createWorkspace(), "missing", "row", "browser")).toThrow(
      "layout target does not exist: missing",
    );
  });
});
