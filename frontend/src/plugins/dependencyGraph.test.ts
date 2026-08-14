// Dependency graph resolution — pins the cascade, refcount, transitive, and version integrity contracts.
import { describe, expect, it } from "vitest";
import { activationLevels,
  activationChain,
  directDependents,
  transitiveDependents,
  refcount,
  cascadeRemovalSet,
  resolveMissingDeps,
  allMissingDeps,
  versionIssues,
  depSummary,
  type DepNode,
} from "./dependencyGraph";

// core ← cockpit, core ← lounge, lounge ← addon (lounge is a dependency of addon). Chain: addon→lounge→core.
function graph(): DepNode[] {
  return [
    { id: "core", version: "0.1.0", dependencies: {} },
    { id: "cockpit", version: "0.1.0", dependencies: { core: "^0.1.0" } },
    { id: "lounge", version: "0.1.0", dependencies: { core: "^0.1.0" } },
    { id: "addon", version: "0.1.0", dependencies: { lounge: "^0.1.0" } },
  ];
}

describe("dependencyGraph — dependents and refcount", () => {
  it("direct dependents", () => {
    expect(directDependents("core", graph()).sort()).toEqual(["cockpit", "lounge"]);
    expect(directDependents("lounge", graph())).toEqual(["addon"]);
    expect(directDependents("addon", graph())).toEqual([]);
  });
  it("refcount", () => {
    expect(refcount("core", graph())).toBe(2);
    expect(refcount("addon", graph())).toBe(0); // leaf
  });
});

describe("dependencyGraph — transitive dependents and cascade", () => {
  it("removing core has transitive dependents cockpit, lounge, addon", () => {
    const t = transitiveDependents("core", graph());
    expect(new Set(t)).toEqual(new Set(["cockpit", "lounge", "addon"]));
  });
  it("cascade removal order puts the far dependent (addon) before its dependency (lounge), the target (core) last", () => {
    const order = cascadeRemovalSet("core", graph());
    expect(order[order.length - 1]).toBe("core"); // the target is always last
    expect(order.indexOf("addon")).toBeLessThan(order.indexOf("lounge")); // leaf first
    expect(order.indexOf("lounge")).toBeLessThan(order.indexOf("core"));
  });
  it("removing a leaf cascades to itself only", () => {
    expect(cascadeRemovalSet("addon", graph())).toEqual(["addon"]);
  });
});

describe("dependencyGraph — missing dependency resolution", () => {
  it("installed dependencies are excluded, only missing ones remain", () => {
    const installed: DepNode[] = [{ id: "core", version: "0.1.0", dependencies: {} }];
    expect(resolveMissingDeps({ core: "^0.1.0", other: "^1.0.0" }, installed)).toEqual([
      { id: "other", range: "^1.0.0" },
    ]);
  });
  it("all installed gives an empty list (idempotent — no reinstall)", () => {
    expect(resolveMissingDeps({ core: "^0.1.0" }, graph())).toEqual([]);
  });
  it("allMissingDeps returns the whole graph's missing dependencies, deduped", () => {
    // lounge and cockpit both depend on core, core not installed → core once only (deduped).
    const g: DepNode[] = [
      { id: "cockpit", version: "0.1.0", dependencies: { core: "^0.1.0" } },
      { id: "lounge", version: "0.1.0", dependencies: { core: "^0.1.0" } },
    ];
    expect(allMissingDeps(g)).toEqual([{ id: "core", range: "^0.1.0" }]);
    expect(allMissingDeps(graph())).toEqual([]); // all installed
  });
});

