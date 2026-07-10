// viewLabels — viewKey("<pluginId>.<viewId>") 별 사용자 지정 탭 라벨(코어 영속).
//
// [RULE] 사이드바 뷰(좌·우)의 탭 라벨 오버라이드는 코어가 소유하는 generic 채널이다 — 특정 플러그인
// (folderpop 등) 특례가 아니라 모든 사이드바 뷰 공용이다(코어 락인 금지). 미지정이면 manifest
// title(view.decl.title) 로 폴백한다 — manifest 가 기본 단일진실, 오버라이드는 사용자 의도만 담는다.
//
// 영속: app.data core ns "viewLabels"(멀티창 일관성). boot(windowBoot)가 hydrate+subscribe.
// 동기 부트는 localStorage 캐시(coreStore) — 다른 영속 상태와 동일 패턴.

import { create } from "zustand";
import { makeCoreStore, type CoreStoreDeps } from "./coreStore";

type LabelMap = Record<string, string>;

interface ViewLabelsState {
  labels: LabelMap;
  setLabel: (viewKey: string, label: string) => void;
  clearLabel: (viewKey: string) => void;
  // 외부(coreStore hydrate/broadcast)에서 통째 교체 — 사용자 입력 경로(set/clear)와 구분.
  replaceAll: (labels: LabelMap) => void;
}

export const useViewLabels = create<ViewLabelsState>((set, get) => ({
  labels: {},
  setLabel: (viewKey, label) => {
    const trimmed = label.trim();
    const labels = { ...get().labels };
    if (trimmed) labels[viewKey] = trimmed;
    else delete labels[viewKey]; // 빈/공백 = 오버라이드 제거(manifest 폴백)
    set({ labels });
    persist?.(labels);
  },
  clearLabel: (viewKey) => {
    const labels = { ...get().labels };
    delete labels[viewKey];
    set({ labels });
    persist?.(labels);
  },
  replaceAll: (labels) => set({ labels }),
}));

// viewKey 의 표시 라벨 — 오버라이드 우선, 없으면 fallback(manifest title).
export function resolveViewLabel(viewKey: string, fallback: string): string {
  return useViewLabels.getState().labels[viewKey] ?? fallback;
}

// ── 영속 배선(boot 에서 1회) ────────────────────────────────────────────────────
// coreStore 는 async invoke 라 모듈-load 시 주입할 수 없다 — boot 가 deps 와 함께 init 한다.

let persist: ((labels: LabelMap) => void) | null = null;

export function initViewLabelsPersistence(deps: CoreStoreDeps): () => void {
  const store = makeCoreStore<LabelMap>({
    key: "viewLabels",
    lsKey: "soksak.viewLabels",
    fallback: {},
    ...deps,
  });
  // 동기 캐시로 즉시 채우고(렌더 전), 권위값으로 hydrate.
  useViewLabels.getState().replaceAll(store.loadSync());
  void store.hydrate().then((v) => useViewLabels.getState().replaceAll(v));
  // 다른 창의 변경 반영.
  const un = store.subscribe((v) => useViewLabels.getState().replaceAll(v));
  // 사용자 입력(set/clear) → 저장.
  persist = (labels) => void store.save(labels);
  return () => {
    un();
    persist = null;
  };
}
