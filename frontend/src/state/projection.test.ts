// Sidebar projection core (plans/sidebar-projection-spec.md §4·R1~R7) — resolution is pure derivation, the store
// holds focusHistory and pins only (A8: the binding source of truth is the session active chain, no second truth).
import { beforeEach, describe, expect, it } from "vitest";
import {
  resolveProjection,
  useProjection,
  type BoundView,
  type ProjectionDeps,
} from "./projection";
import type { ContributedSidebar } from "../plugins/spec";

const P = "proj-1";

function deps(over: Partial<ProjectionDeps> = {}): ProjectionDeps {
  return {
    isRailView: () => false,
    ...over,
  };
}

function bound(sidebar: ContributedSidebar | null, viewId = "v1", owner = "termplug"): BoundView {
  return { viewId, groupId: "g1", contentId: "c1", ownerPluginId: owner, sidebar };
}

const NO_PINS = { left: [], right: [] };

describe("resolveProjection — slot resolution (R1·R5)", () => {
  it("null binding → empty left slots + null right (pins only)", () => {
    const p = resolveProjection(P, null, NO_PINS, deps());
    expect(p.binding.viewId).toBeNull();
    expect(p.left.slots).toEqual([]);
    expect(p.right).toBeNull();
  });

  it("no declaration → one degraded left slot (source undeclared), right null", () => {
    const p = resolveProjection(P, bound(null), NO_PINS, deps());
    expect(p.left.slots).toEqual([
      {
        source: "undeclared",
        resolvedRef: null,
        instance: "shared",
        instanceKey: null,
        status: "degraded",
      },
    ]);
    expect(p.right).toBeNull();
  });

  it("self reference live — shared/per-view instanceKey shape", () => {
    const sb: ContributedSidebar = {
      left: [
        { ref: "self.tree", instance: "shared" },
        { ref: "self.blocks", instance: "per-view" },
      ],
      right: [],
      template: "stack",
    };
    const p = resolveProjection(
      P,
      bound(sb, "v9"),
      NO_PINS,
      deps({ isRailView: (k) => k === "termplug.tree" || k === "termplug.blocks" }),
    );
    expect(p.left.slots[0]).toMatchObject({
      source: "self:termplug.tree",
      resolvedRef: "termplug.tree",
      instanceKey: `${P}|termplug.tree`,
      status: "live",
    });
    expect(p.left.slots[1]).toMatchObject({
      resolvedRef: "termplug.blocks",
      instanceKey: `${P}|termplug.blocks|v9`,
      status: "live",
    });
    expect(p.left.template).toBe("stack");
    expect(p.right).toBeNull(); // an empty right array = none
  });

  it("a self reference whose target is not registered as a rail view is degraded", () => {
    const sb: ContributedSidebar = {
      left: [{ ref: "self.tree", instance: "shared" }],
      right: [],
      template: "stack",
    };
    const p = resolveProjection(P, bound(sb), NO_PINS, deps({ isRailView: () => false }));
    expect(p.left.slots[0].status).toBe("degraded");
    expect(p.left.slots[0].instanceKey).toBeNull();
  });

  // A slot naming another plugin's view is live when that view is registered, and degraded when it
  // is not. It held a contract address until 2026-08-16 and resolved an implementation through
  // discovery; the interface id was a second name for what the plugin id already names.
  it("a named view that is not registered is degraded, and one that is is live", () => {
    const sb: ContributedSidebar = {
      left: [{ plugin: "soksak-plugin-file-tree", view: "tree", instance: "shared" }],
      right: [],
      template: "stack",
    };
    const none = resolveProjection(P, bound(sb), NO_PINS, deps({ isRailView: () => false }));
    expect(none.left.slots[0].status).toBe("degraded");
    const live = resolveProjection(
      P,
      bound(sb),
      NO_PINS,
      deps({ isRailView: (ref) => ref === "soksak-plugin-file-tree.tree" }),
    );
    expect(live.left.slots[0].status).toBe("live");
    expect(live.left.slots[0].resolvedRef).toBe("soksak-plugin-file-tree.tree");
  });

  it("a right declaration resolves, and one slot means template=single", () => {
    const sb: ContributedSidebar = {
      left: [{ ref: "self.tree", instance: "shared" }],
      right: [{ ref: "self.inspector", instance: "per-view" }],
      template: "tabs",
    };
    const p = resolveProjection(P, bound(sb, "v3"), NO_PINS, deps({ isRailView: () => true }));
    expect(p.left.template).toBe("single"); // one slot → single
    expect(p.right).not.toBeNull();
    expect(p.right?.slots[0]).toMatchObject({
      resolvedRef: "termplug.inspector",
      instanceKey: `${P}|termplug.inspector|v3`,
      status: "live",
    });
    expect(p.right?.template).toBe("single");
  });
});

describe("useProjection store — focusHistory and pins (user-owned state only)", () => {
  beforeEach(() => {
    useProjection.setState({ byWorkspace: {} });
  });

  it("noteBinding — most-recent-first dedupe", () => {
    const s = useProjection.getState();
    s.noteBinding(P, "v1");
    s.noteBinding(P, "v2");
    s.noteBinding(P, "v1");
    expect(useProjection.getState().byWorkspace[P].focusHistory).toEqual(["v1", "v2"]);
  });

  it("forgetView — a closed view is removed from the history (R6 succession material cleanup)", () => {
    const s = useProjection.getState();
    s.noteBinding(P, "v1");
    s.noteBinding(P, "v2");
    s.forgetView(P, "v2");
    expect(useProjection.getState().byWorkspace[P].focusHistory).toEqual(["v1"]);
  });

  it("pin/unpin — idempotent, left and right independent", () => {
    const s = useProjection.getState();
    s.pin(P, "left", "filetree.tree");
    s.pin(P, "left", "filetree.tree"); // idempotent
    s.pin(P, "right", "picker.selections");
    expect(useProjection.getState().byWorkspace[P].pins).toEqual({
      left: ["filetree.tree"],
      right: ["picker.selections"],
    });
    s.unpin(P, "left", "filetree.tree");
    s.unpin(P, "left", "filetree.tree"); // idempotent
    expect(useProjection.getState().byWorkspace[P].pins.left).toEqual([]);
  });

  it("dropWorkspace — state is reclaimed when the workspace closes", () => {
    const s = useProjection.getState();
    s.noteBinding(P, "v1");
    s.dropWorkspace(P);
    expect(useProjection.getState().byWorkspace[P]).toBeUndefined();
  });
});


describe("seedWorkspace — restore seeding (§4.5·R9)", () => {
  beforeEach(() => {
    useProjection.setState({ byWorkspace: {} });
  });

  it("seeds only when absent (never clobber live state), restores pins and seen", () => {
    const s = useProjection.getState();
    s.seedWorkspace(P, { pins: { left: ["a.t"], right: [] } });
    expect(useProjection.getState().byWorkspace[P].pins.left).toEqual(["a.t"]);
    // Already present → no-op
    s.seedWorkspace(P, { pins: { left: ["x.y"], right: [] } });
    expect(useProjection.getState().byWorkspace[P].pins.left).toEqual(["a.t"]);
  });

});
