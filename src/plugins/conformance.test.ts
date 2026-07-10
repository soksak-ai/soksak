import { describe, expect, it } from "vitest";
import {
  C2_ENFORCEMENT,
  C3_ENFORCEMENT,
  gateContribution,
  implementsViolations,
  missingRegistrations,
  nodeConformance,
  partitionEnforcement,
  partitionTransparency,
  transparencyViolations,
  unreportedStatusViews,
} from "./conformance";

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

// nodeConformance — nodes 의 declared≡actual. actual = DOM 의 data-node(scanNodes 결과).
// register API 가 없는 contribution(nodes)이라 게이트가 아닌 *진단*(missing/orphan)으로 양방향을 본다.
describe("nodeConformance — 선언(contributes.nodes) ≡ 배선(data-node)", () => {
  it("선언 전부 배선되면 missing/orphan 없음", () => {
    expect(nodeConformance(["send", "input"], ["send", "input"])).toEqual({
      missing: [],
      orphan: [],
    });
  });

  it("동적 노드(id/key)는 base id 로 매칭(리스트 항목)", () => {
    expect(nodeConformance(["row"], ["row/0", "row/1"])).toEqual({
      missing: [],
      orphan: [],
    });
  });

  it("선언했는데 DOM 미배선 → missing(declared→actual)", () => {
    expect(nodeConformance(["send", "ghost"], ["send"])).toEqual({
      missing: ["ghost"],
      orphan: [],
    });
  });

  it("DOM 배선했는데 미선언 → orphan(actual→declared)", () => {
    expect(nodeConformance(["send"], ["send", "extra"])).toEqual({
      missing: [],
      orphan: ["extra"],
    });
  });
});

// transparencyViolations — 결합 법칙 C2(투명성 3종) 중 매니페스트 정적 규칙 2종의 순수 판정.
//   ① command-surface: 기능 보유(views>0 ∨ programs>0) ∧ commands=0 → 위반
//   ③ view-nodes: views>0 ∧ nodes=0 → 위반(ui.tree 부재 = 클릭 E2E 불가)
describe("transparencyViolations — 투명성 규칙(매니페스트 정적)", () => {
  it("views>0 ∧ commands=0 → command-surface 위반", () => {
    const v = transparencyViolations({ views: 1, programs: 0, commands: 0, nodes: 1 });
    expect(v.map((x) => x.rule)).toEqual(["command-surface"]);
  });

  it("programs>0 ∧ commands=0 → command-surface 위반(뷰 없는 프로그램 플러그인도 기능 보유)", () => {
    const v = transparencyViolations({ views: 0, programs: 1, commands: 0, nodes: 0 });
    expect(v.map((x) => x.rule)).toEqual(["command-surface"]);
  });

  it("views>0 ∧ nodes=0 → view-nodes 위반", () => {
    const v = transparencyViolations({ views: 1, programs: 0, commands: 2, nodes: 0 });
    expect(v.map((x) => x.rule)).toEqual(["view-nodes"]);
  });

  it("두 규칙 동시 위반이면 둘 다 보고(은폐 0)", () => {
    const v = transparencyViolations({ views: 1, programs: 0, commands: 0, nodes: 0 });
    expect(v.map((x) => x.rule)).toEqual(["command-surface", "view-nodes"]);
  });

  it("기능 없음(views=0 ∧ programs=0) → commands=0 이어도 위반 아님(아이콘셋·테마류)", () => {
    expect(
      transparencyViolations({ views: 0, programs: 0, commands: 0, nodes: 0 }),
    ).toEqual([]);
  });

  it("세 표면을 갖추면 위반 없음", () => {
    expect(
      transparencyViolations({ views: 1, programs: 1, commands: 3, nodes: 2 }),
    ).toEqual([]);
  });
});

// unreportedStatusViews — C2 ② view-status 의 순수 판정. 캐퍼빌리티는 코어 실존
// (viewRegistry PluginViewContext.setStatus). 활성화 시점엔 뷰 미마운트라 로더 판정 불가 —
// 시행 지점은 런타임 진단(plugin.conformance)·발행 게이트(doctor).
describe("unreportedStatusViews — status 축 미보고 뷰 감지", () => {
  it("마운트된 뷰 전부 status 를 보고하면 빈 배열", () => {
    expect(unreportedStatusViews(["diff", "log"], ["diff", "log"])).toEqual([]);
  });

  it("미보고 뷰만 반환(마운트 순서 보존)", () => {
    expect(unreportedStatusViews(["diff", "log", "tree"], ["log"])).toEqual([
      "diff",
      "tree",
    ]);
  });

  it("보고만 있고 마운트 목록에 없는 id 는 다루지 않음(회수 지연 잔재)", () => {
    expect(unreportedStatusViews(["diff"], ["diff", "stale"])).toEqual([]);
  });
});

