import { create } from "zustand";
import { createCoreSync } from "./coreSync";
import type { CoreStoreDeps } from "./coreStore";

// 계약-해소 설정 — "계약 id → 선택된 구현체 pluginId" 제네릭 맵(계약-무지). localStorage +
// app.data 권위로 영속.
//
// [RULE] 코어는 어떤 계약의 의미도 모른다(C1). 이 스토어는 계약 id 를 키로 한 순수 선택
// 저장소일 뿐이다 — terminal-spec 같은 특정 계약도, 특정 구현체도 알지 않는다. 구현체 발견은
// contractDiscovery(implementersOf)가, 선택과 발견의 배선·폴백은 contractResolve 가 소유한다.
// 여기는 저장만 한다.
//
// 선택은 발견된 구현체 목록의 한 원소여야 유효하다 — 목록에 없는 stale 선택은 소비자
// (contractResolve)가 첫 항목으로 폴백해 무시한다. 이 스토어는 유효성을 강제하지 않는다.

export type ContractSelectionMap = Record<string, string>;

interface ContractSelectionState {
  selected: ContractSelectionMap; // 계약 id → 구현체 pluginId
  // 계약의 구현체를 고른다(같은 계약 재선택은 덮어쓴다).
  select: (contract: string, pluginId: string) => void;
  // 선택 제거 — 소비자가 첫 항목으로 폴백한다(기본으로 되돌림).
  clear: (contract: string) => void;
}

const DEFAULTS: { selected: ContractSelectionMap } = { selected: {} };
const KEY = "soksak.contractSelection";

type PersistedContractSelection = typeof DEFAULTS;

function serialize(s: ContractSelectionState): PersistedContractSelection {
  return { selected: s.selected };
}

const contractSelectionSync = createCoreSync<PersistedContractSelection>({
  key: "contractSelection",
  lsKey: KEY,
  fallback: DEFAULTS,
  apply: (v) => useContractSelection.setState({ selected: v.selected ?? {} }),
});
export const initContractSelectionPersistence = (deps: CoreStoreDeps): (() => void) =>
  contractSelectionSync.init(deps);

function load(): PersistedContractSelection {
  return { ...DEFAULTS, ...contractSelectionSync.loadSync() };
}

export const useContractSelection = create<ContractSelectionState>((set, get) => {
  const save = () => {
    contractSelectionSync.save(serialize(get()));
  };
  return {
    ...load(),
    select: (contract, pluginId) => {
      set({ selected: { ...get().selected, [contract]: pluginId } });
      save();
    },
    clear: (contract) => {
      const next = { ...get().selected };
      delete next[contract];
      set({ selected: next });
      save();
    },
  };
});
