import { describe, expect, it } from "vitest";

import { asRecentWorkspaces } from "./recentWorkspaces";

describe("recent workspaces shape", () => {
  it("keeps a well-formed list", () => {
    const list = [{ root: "/a", alias: "a", lastOpenedAt: 1 }];
    expect(asRecentWorkspaces(list)).toEqual(list);
  });

  it("answers with an empty list for anything that is not one", () => {
    // Whatever a store returns arrives at a renderer that iterates it. The
    // shape is checked where the type is claimed, not where the crash lands.
    //
    // Measured 2026-08-15: the persisted value was `{}` and the first render
    // died on `recentAll.filter is not a function`, which named the consumer
    // rather than the value.
    for (const wrong of [{}, null, undefined, "list", 7, true]) {
      expect(asRecentWorkspaces(wrong)).toEqual([]);
    }
  });

  it("drops entries without a root", () => {
    // A root is the identity of a workspace. An entry without one cannot be
    // matched, opened, or removed, so carrying it only defers the failure.
    const mixed = [{ root: "/a", alias: "a", lastOpenedAt: 1 }, { alias: "b" }, null];
    expect(asRecentWorkspaces(mixed)).toEqual([{ root: "/a", alias: "a", lastOpenedAt: 1 }]);
  });
});
