// 계약 → 구현체 해소 배선(L2 계약-핀 C3). contractDiscovery(순수 발견) + contractSelection
// (사용자 선택) + 활성 플러그인 상태를 합쳐 "계약 id → 열 구현체 pluginId" 하나를 정한다.
//
// [RULE] 코어는 어떤 계약의 의미도 모른다(C1) — 여기는 계약 id 를 문자열로만 다루고 특정
// 계약(terminal-spec 등)·특정 구현체를 하드코딩하지 않는다. 발견은 구현체 무차별
// (implementersOf), 선택은 제네릭 맵(contractSelection)이다.
//
// 발견은 상태 무차별이지만(implementersOf 는 전부 반환) 뷰를 여는 소비자는 활성(enabled)
// 구현체만 대상으로 한다 — 비활성 플러그인의 뷰는 마운트되지 않는다(소비자가 status 로 거른다,
// pluginImplementers.test 의 계약). sessions(newViewFor)·설정 UI 가 이 배선을 소비한다.

import { usePlugins } from "../state/plugins";
import { useContractSelection } from "../state/contractSelection";
import {
  implementersOf,
  manifestImplements,
  type ImplementsNode,
} from "./contractDiscovery";
import type { ContractRequirement } from "./spec";

// 활성(enabled) 플러그인의 계약 발견 노드(매니페스트 implements). 비활성/에러는 제외 —
// 뷰를 열 수 있는 구현체만 후보다.
function activeImplementsNodes(): ImplementsNode[] {
  return Object.values(usePlugins.getState().plugins)
    .filter((p) => p.status === "enabled")
    .map((p) => ({ id: p.manifest.id, implements: manifestImplements(p.manifest) }));
}

// 계약 id → 활성 구현체 pluginId 목록(노드 순서 보존, 정확 일치).
export function contractImplementers(contract: ContractRequirement): string[] {
  return implementersOf(contract, activeImplementsNodes());
}

// 계약 id → 열 구현체 pluginId 하나. 사용자 선택이 유효(활성 목록의 원소)하면 그것, 아니면
// 첫 항목(선택 없음·stale 선택·구현체 1개). 구현체 0 이면 null — 소비자는 빈 그룹으로 열화한다.
export function resolveContractImplementer(contract: ContractRequirement): string | null {
  const impls = contractImplementers(contract);
  if (impls.length === 0) return null;
  const chosen = useContractSelection.getState().selected[contract.id];
  return chosen && impls.includes(chosen) ? chosen : impls[0];
}

// 선택 UI 노출 대상 — 활성 구현체가 둘 이상인 계약만(하나뿐이면 고를 게 없다). 계약 id 오름차순.
export function selectableContracts(): { contract: string; implementers: string[] }[] {
  const map = new Map<string, string[]>();
  for (const node of activeImplementsNodes()) {
    for (const provider of node.implements) {
      const implementers = map.get(provider.id) ?? [];
      if (!implementers.includes(node.id)) implementers.push(node.id);
      map.set(provider.id, implementers);
    }
  }
  return [...map.entries()]
    .sort(([left], [right]) => left === right ? 0 : left < right ? -1 : 1)
    .map(([contract, implementers]) => ({ contract, implementers }))
    .filter(({ implementers }) => implementers.length >= 2);
}
