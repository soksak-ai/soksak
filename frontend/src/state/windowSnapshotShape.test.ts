import { describe, expect, it } from "vitest";
import { readableWindowSnapshot } from "./windowSnapshotShape";

const valid = () => ({
  activeId: "workspace",
  workspaces: [{
    id: "workspace",
    contents: [{
      id: "space",
      layout: { xs: [0, 1], ys: [0, 1], cards: [{ id: "card", c0: 0, c1: 1, r0: 0, r1: 1, data: {} }] },
    }],
    sidebarLayouts: {
      left: { xs: [0, 1], ys: [0, 1], cards: [{ id: "left", c0: 0, c1: 1, r0: 0, r1: 1, data: {} }] },
    },
  }],
});

describe("canonical window snapshot shape", () => {
  it("accepts a canonical snapshot", () => expect(readableWindowSnapshot(valid()).ok).toBe(true));
  it("rejects missing top-level fields", () => {
    expect(readableWindowSnapshot({ workspaces: [] }).ok).toBe(false);
    expect(readableWindowSnapshot({ activeId: "workspace" }).ok).toBe(false);
  });
  it("rejects invalid content and sidebar layouts", () => {
    const invalid = valid();
    invalid.workspaces[0].contents[0].layout.xs = [0];
    expect(readableWindowSnapshot(invalid).ok).toBe(false);
  });
  it("accepts an intentionally empty workspace list", () => {
    expect(readableWindowSnapshot({ activeId: "", workspaces: [] }).ok).toBe(true);
  });
});
