import { describe, expect, it, vi } from "vitest";

import { createLeafOwnerRegistry, leafLayoutCommitEvent, publishLeafLayoutCommit } from "./leafOwners";

describe("stable workspace leaf ownership", () => {
  it("moves an existing leaf owner and creates only the requested new owner", () => {
    const create = vi.fn((id: string) => ({ id, instance: Symbol(id) }));
    const owners = createLeafOwnerRegistry(create);

    const initial = owners.reconcile(["leaf-1", "leaf-2"]);
    const split = owners.reconcile(["leaf-1", "leaf-3", "leaf-2"]);

    expect(split.get("leaf-1")).toBe(initial.get("leaf-1"));
    expect(split.get("leaf-2")).toBe(initial.get("leaf-2"));
    expect(split.get("leaf-3")).not.toBe(initial.get("leaf-1"));
    expect(create.mock.calls).toEqual([["leaf-1"], ["leaf-2"], ["leaf-3"]]);
  });

  it("releases only owners whose leaves were closed", () => {
    const owners = createLeafOwnerRegistry((id) => ({ id }));
    owners.reconcile(["leaf-1", "leaf-2", "leaf-3"]);
    const next = owners.reconcile(["leaf-1", "leaf-3"]);

    expect([...next.keys()]).toEqual(["leaf-1", "leaf-3"]);
    expect(owners.get("leaf-2")).toBeUndefined();
  });

  it("publishes one post-layout event to every stable owner", () => {
    const first = new EventTarget();
    const second = new EventTarget();
    const observed: string[] = [];
    first.addEventListener(leafLayoutCommitEvent, () => observed.push("first"));
    second.addEventListener(leafLayoutCommitEvent, () => observed.push("second"));

    publishLeafLayoutCommit([first, second]);

    expect(observed).toEqual(["first", "second"]);
  });
});
