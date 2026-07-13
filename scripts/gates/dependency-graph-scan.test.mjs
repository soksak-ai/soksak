// dependency-graph-scan 자가검사 — 미충족 의존(대상 부재·버전 불만족)을 실제로 잡는지(건전성),
// 충족되면 통과하는지, 파싱 실패를 무음 스킵하지 않는지, scanRegistry 가 배포 카탈로그 모집단을
// 판정하는지(주입 fetcher·무네트워크)를 단언한다. 버전 만족 판정 자체는 스펙 패키지 소유.
import { describe, it, expect } from "vitest";
import {
  parseCatalog,
  unsatisfiedDependencies,
  scanRegistry,
} from "./dependency-graph-scan.mjs";

function manifest(id, { version = "1.0.0", dependencies } = {}) {
  return JSON.stringify({
    spec: "soksak-spec-plugin@1",
    id,
    name: id,
    version,
    description: "fixture",
    permissions: ["commands"],
    contributes: { commands: [{ name: "x", title: "X" }] },
    ...(dependencies ? { dependencies } : {}),
  });
}

describe("unsatisfiedDependencies — 미충족 판정(순수)", () => {
  it("대상이 카탈로그에 없으면 missing 위반", () => {
    const v = unsatisfiedDependencies({
      available: { "soksak-plugin-a": "1.0.0" },
      requirements: [{ id: "soksak-plugin-a", deps: { "soksak-plugin-git-core": "^0.1.0" } }],
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ id: "soksak-plugin-a", dep: "soksak-plugin-git-core", reason: "missing" });
  });

  it("대상은 있으나 버전이 범위 불만족이면 version 위반", () => {
    const v = unsatisfiedDependencies({
      available: { "soksak-plugin-browser-native": "1.5.0", "soksak-plugin-a": "1.0.0" },
      requirements: [{ id: "soksak-plugin-a", deps: { "soksak-plugin-browser-native": ">=2.0.0" } }],
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ dep: "soksak-plugin-browser-native", reason: "version" });
  });

  it("대상 존재 + 버전 만족이면 위반 0", () => {
    const v = unsatisfiedDependencies({
      available: { "soksak-plugin-browser-native": "2.0.0", "soksak-plugin-a": "1.0.0" },
      requirements: [{ id: "soksak-plugin-a", deps: { "soksak-plugin-browser-native": ">=2.0.0" } }],
    });
    expect(v).toEqual([]);
  });

  it("의존 없는 플러그인은 위반 0", () => {
    const v = unsatisfiedDependencies({
      available: { "soksak-plugin-a": "1.0.0" },
      requirements: [{ id: "soksak-plugin-a", deps: {} }],
    });
    expect(v).toEqual([]);
  });
});

describe("parseCatalog — 매니페스트 파싱(실측 불가 은폐 금지)", () => {
  it("available·requirements 를 뽑고 fetch 실패는 parseErrors 로", () => {
    const { available, requirements, parseErrors } = parseCatalog([
      { name: "soksak-plugin-git-core", text: manifest("soksak-plugin-git-core", { version: "0.1.0" }) },
      { name: "soksak-plugin-git-diff", text: manifest("soksak-plugin-git-diff", { dependencies: { "soksak-plugin-git-core": "^0.1.0" } }) },
      { name: "soksak-plugin-dead", text: null }, // fetch 실패
    ]);
    expect(available["soksak-plugin-git-core"]).toBe("0.1.0");
    expect(requirements.find((r) => r.id === "soksak-plugin-git-diff").deps).toEqual({ "soksak-plugin-git-core": "^0.1.0" });
    expect(parseErrors.map((e) => e.id)).toEqual(["soksak-plugin-dead"]);
  });
});

describe("scanRegistry — 배포 카탈로그 그래프 실측(주입 fetcher, 무네트워크)", () => {
  it("사고 재현: 의존 대상 미발행이면 미충족으로 게이트 실패 조건", async () => {
    // git-diff 는 카탈로그되나 git-core 는 미발행 → 그래프 불충족(사고 그대로).
    const fetchEntries = async () => [
      { name: "soksak-plugin-git-diff", text: manifest("soksak-plugin-git-diff", { dependencies: { "soksak-plugin-git-core": "^0.1.0" } }) },
    ];
    const r = await scanRegistry({ fetchEntries });
    expect(r.source).toBe("registry");
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatchObject({ dep: "soksak-plugin-git-core", reason: "missing" });
  });

  it("의존 대상이 함께 배포되면 위반 0(정상 그래프)", async () => {
    const fetchEntries = async () => [
      { name: "soksak-plugin-git-core", text: manifest("soksak-plugin-git-core", { version: "0.1.0" }) },
      { name: "soksak-plugin-git-diff", text: manifest("soksak-plugin-git-diff", { dependencies: { "soksak-plugin-git-core": "^0.1.0" } }) },
    ];
    const r = await scanRegistry({ fetchEntries });
    expect(r.violations).toEqual([]);
    expect(r.parseErrors).toEqual([]);
  });
});
