// L2 계약-핀(C3)의 발견 축 — "계약 id → 구현 플러그인 id 목록" 해소(순수 함수, I/O 0).
// 계약 id 문법은 NAMING §8(<scope>-spec@<major>)이 단일진실이고, 계약 id 의 등장면 2곳
// (사이드카 핸드셰이크·매니페스트 implements)은 §8 재입법으로 입법됐다 — 이 파일은 그 문법의 기계화다.
//
// 발견은 구현체 무차별(implementation-blind): 소비자는 계약 id 로만 찾고 플러그인 id 를
// 하드코딩하지 않는다(L1 이름-핀은 신규 결합에 금지 — C3 사다리). 코어는 어떤 계약도 모른다(C1) —
// 여기는 조회 기제만 있고 계약 목록·요구 표면 정의는 계약 소유자(플러그인) 몫이다.
// dependencyGraph.ts 와 같은 결: 순수 함수, 노드는 호출부(카탈로그)가 활성 플러그인 상태에서 만든다.

import type { PluginManifest } from "./spec";

// 계약 id 문법(NAMING §8): <scope>-spec@<major>. scope 는 도메인이지 구현·모델이 아니다.
export const CONTRACT_ID_RE = /^[a-z0-9][a-z0-9-]*-spec@[0-9]+$/;

export interface ContractId {
  scope: string; // kind 마커(-spec) 앞의 도메인 스코프
  major: number; // 판 — 판올림은 별도 계약(@2 는 @1 을 약속하지 않는다, NAMING §8)
}

// 계약 id → { scope, major }. 문법 위반이면 null — 여기서 고쳐 주지 않는다(파생이지 발명이 아니다).
export function parseContractId(raw: string): ContractId | null {
  if (!CONTRACT_ID_RE.test(raw)) return null;
  const at = raw.lastIndexOf("@");
  return {
    scope: raw.slice(0, raw.lastIndexOf("-spec@")),
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
// [로컬 시임] plugin-spec 스키마에 implements 필드가 실리기 전까지 타입 밖 필드를 방어적으로 본다.
// 스키마 랜딩 후에도 동작 동일(필드 직독) — 랜딩 시 이 캐스트만 걷어낸다.
export function rawImplements(manifest: PluginManifest): unknown {
  return (manifest as { implements?: unknown }).implements;
}

// 매니페스트 → implements 선언(문자열 항목만). 형태 위반의 보고는 conformance 몫 — 여기는 조회용.
export function manifestImplements(manifest: PluginManifest): string[] {
  const raw = rawImplements(manifest);
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}
