// 의존 그래프 해소 — cascade·refcount·전이·버전 무결성 계약 고정.
import { describe, expect, it } from "vitest";
import {
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

// core ← cockpit, core ← lounge, lounge ← addon (lounge 가 addon 의 의존). 체인: addon→lounge→core.
function graph(): DepNode[] {
  return [
    { id: "core", version: "0.1.0", dependencies: {} },
    { id: "cockpit", version: "0.1.0", dependencies: { core: "^0.1.0" } },
    { id: "lounge", version: "0.1.0", dependencies: { core: "^0.1.0" } },
    { id: "addon", version: "0.1.0", dependencies: { lounge: "^0.1.0" } },
  ];
}

describe("dependencyGraph — 의존자/참조수", () => {
  it("직접 의존자", () => {
    expect(directDependents("core", graph()).sort()).toEqual(["cockpit", "lounge"]);
    expect(directDependents("lounge", graph())).toEqual(["addon"]);
    expect(directDependents("addon", graph())).toEqual([]);
  });
  it("참조수", () => {
    expect(refcount("core", graph())).toBe(2);
    expect(refcount("addon", graph())).toBe(0); // leaf
  });
});

describe("dependencyGraph — 전이 의존자/cascade", () => {
  it("core 삭제 시 전이 의존자 = cockpit, lounge, addon", () => {
    const t = transitiveDependents("core", graph());
    expect(new Set(t)).toEqual(new Set(["cockpit", "lounge", "addon"]));
  });
  it("cascade 삭제 순서 — 먼 의존자(addon) 가 의존 대상(lounge)보다 먼저, 대상(core) 마지막", () => {
    const order = cascadeRemovalSet("core", graph());
    expect(order[order.length - 1]).toBe("core"); // 대상은 항상 마지막
    expect(order.indexOf("addon")).toBeLessThan(order.indexOf("lounge")); // 잎 먼저
    expect(order.indexOf("lounge")).toBeLessThan(order.indexOf("core"));
  });
  it("leaf 삭제는 cascade 가 자기 자신뿐", () => {
    expect(cascadeRemovalSet("addon", graph())).toEqual(["addon"]);
  });
});

describe("dependencyGraph — 미설치 의존 해소", () => {
  it("이미 설치된 의존은 제외, 미설치만", () => {
    const installed: DepNode[] = [{ id: "core", version: "0.1.0", dependencies: {} }];
    expect(resolveMissingDeps({ core: "^0.1.0", other: "^1.0.0" }, installed)).toEqual([
      { id: "other", range: "^1.0.0" },
    ]);
  });
  it("전부 설치돼 있으면 빈 목록(멱등 — 재설치 안 함)", () => {
    expect(resolveMissingDeps({ core: "^0.1.0" }, graph())).toEqual([]);
  });
  it("allMissingDeps — 그래프 전체 미설치 의존(중복 제거)", () => {
    // lounge·cockpit 둘 다 core 의존, core 미설치 → core 1개만(중복 제거).
    const g: DepNode[] = [
      { id: "cockpit", version: "0.1.0", dependencies: { core: "^0.1.0" } },
      { id: "lounge", version: "0.1.0", dependencies: { core: "^0.1.0" } },
    ];
    expect(allMissingDeps(g)).toEqual([{ id: "core", range: "^0.1.0" }]);
    expect(allMissingDeps(graph())).toEqual([]); // 전부 설치됨
  });
});

describe("dependencyGraph — 버전 무결성", () => {
  it("만족하면 이슈 없음", () => {
    expect(versionIssues(graph())).toEqual([]);
  });
  it("미설치 의존 → missing", () => {
    const g: DepNode[] = [{ id: "lounge", version: "0.1.0", dependencies: { core: "^0.1.0" } }];
    expect(versionIssues(g)).toEqual([
      { id: "lounge", dep: "core", range: "^0.1.0", have: null, reason: "missing" },
    ]);
  });
  it("버전 불만족 → unsatisfied", () => {
    const g: DepNode[] = [
      { id: "core", version: "0.2.0", dependencies: {} },
      { id: "lounge", version: "0.1.0", dependencies: { core: "^0.1.0" } }, // ^0.1.0 은 0.2.0 미포함
    ];
    expect(versionIssues(g)).toEqual([
      { id: "lounge", dep: "core", range: "^0.1.0", have: "0.2.0", reason: "unsatisfied" },
    ]);
  });
});

describe("dependencyGraph — depSummary(plugin.deps 반환)", () => {
  it("요약 = 의존+의존자+참조수+cascade", () => {
    const s = depSummary("core", graph());
    expect(s?.refcount).toBe(2);
    expect(new Set(s?.dependents)).toEqual(new Set(["cockpit", "lounge"]));
    expect(new Set(s?.cascadeOnRemove)).toEqual(new Set(["cockpit", "lounge", "addon"]));
  });
  it("미설치 id → null", () => {
    expect(depSummary("ghost", graph())).toBeNull();
  });
});

describe("activationChain — 활성화 체인(종속 먼저, id 마지막)", () => {
  it("직접 종속: [core, cockpit]", () => {
    expect(activationChain("cockpit", graph())).toEqual(["core", "cockpit"]);
  });
  it("전이 종속: addon→lounge→core ⇒ [core, lounge, addon]", () => {
    expect(activationChain("addon", graph())).toEqual(["core", "lounge", "addon"]);
  });
  it("종속 없는 leaf(core)는 자기 하나", () => {
    expect(activationChain("core", graph())).toEqual(["core"]);
  });
  it("종속이 항상 자신보다 앞에 온다(위상 불변식)", () => {
    const chain = activationChain("addon", graph());
    const idx = (id: string) => chain.indexOf(id);
    expect(idx("core")).toBeLessThan(idx("lounge"));
    expect(idx("lounge")).toBeLessThan(idx("addon"));
  });
  it("순환 의존(a→b→a)에서도 무한루프 없이 1회 방문", () => {
    const cyc: DepNode[] = [
      { id: "a", version: "1", dependencies: { b: "*" } },
      { id: "b", version: "1", dependencies: { a: "*" } },
    ];
    const chain = activationChain("a", cyc);
    expect(new Set(chain)).toEqual(new Set(["a", "b"]));
    expect(chain.length).toBe(2);
  });
  it("미설치 종속은 건너뛴다(설치 플로가 별도 처리)", () => {
    const partial: DepNode[] = [
      { id: "studio", version: "1", dependencies: { core: "*" } },
    ];
    expect(activationChain("studio", partial)).toEqual(["studio"]);
  });
});