// partitionTransparency — 위반을 시행 모드(blocking/warn)로 분류. 모드 단일진실=C2_ENFORCEMENT.
// blocking 승격은 위반 0 실측+재입법 커밋으로만(C5) — 이 표를 고치면 아래 핀 테스트가 함께 고쳐져야 한다.
describe("partitionTransparency — 시행 모드 분류", () => {
  it("warn 규칙 위반 → warn 으로 분류", () => {
    const v = [{ rule: "command-surface" as const, detail: "d" }];
    expect(
      partitionTransparency(v, {
        "command-surface": "warn",
        "view-status": "warn",
        "view-nodes": "warn",
      }),
    ).toEqual({ blocking: [], warn: v });
  });

  it("blocking 규칙 위반 → blocking 으로 분류(주입 표)", () => {
    const v = [
      { rule: "command-surface" as const, detail: "a" },
      { rule: "view-nodes" as const, detail: "b" },
    ];
    expect(
      partitionTransparency(v, {
        "command-surface": "blocking",
        "view-status": "warn",
        "view-nodes": "warn",
      }),
    ).toEqual({ blocking: [v[0]], warn: [v[1]] });
  });

  it("현행 입법표 핀 — 3종 전부 warn(2026-07-11 설치본 실측 위반 잔존: 4·14·6)", () => {
    expect(C2_ENFORCEMENT).toEqual({
      "command-surface": "warn",
      "view-status": "warn",
      "view-nodes": "warn",
    });
  });
});

// implementsViolations — 결합 법칙 C3(L2 계약-핀) implements 선언의 generic 검사.
// 계약이 요구하는 표면의 정의·검증은 계약 소유자(플러그인) 몫 — 코어는 선언 자체의 성립만 본다:
//   ① implements-shape: 문자열 배열이 아니다 ② implements-grammar: 계약 id 문법(NAMING §8) 위반
//   ③ implements-duplicate: 같은 계약 중복 선언.
describe("implementsViolations — C3 implements 선언 generic 검사", () => {
  it("선언 없음(undefined) → 위반 없음(L2 계약-핀은 옵트인)", () => {
    expect(implementsViolations(undefined)).toEqual([]);
  });

  it("정상 선언 → 위반 없음", () => {
    expect(
      implementsViolations(["fixture-notes-spec@1", "fixture-board-spec@2"]),
    ).toEqual([]);
  });

  it("배열이 아님 → implements-shape(그 외 검사는 항목이 없어 침묵)", () => {
    expect(implementsViolations("fixture-notes-spec@1").map((v) => v.rule)).toEqual([
      "implements-shape",
    ]);
  });

  it("비문자열 항목 → implements-shape, 문자열 항목 검사는 계속된다", () => {
    const v = implementsViolations(["fixture-notes-spec@1", 7]);
    expect(v.map((x) => x.rule)).toEqual(["implements-shape"]);
  });

  it("문법 위반 항목 → implements-grammar(위반 id 전부 나열)", () => {
    const v = implementsViolations(["fixture-notes@1", "fixture-board-spec"]);
    expect(v.map((x) => x.rule)).toEqual(["implements-grammar"]);
    expect(v[0].detail).toContain("fixture-notes@1");
    expect(v[0].detail).toContain("fixture-board-spec");
  });

  it("중복 선언 → implements-duplicate", () => {
    const v = implementsViolations(["fixture-notes-spec@1", "fixture-notes-spec@1"]);
    expect(v.map((x) => x.rule)).toEqual(["implements-duplicate"]);
    expect(v[0].detail).toContain("fixture-notes-spec@1");
  });

  it("복합 위반이면 전부 보고한다(은폐 0)", () => {
    const v = implementsViolations([7, "bad@1", "fixture-notes-spec@1", "fixture-notes-spec@1"]);
    expect(v.map((x) => x.rule)).toEqual([
      "implements-shape",
      "implements-grammar",
      "implements-duplicate",
    ]);
  });
});

// C3 시행 모드 — C2 와 같은 결(warn 출발). blocking 승격은 스키마 랜딩 후 설치본 위반 0 실측 유지
// + 명시 재입법 커밋으로만 한다(C4·C5). 이 표를 고치면 아래 핀 테스트가 동행 개정을 강제한다.
describe("C3_ENFORCEMENT·partitionEnforcement — 시행 모드", () => {
  it("현행 입법표 핀 — 3종 전부 warn(신설 축, blocking 승격은 재입법으로만)", () => {
    expect(C3_ENFORCEMENT).toEqual({
      "implements-shape": "warn",
      "implements-grammar": "warn",
      "implements-duplicate": "warn",
    });
  });

  it("partitionEnforcement 가 주입 표대로 blocking/warn 을 분류한다", () => {
    const v = [
      { rule: "implements-grammar" as const, detail: "a" },
      { rule: "implements-duplicate" as const, detail: "b" },
    ];
    expect(
      partitionEnforcement(v, {
        "implements-shape": "warn",
        "implements-grammar": "blocking",
        "implements-duplicate": "warn",
      }),
    ).toEqual({ blocking: [v[0]], warn: [v[1]] });
  });
});
