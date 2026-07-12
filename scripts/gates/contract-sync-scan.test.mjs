// contract-sync-scan 자가검사 — 코어 발행 contract 와 하위 소비본(doctor)의 드리프트를 실제로
// 잡는지(건전성), 순서만 다른 배열은 드리프트가 아닌지(정규화), 일치 시 통과하는지를 단언한다.
import { describe, it, expect } from "vitest";
import { judgeContractDrift } from "./contract-sync-scan.mjs";

describe("judgeContractDrift — 계약 하위 복사본 드리프트 판정", () => {
  it("일치하면 드리프트 0", () => {
    const c = { specVersion: "1", permissions: ["ui", "commands"], idPattern: "x" };
    expect(judgeContractDrift(c, { ...c })).toEqual([]);
  });

  it("배열 순서만 다르면 드리프트 아님(집합 정규화)", () => {
    const core = { permissions: ["ui", "commands", "service"] };
    const pub = { permissions: ["service", "commands", "ui"] };
    expect(judgeContractDrift(core, pub)).toEqual([]);
  });

  it("사고 재현: 코어에 service 있고 발행본에 없음 → coreOnly 드리프트", () => {
    const core = { permissions: ["ui", "commands", "service"] };
    const pub = { permissions: ["ui", "commands", "git:read"] }; // service 누락 + 제거된 git:read 잔존
    const d = judgeContractDrift(core, pub);
    expect(d).toHaveLength(1);
    expect(d[0].field).toBe("permissions");
    expect(d[0].coreOnly).toEqual(["service"]);
    expect(d[0].publishedOnly).toEqual(["git:read"]);
  });

  it("값이 다른 비배열 필드도 드리프트로", () => {
    const d = judgeContractDrift({ specVersion: "2" }, { specVersion: "1" });
    expect(d.map((x) => x.field)).toEqual(["specVersion"]);
  });

  it("발행본에만 있는 필드(코어가 제거)도 드리프트로", () => {
    const d = judgeContractDrift({}, { staleField: [1] });
    expect(d.map((x) => x.field)).toEqual(["staleField"]);
  });
});
