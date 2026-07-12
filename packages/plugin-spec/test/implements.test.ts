// implements(C3 L2 계약-핀) 검증 매트릭스 — 계약 id 문법 <scope>-spec@<major> 를 all-or-nothing 으로 고정.
// 소스(src/spec.ts)가 단일진실 — dist 는 산출물이라 테스트는 소스를 직접 겨눈다.
import { describe, expect, it } from "vitest";
import { CONTRACT_ID_RE, parseManifest, SPEC_VERSION } from "../src/spec";

// 유효한 최소 매니페스트 — 각 테스트가 여기서 변형해 깨뜨린다(코어 spec.test.ts 관례 동형).
function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    spec: SPEC_VERSION,
    id: "demo",
    name: "데모",
    version: "1.0.0",
    description: "테스트용",
    permissions: [],
    ...overrides,
  };
}

function errorsOf(raw: unknown, dirName = "demo"): string[] {
  return parseManifest(raw, dirName).validation.errors;
}

describe("implements — 수용", () => {
  it("계약 id 배열 통과 + manifest.implements 로 정규화", () => {
    const { manifest, validation } = parseManifest(
      base({
        implements: ["soksak-fixture-tasks-spec@1", "soksak-fixture-io-spec@2"],
      }),
      "demo",
    );
    expect(validation).toEqual({ ok: true, errors: [], warnings: [] });
    expect(manifest?.implements).toEqual([
      "soksak-fixture-tasks-spec@1",
      "soksak-fixture-io-spec@2",
    ]);
  });

  it("미선언이면 manifest 에 implements 키가 없다(선택 필드 관례)", () => {
    const { manifest, validation } = parseManifest(base(), "demo");
    expect(validation.ok).toBe(true);
    expect(manifest && "implements" in manifest).toBe(false);
  });

  it("빈 배열 = 선언 없음(sidecars/libraries 관례 동형 — 출력에서 생략)", () => {
    const { manifest, validation } = parseManifest(base({ implements: [] }), "demo");
    expect(validation.ok).toBe(true);
    expect(manifest && "implements" in manifest).toBe(false);
  });
});

describe("implements — 거부(계약 id 문법)", () => {
  const grammarError = (errs: string[]) =>
    errs.some((e) => e.includes("<scope>-spec@<major>"));

  it('"-spec" 마커 없는 이름 거부 — 구현체/엔진 이름은 계약 id 가 아니다', () => {
    const errs = errorsOf(base({ implements: ["soksak-fixture-tasks@1"] }));
    expect(errs.length).toBeGreaterThan(0);
    expect(grammarError(errs)).toBe(true);
  });

  it("판(@major) 없는 이름 거부", () => {
    const errs = errorsOf(base({ implements: ["soksak-fixture-tasks-spec"] }));
    expect(grammarError(errs)).toBe(true);
  });

  it("숫자 아닌 판 거부", () => {
    const errs = errorsOf(base({ implements: ["soksak-fixture-tasks-spec@one"] }));
    expect(grammarError(errs)).toBe(true);
  });

  it("선행 0 판 거부 — @01 별칭이 통과하면 정확-문자열 발견이 구현체를 놓친다", () => {
    const errs = errorsOf(base({ implements: ["soksak-fixture-tasks-spec@01"] }));
    expect(grammarError(errs)).toBe(true);
  });

  it("판 0 은 정규형이라 통과", () => {
    const errs = errorsOf(base({ implements: ["soksak-fixture-tasks-spec@0"] }));
    expect(errs).toEqual([]);
  });

  it("대문자 거부(소문자 문법)", () => {
    const errs = errorsOf(base({ implements: ["Soksak-Fixture-Spec@1"] }));
    expect(grammarError(errs)).toBe(true);
  });

  it("문자열 아닌 항목 거부", () => {
    const errs = errorsOf(base({ implements: [1] }));
    expect(grammarError(errs)).toBe(true);
  });

  it("배열 아닌 값 거부", () => {
    const errs = errorsOf(base({ implements: "soksak-fixture-tasks-spec@1" }));
    expect(errs.some((e) => e.startsWith("implements:"))).toBe(true);
  });

  it("중복 선언 거부", () => {
    const errs = errorsOf(
      base({
        implements: ["soksak-fixture-tasks-spec@1", "soksak-fixture-tasks-spec@1"],
      }),
    );
    expect(errs.some((e) => e.includes("중복"))).toBe(true);
  });
});

describe("programs.viewContract — L2 계약-핀(계약 id 문법, implements 와 동일 규율)", () => {
  // programs 기여는 "programs" 권한 필수 + command-surface(programs>0 이면 commands>0).
  function withProgram(viewContract: unknown): Record<string, unknown> {
    const program: Record<string, unknown> = { id: "agent", title: "Agent", kind: "view", view: "content" };
    if (viewContract !== undefined) program.viewContract = viewContract;
    return base({
      permissions: ["programs", "commands"],
      contributes: { commands: [{ name: "run", title: "Run" }], programs: [program] },
    });
  }

  it("계약 id viewContract 통과 + manifest 로 정규화", () => {
    const { manifest, validation } = parseManifest(withProgram("terminal-spec@1"), "demo");
    expect(validation.ok).toBe(true);
    expect(manifest?.contributes.programs[0].viewContract).toBe("terminal-spec@1");
  });

  it("viewContract 미선언이면 프로그램에 키가 없다(선택 필드 관례)", () => {
    const { manifest } = parseManifest(withProgram(undefined), "demo");
    const p = manifest?.contributes.programs[0];
    expect(p && "viewContract" in p).toBe(false);
  });

  it("계약 id 아닌 viewContract 거부 — 구현체/엔진 이름은 계약 id 가 아니다", () => {
    const errs = parseManifest(withProgram("not-a-contract"), "demo").validation.errors;
    expect(errs.some((e) => e.includes("viewContract") && e.includes("계약 id 형식"))).toBe(true);
  });
});

describe("CONTRACT_ID_RE — 문법 단일진실 export", () => {
  it("계약 id 문법과 일치(anchored)", () => {
    expect(CONTRACT_ID_RE.test("soksak-fixture-tasks-spec@1")).toBe(true);
    expect(CONTRACT_ID_RE.test("x-spec@12")).toBe(true);
    expect(CONTRACT_ID_RE.test("soksak-fixture-tasks@1")).toBe(false); // 마커 없음
    expect(CONTRACT_ID_RE.test("soksak-fixture-tasks-spec")).toBe(false); // 판 없음
    expect(CONTRACT_ID_RE.test(" soksak-fixture-tasks-spec@1")).toBe(false); // 공백
    expect(CONTRACT_ID_RE.test("soksak-fixture-tasks-spec@1 ")).toBe(false);
  });
});
