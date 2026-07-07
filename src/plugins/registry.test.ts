import { describe, expect, it } from "vitest";
import {
  installState,
  isOfficial,
  mergeRegistry,
  parseRegistry,
  REGISTRY_SPEC,
  type Registry,
  type RegistryEntry,
} from "./registry";
import snapshot from "./registrySnapshot.json";

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "soksak-plugin-shark",
    name: "Shark",
    version: "1.0.2",
    description: "헤엄치는 상어",
    repo: "https://github.com/soksak-ai/soksak-plugin-shark.git",
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
      id: "soksak-plugin-shark",
      repo: "https://github.com/soksak-ai/soksak-plugin-shark.git",
    });
  });

  it("다국어 name/description + author 보존", () => {
    const r = parseRegistry(
      reg([entry({ name: { ko: "상어", en: "Shark" }, description: { ko: "ㅎ" }, author: "soksak" })]),
    );
    expect(r!.plugins[0]).toMatchObject({ author: "soksak" });
    expect(r!.plugins[0].name).toEqual({ ko: "상어", en: "Shark" });
  });

  it("commands(선언 명령 이름) 보존 — 설치 전 능력 조회의 근거", () => {
    const r = parseRegistry(reg([entry({ commands: ["navigate", "open"] })]));
    expect(r!.plugins[0].commands).toEqual(["navigate", "open"]);
  });

  it("commands 없음/오염(비문자열 포함)은 필드 생략 — 항목 자체는 살림", () => {
    expect(parseRegistry(reg([entry()]))!.plugins[0].commands).toBeUndefined();
    const dirty = parseRegistry(reg([entry({ commands: ["ok", 3] })]));
    expect(dirty!.plugins[0].commands).toBeUndefined();
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
        entry({ id: "soksak-plugin-memo", repo: "https://github.com/soksak-ai/soksak-plugin-memo.git" }),
        { repo: "https://x" }, // id 없음 → 스킵
      ]),
    );
    expect(r!.plugins.map((p) => p.id)).toEqual(["soksak-plugin-shark", "soksak-plugin-memo"]);
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
  it("대표 플러그인(overlay-shark/agent-claude-gui) 포함", () => {
    const ids = parseRegistry(snapshot)!.plugins.map((p) => p.id);
    expect(ids).toContain("soksak-plugin-overlay-shark");
    expect(ids).toContain("soksak-plugin-agent-claude-gui");
  });
  it("모든 엔트리에 version", () => {
    for (const p of parseRegistry(snapshot)!.plugins) {
      expect(p.version).toMatch(/^\d+\.\d+\.\d+/);
    }
  });
});

describe("installState — 설치 상태 판정", () => {
  const e = (over: Partial<RegistryEntry> = {}): RegistryEntry => ({
    id: "soksak-plugin-shark",
    name: "Shark",
    version: "1.0.2",
    description: "x",
    repo: "https://github.com/soksak-ai/soksak-plugin-shark.git",
    ...over,
  });
  it("미설치 → available", () => {
    expect(installState(e())).toBe("available");
  });
  it("설치됨 + 같은 버전 → installed", () => {
    expect(installState(e({ version: "1.0.2" }), "1.0.2")).toBe("installed");
  });
  it("설치됨 + 레지스트리가 더 높음 → update", () => {
    expect(installState(e({ version: "1.1.0" }), "1.0.2")).toBe("update");
  });
  it("설치본이 더 높음(로컬 개발) → installed(다운그레이드 권유 안 함)", () => {
    expect(installState(e({ version: "1.0.0" }), "1.0.2")).toBe("installed");
  });

  // dev 소스: 로컬 워크스페이스가 단일진실 — 카탈로그 버전과 무관하게 install/update 권유 금지.
  // state.update() 가 dev 를 거부하므로(plugins.ts) UI 도 그 계약을 그대로 반영해야 한다.
  it("dev 소스 + 카탈로그가 더 높음 → installed(레지스트리에 dead 업데이트 버튼 금지)", () => {
    expect(installState(e({ version: "1.2.0" }), "1.1.0", "dev")).toBe("installed");
  });
  it("dev 소스 + 같은 버전 → installed", () => {
    expect(installState(e({ version: "1.1.0" }), "1.1.0", "dev")).toBe("installed");
  });
  it("dev 소스 + 로컬이 더 높음 → installed", () => {
    expect(installState(e({ version: "1.0.0" }), "1.2.0", "dev")).toBe("installed");
  });
  it("installed 소스 명시 + 카탈로그 높음 → update(기존 동작 유지)", () => {
    expect(installState(e({ version: "1.1.0" }), "1.0.2", "installed")).toBe("update");
  });
});

describe("mergeRegistry — 원격 채택/폴백", () => {
  const snap: Registry = { spec: REGISTRY_SPEC, plugins: [entry() as unknown as RegistryEntry] };
  it("원격 valid → 원격 채택", () => {
    const remote = { spec: REGISTRY_SPEC, plugins: [entry({ id: "soksak-plugin-memo" })] };
    expect(mergeRegistry(snap, remote).plugins.map((p) => p.id)).toEqual(["soksak-plugin-memo"]);
  });
  it("원격 손상(null parse) → 스냅샷 유지", () => {
    expect(mergeRegistry(snap, { bad: true }).plugins.map((p) => p.id)).toEqual(["soksak-plugin-shark"]);
    expect(mergeRegistry(snap, null)).toBe(snap);
  });
});

describe("isOfficial — 레지스트리 등재 여부(출처 구분)", () => {
  const entries: RegistryEntry[] = [
    entry() as unknown as RegistryEntry,
    entry({ id: "soksak-plugin-memo" }) as unknown as RegistryEntry,
  ];
  it("등재 id → true(공식)", () => {
    expect(isOfficial(entries, "soksak-plugin-shark")).toBe(true);
    expect(isOfficial(entries, "soksak-plugin-memo")).toBe(true);
  });
  it("미등재 id(옛 id·서드파티) → false(수동)", () => {
    expect(isOfficial(entries, "soksak-shark")).toBe(false); // 옛 id 잔재
    expect(isOfficial(entries, "third-party-plugin")).toBe(false);
  });
  it("빈 레지스트리 → 항상 false", () => {
    expect(isOfficial([], "soksak-plugin-shark")).toBe(false);
  });
});