describe("dependencyGraph — version integrity", () => {
  it("a satisfied range gives no issue", () => {
    expect(versionIssues(graph())).toEqual([]);
  });
  it("a dependency that is not installed reports missing", () => {
    const g: DepNode[] = [{ id: "lounge", version: "0.1.0", dependencies: { core: "^0.1.0" } }];
    expect(versionIssues(g)).toEqual([
      { id: "lounge", dep: "core", range: "^0.1.0", have: null, reason: "missing" },
    ]);
  });
  it("a version outside the range reports unsatisfied", () => {
    const g: DepNode[] = [
      { id: "core", version: "0.2.0", dependencies: {} },
      { id: "lounge", version: "0.1.0", dependencies: { core: "^0.1.0" } }, // ^0.1.0 excludes 0.2.0
    ];
    expect(versionIssues(g)).toEqual([
      { id: "lounge", dep: "core", range: "^0.1.0", have: "0.2.0", reason: "unsatisfied" },
    ]);
  });
});

describe("dependencyGraph — depSummary (the plugin.deps result)", () => {
  it("the summary reports dependencies, dependents, refcount, and cascade", () => {
    const s = depSummary("core", graph());
    expect(s?.refcount).toBe(2);
    expect(new Set(s?.dependents)).toEqual(new Set(["cockpit", "lounge"]));
    expect(new Set(s?.cascadeOnRemove)).toEqual(new Set(["cockpit", "lounge", "addon"]));
  });
  it("an id that is not installed gives null", () => {
    expect(depSummary("ghost", graph())).toBeNull();
  });
});

describe("activationChain — dependencies first, the id last", () => {
  it("direct dependency: [core, cockpit]", () => {
    expect(activationChain("cockpit", graph())).toEqual(["core", "cockpit"]);
  });
  it("transitive dependency: addon→lounge→core gives [core, lounge, addon]", () => {
    expect(activationChain("addon", graph())).toEqual(["core", "lounge", "addon"]);
  });
  it("a leaf with no dependency (core) is itself alone", () => {
    expect(activationChain("core", graph())).toEqual(["core"]);
  });
  it("a dependency always precedes its dependent (topological invariant)", () => {
    const chain = activationChain("addon", graph());
    const idx = (id: string) => chain.indexOf(id);
    expect(idx("core")).toBeLessThan(idx("lounge"));
    expect(idx("lounge")).toBeLessThan(idx("addon"));
  });
  it("a dependency cycle (a→b→a) visits each id once without an infinite loop", () => {
    const cyc: DepNode[] = [
      { id: "a", version: "1", dependencies: { b: "*" } },
      { id: "b", version: "1", dependencies: { a: "*" } },
    ];
    const chain = activationChain("a", cyc);
    expect(new Set(chain)).toEqual(new Set(["a", "b"]));
    expect(chain.length).toBe(2);
  });
  it("a dependency that is not installed is skipped (the install flow handles it)", () => {
    const partial: DepNode[] = [
      { id: "studio", version: "1", dependencies: { core: "*" } },
    ];
    expect(activationChain("studio", partial)).toEqual(["studio"]);
  });
});

describe("activationLevels — the safe boundary of concurrent activation", () => {
  const node = (id: string, deps: string[] = []) => ({
    id,
    version: "1.0.0",
    dependencies: Object.fromEntries(deps.map((d) => [d, "*"])),
  });

  it("independent plugins form one level — all activate at once", () => {
    const installed = [node("a"), node("b"), node("c")];
    expect(activationLevels(["a", "b", "c"], installed)).toEqual([["a", "b", "c"]]);
  });

  it("a dependency chain gives levels with the dependency first", () => {
    const installed = [node("lib"), node("mid", ["lib"]), node("app", ["mid"])];
    expect(activationLevels(["app", "mid", "lib"], installed)).toEqual([
      ["lib"],
      ["mid"],
      ["app"],
    ]);
  });

  it("a dependency outside the target set makes no level (the install flow owns it)", () => {
    const installed = [node("a", ["missing"]), node("b")];
    expect(activationLevels(["a", "b"], installed)).toEqual([["a", "b"]]);
  });

  it("a cycle groups everything left into the last level — progress does not stall", () => {
    const installed = [node("x", ["y"]), node("y", ["x"]), node("z")];
    expect(activationLevels(["x", "y", "z"], installed)).toEqual([["z"], ["x", "y"]]);
  });
});
