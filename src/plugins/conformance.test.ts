import { describe, expect, it } from "vitest";
import { gateContribution, missingRegistrations } from "./conformance";

// gateContribution — declared≡actual 등록 게이트(통합). api.ts 4중 find+throw 를 하나로.
// 규칙: 선언된 id 는 그 선언 엔트리를 반환, 미선언 id 는 fatal throw(undeclared-actual 거부).
describe("gateContribution — undeclared-actual 거부", () => {
  const declared = [{ name: "send" }, { name: "clear" }];

  it("선언된 id → 그 선언 엔트리를 반환(호출자가 danger/title 등에 사용)", () => {
    const got = gateContribution({
      contributesKey: "commands",
      noun: "명령",
      id: "send",
      declared,
      idOf: (c) => c.name,
    });
    expect(got).toEqual({ name: "send" });
  });

  it("미선언 id → throw(매니페스트 contributes.<key> 에 선언되지 않은 <noun>: <id>)", () => {
    expect(() =>
      gateContribution({
        contributesKey: "commands",
        noun: "명령",
        id: "ghost",
        declared,
        idOf: (c) => c.name,
      }),
    ).toThrow("매니페스트 contributes.commands 에 선언되지 않은 명령: ghost");
  });

  it("idOf 로 종류별 식별자 추출(views 는 id, commands 는 name)", () => {
    const views = [{ id: "panel", title: "P" }];
    expect(
      gateContribution({
        contributesKey: "views",
        noun: "뷰",
        id: "panel",
        declared: views,
        idOf: (v) => v.id,
      }),
    ).toEqual({ id: "panel", title: "P" });
    expect(() =>
      gateContribution({
        contributesKey: "views",
        noun: "뷰",
        id: "missing",
        declared: views,
        idOf: (v) => v.id,
      }),
    ).toThrow("매니페스트 contributes.views 에 선언되지 않은 뷰: missing");
  });
});

// missingRegistrations — declared-but-not-actual 감지(신규, activate 후 inventory).
// 규칙: 선언됐는데 등록되지 않은 id 목록을 반환(약속 미이행 = 플러그인 버그 신호).
describe("missingRegistrations — declared-but-not-actual 감지", () => {
  it("선언 전부 등록되면 빈 배열", () => {
    expect(
      missingRegistrations(["send", "clear"], ["send", "clear"]),
    ).toEqual([]);
  });

  it("선언했는데 미등록인 id 만 반환(선언 순서 보존)", () => {
    expect(
      missingRegistrations(["send", "clear", "reset"], ["clear"]),
    ).toEqual(["send", "reset"]);
  });

  it("등록만 있고 선언 없는 건 여기서 다루지 않음(그건 gateContribution 의 몫)", () => {
    expect(missingRegistrations(["send"], ["send", "extra"])).toEqual([]);
  });
});
