// L2 계약-핀(C3)의 발견 축 — "계약 id → 구현 플러그인 id 목록" 해소(순수 함수, I/O 0).
// 계약 id 문법은 NAMING §8(soksak-spec-<kind>-<domain>@<major>)이 단일진실이고, 계약 id 의
// 등장면 다섯 곳(사이드카·서비스 wire·implements·consumes·viewContract)은 §8 재입법으로
// 입법됐다 — 이 파일은 그 문법의 기계화다.
//
// 발견은 구현체 무차별(implementation-blind): 소비자는 계약 id 로만 찾고 플러그인 id 를
// 하드코딩하지 않는다(L1 이름-핀은 신규 결합에 금지 — C3 사다리). 코어는 어떤 계약도 모른다(C1) —
// 여기는 조회 기제만 있고 계약 목록·요구 표면 정의는 계약 소유자(플러그인) 몫이다.
// dependencyGraph.ts 와 같은 결: 순수 함수, 노드는 호출부(카탈로그)가 활성 플러그인 상태에서 만든다.

// 계약 id 문법(NAMING §8)의 단일진실은 스펙 패키지(contracts.ts — CONTRACT_ID_RE·validateImplements).
// 여기서 재정의하지 않는다 — 스키마 게이트(parseManifest)와 코어 발견·conformance 가 같은 문법을 본다.
import { CONTRACT_ID_RE, type PluginManifest } from "./spec";

export interface ContractId {
  scope: string; // "soksak-spec-" 접두 뒤의 kind+domain 스코프(예: "plugin-git", "sidecar-browser")
  major: number; // 판 — 판올림은 별도 계약(@2 는 @1 을 약속하지 않는다, NAMING §8)
}

const SPEC_PREFIX = "soksak-spec-";

// 계약 id → { scope, major }. 문법 위반이면 null — 여기서 고쳐 주지 않는다(파생이지 발명이 아니다).
export function parseContractId(raw: string): ContractId | null {
  if (!CONTRACT_ID_RE.test(raw)) return null;
  const at = raw.lastIndexOf("@");
  return {
    scope: raw.slice(SPEC_PREFIX.length, at),
    major: Number(raw.slice(at + 1)),
  };
}

export interface ImplementsNode {
  id: string; // 플러그인 id
  implements: string[]; // 선언된 계약 id 목록(매니페스트 implements)
}

// 계약 id(판 포함, 정확 일치) → 구현 플러그인 id 목록(노드 순서 보존).
export function implementersOf(contract: string, nodes: ImplementsNode[]): string[] {
  return nodes.filter((n) => n.implements.includes(contract)).map((n) => n.id);
}

// 역방향 — 한 플러그인이 선언한 계약 목록(선언 순서 보존, 중복 1회). 미지의 플러그인은 빈 배열.
export function contractsOf(pluginId: string, nodes: ImplementsNode[]): string[] {
  const node = nodes.find((n) => n.id === pluginId);
  return node ? [...new Set(node.implements)] : [];
}

// 전체 계약 지도 — 선언된 모든 계약과 각 구현체(계약 id 오름차순, 구현체는 노드 순서).
// 한 플러그인의 중복 선언은 한 번만 실린다 — 중복 자체의 보고는 conformance(implementsViolations) 몫.
export function allContracts(
  nodes: ImplementsNode[],
): { contract: string; implementers: string[] }[] {
  const map = new Map<string, string[]>();
  for (const n of nodes) {
    for (const c of new Set(n.implements)) {
      const list = map.get(c) ?? [];
      list.push(n.id);
      map.set(c, list);
    }
  }
  return [...map.keys()].sort().map((contract) => ({
    contract,
    implementers: map.get(contract) ?? [],
  }));
}

// 매니페스트의 implements 원값 — 형태 판정(implementsViolations)과 읽기가 같은 접근자를 쓴다(단일진실).
// unknown 반환 유지: 활성화 경계의 conformance 는 parseManifest 를 안 거친 입력(테스트 주입 등)도
// 형태부터 본다 — 스키마 게이트가 있다고 런타임 경계 판정을 생략하지 않는다(두 시행면, PLUGIN-CONTRACT §3).
export function rawImplements(manifest: PluginManifest): unknown {
  return manifest.implements;
}

// 매니페스트 → implements 선언(문자열 항목만). 형태 위반의 보고는 conformance 몫 — 여기는 조회용.
export function manifestImplements(manifest: PluginManifest): string[] {
  const raw = rawImplements(manifest);
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}
