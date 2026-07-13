// contractDiscovery — L2 계약-핀(C3)의 발견 축: "계약 id → 구현 플러그인 id 목록" 해소.
// 계약 id 문법은 NAMING §8(soksak-spec-<kind>-<domain>@<major>)이 단일진실 — 이 테스트는 그 기계화를 고정한다.
// 발견은 구현체 무차별(implementation-blind): 소비자는 계약 id 로만 찾는다. 플러그인 id 하드코딩
// (L1 이름-핀)은 신규 결합에 금지다(C3 사다리).
import { describe, expect, it } from "vitest";
import {
  allContracts,
  contractsOf,
  implementersOf,
  manifestImplements,
  parseContractId,
  type ImplementsNode,
} from "./contractDiscovery";
// 문법 단일진실 = 스펙 패키지(contracts.ts) — 코어는 재정의하지 않고 같은 regex 를 소비한다.
import { CONTRACT_ID_RE, type PluginManifest } from "./spec";

// 픽스처 — 코어 테스트라 실 플러그인 id 금지(C1). 픽스처 전용 이름만 쓴다.
const nodes: ImplementsNode[] = [
  { id: "soksak-plugin-fixture-alpha", implements: ["soksak-spec-plugin-fixture-notes@1"] },
  {
    id: "soksak-plugin-fixture-beta",
    implements: ["soksak-spec-plugin-fixture-notes@1", "soksak-spec-plugin-fixture-board@2"],
  },
  { id: "soksak-plugin-fixture-gamma", implements: [] },
];

describe("CONTRACT_ID_RE·parseContractId — 계약 id 문법(NAMING §8)", () => {
  it("soksak-spec-<kind>-<domain>@<major> 를 수용하고 scope/major 로 분해한다", () => {
    expect(CONTRACT_ID_RE.test("soksak-spec-plugin-fixture-notes@1")).toBe(true);
    expect(parseContractId("soksak-spec-plugin-fixture-notes@1")).toEqual({
      scope: "plugin-fixture-notes",
      major: 1,
    });
    expect(parseContractId("soksak-spec-sidecar-browser@2")).toEqual({
      scope: "sidecar-browser",
      major: 2,
    });
  });

  it("soksak-spec- 접두 누락 → 거부(계약 id 는 파생이지 발명이 아니다)", () => {
    expect(parseContractId("fixture-notes-spec@1")).toBeNull();
    expect(parseContractId("fixture-notes@1")).toBeNull();
  });

  it("판(@<major>) 누락·비숫자 판·대문자·점 → 거부", () => {
    expect(parseContractId("soksak-spec-plugin-fixture-notes")).toBeNull();
    expect(parseContractId("soksak-spec-plugin-fixture-notes@v1")).toBeNull();
    expect(parseContractId("Soksak-Spec-Fixture-Notes@1")).toBeNull();
    expect(parseContractId("soksak-spec-fixture.notes@1")).toBeNull();
  });

  it("scope 없는 soksak-spec 단독 → 거부(scope 는 필수)", () => {
    expect(parseContractId("soksak-spec-@1")).toBeNull();
    expect(parseContractId("soksak-spec@1")).toBeNull();
  });
});

describe("implementersOf — 계약 id → 구현 플러그인 id 목록", () => {
  it("같은 계약을 선언한 플러그인을 전부 반환한다(노드 순서 보존)", () => {
    expect(implementersOf("soksak-spec-plugin-fixture-notes@1", nodes)).toEqual([
      "soksak-plugin-fixture-alpha",
      "soksak-plugin-fixture-beta",
    ]);
  });

  it("판까지 정확 일치 — @2 선언은 @1 조회에 잡히지 않는다(판올림은 별도 계약)", () => {
    expect(implementersOf("soksak-spec-plugin-fixture-board@1", nodes)).toEqual([]);
    expect(implementersOf("soksak-spec-plugin-fixture-board@2", nodes)).toEqual([
      "soksak-plugin-fixture-beta",
    ]);
  });

  it("아무도 선언하지 않은 계약 → 빈 배열", () => {
    expect(implementersOf("soksak-spec-plugin-fixture-ghost@1", nodes)).toEqual([]);
  });
});

describe("contractsOf — 역방향(플러그인 → 선언 계약)", () => {
  it("한 플러그인이 선언한 계약 목록(선언 순서 보존)", () => {
    expect(contractsOf("soksak-plugin-fixture-beta", nodes)).toEqual([
      "soksak-spec-plugin-fixture-notes@1",
      "soksak-spec-plugin-fixture-board@2",
    ]);
  });

  it("선언 없는 플러그인·미지의 플러그인 → 빈 배열", () => {
    expect(contractsOf("soksak-plugin-fixture-gamma", nodes)).toEqual([]);
    expect(contractsOf("soksak-plugin-fixture-ghost", nodes)).toEqual([]);
  });
});

describe("allContracts — 전체 계약 지도", () => {
  it("선언된 모든 계약 → 구현체 목록(계약 id 오름차순, 구현체는 노드 순서)", () => {
    expect(allContracts(nodes)).toEqual([
      {
        contract: "soksak-spec-plugin-fixture-board@2",
        implementers: ["soksak-plugin-fixture-beta"],
      },
      {
        contract: "soksak-spec-plugin-fixture-notes@1",
        implementers: [
          "soksak-plugin-fixture-alpha",
          "soksak-plugin-fixture-beta",
        ],
      },
    ]);
  });

  it("한 플러그인의 중복 선언은 지도에 한 번만 실린다(중복 자체는 conformance 몫)", () => {
    const dup: ImplementsNode[] = [
      {
        id: "soksak-plugin-fixture-alpha",
        implements: ["soksak-spec-plugin-fixture-notes@1", "soksak-spec-plugin-fixture-notes@1"],
      },
    ];
    expect(allContracts(dup)).toEqual([
      {
        contract: "soksak-spec-plugin-fixture-notes@1",
        implementers: ["soksak-plugin-fixture-alpha"],
      },
    ]);
  });
});

// S레인(plugin-spec) 스키마에 implements 필드가 실리기 전의 로컬 시임 — 랜딩 후에도 동작 동일(필드 직독).
describe("manifestImplements — 매니페스트에서 implements 선언 읽기", () => {
  const base = {
    spec: "soksak-spec-plugin@1",
    id: "soksak-plugin-fixture-alpha",
    name: "픽스처",
    version: "1.0.0",
    description: "d",
    entry: "main.js",
    permissions: [],
    contributes: {
      views: [],
      commands: [],
      iconSets: [],
      fileViewers: [],
      programs: [],
      events: [],
      nodes: [],
    },
  };

  it("선언된 문자열 배열을 그대로 반환한다", () => {
    const m = { ...base, implements: ["soksak-spec-plugin-fixture-notes@1"] } as unknown as PluginManifest;
    expect(manifestImplements(m)).toEqual(["soksak-spec-plugin-fixture-notes@1"]);
  });

  it("선언 없음 → 빈 배열(L2 는 옵트인)", () => {
    expect(manifestImplements(base as unknown as PluginManifest)).toEqual([]);
  });

  it("비문자열 항목은 걸러 읽는다(형태 위반 보고는 implementsViolations 몫)", () => {
    const m = { ...base, implements: ["soksak-spec-plugin-fixture-notes@1", 7, null] } as unknown as PluginManifest;
    expect(manifestImplements(m)).toEqual(["soksak-spec-plugin-fixture-notes@1"]);
  });
});
