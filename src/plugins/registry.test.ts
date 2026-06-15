import { describe, expect, it } from "vitest";
import { parseRegistry, REGISTRY_SPEC } from "./registry";
import snapshot from "./registrySnapshot.json";

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "soksak-shark",
    name: "Shark",
    description: "헤엄치는 상어",
    repo: "https://github.com/soksak-ai/soksak-shark.git",
    ...over,
  };
}
function reg(plugins: unknown[]): Record<string, unknown> {
  return { spec: REGISTRY_SPEC, plugins };
}

describe("parseRegistry — 수용", () => {
  it("valid 레지스트리 파싱", () => {
    const r = parseRegistry(reg([entry()]));
    expect(r).not.toBeNull();
    expect(r!.plugins).toHaveLength(1);
    expect(r!.plugins[0]).toMatchObject({
      id: "soksak-shark",
      repo: "https://github.com/soksak-ai/soksak-shark.git",
    });
  });

  it("다국어 name/description + author 보존", () => {
    const r = parseRegistry(
      reg([entry({ name: { ko: "상어", en: "Shark" }, description: { ko: "ㅎ" }, author: "soksak" })]),
    );
    expect(r!.plugins[0]).toMatchObject({ author: "soksak" });
    expect(r!.plugins[0].name).toEqual({ ko: "상어", en: "Shark" });
  });
});

describe("parseRegistry — 거부/방어(신뢰 경계)", () => {
  it("spec 불일치 → null", () => {
    expect(parseRegistry(reg([entry()]) && { spec: "x@9", plugins: [] })).toBeNull();
  });
  it("객체 아님 → null", () => {
    expect(parseRegistry(null)).toBeNull();
    expect(parseRegistry("str")).toBeNull();
    expect(parseRegistry({ spec: REGISTRY_SPEC })).toBeNull(); // plugins 배열 없음
  });
  it("손상 엔트리는 스킵(전체는 살림)", () => {
    const r = parseRegistry(
      reg([
        entry(),
        { id: "x" }, // repo 없음 → 스킵
        entry({ id: "soksak-memo", repo: "https://github.com/soksak-ai/soksak-memo.git" }),
        { repo: "https://x" }, // id 없음 → 스킵
      ]),
    );
    expect(r!.plugins.map((p) => p.id)).toEqual(["soksak-shark", "soksak-memo"]);
  });
});

// 빌드 스냅샷(make registry 산출물) 자체가 valid + 기대 플러그인을 담는지 — stale/손상 가드.
describe("registrySnapshot.json — 빌드 스냅샷 무결성", () => {
  it("parseRegistry 통과 + 모든 엔트리에 git repo", () => {
    const r = parseRegistry(snapshot);
    expect(r).not.toBeNull();
    expect(r!.plugins.length).toBeGreaterThanOrEqual(16);
    for (const p of r!.plugins) {
      expect(p.repo).toMatch(/^https?:\/\/|^git@/);
    }
  });
  it("template 플러그인(skeleton)은 제외", () => {
    const r = parseRegistry(snapshot)!;
    expect(r.plugins.find((p) => p.id === "soksak-plugin-skeleton")).toBeUndefined();
  });
  it("대표 플러그인(shark/claude-gui) 포함", () => {
    const ids = parseRegistry(snapshot)!.plugins.map((p) => p.id);
    expect(ids).toContain("soksak-shark");
    expect(ids).toContain("soksak-claude-gui");
  });
});
