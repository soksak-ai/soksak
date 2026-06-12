// 뷰 레지스트리 — 플러그인 뷰 provider 의 단일 저장소.
// 뷰 구현과 배치는 직교(§0-6): 우측/좌측 사이드바·콘텐츠 영역 모두 여기 등록된
// 동일한 provider 를 PluginViewHost 로 소비한다. version 은 UI 재구성 신호.

import { create } from "zustand";
import { qualifiedViewId, type ContributedView } from "./spec";

export interface PluginViewContext {
  projectId: string;
  root: string | null;
}

// 플러그인이 구현하는 뷰. React 비요구 — 컨테이너 DOM 에 직접 그린다.
export interface PluginViewProvider {
  mount(container: HTMLElement, ctx: PluginViewContext): void;
  unmount?(container: HTMLElement): void;
}

export interface RegisteredView {
  pluginId: string;
  decl: ContributedView; // 매니페스트 선언(제목/아이콘/배치) — 표시 정보의 단일진실
  provider: PluginViewProvider;
}

interface ViewRegistryState {
  views: Record<string, RegisteredView>; // key = "<pluginId>.<viewId>"
  version: number; // 등록/해제마다 증가 — 소비자(UI) 재구성 신호
  register: (
    pluginId: string,
    decl: ContributedView,
    provider: PluginViewProvider,
  ) => () => void;
}

export const useViewRegistry = create<ViewRegistryState>((set, get) => ({
  views: {},
  version: 0,

  register: (pluginId, decl, provider) => {
    const key = qualifiedViewId(pluginId, decl.id);
    if (get().views[key]) {
      // §0-3 침묵 실패 금지 — 중복 등록은 버그(해제 없이 재활성화).
      throw new Error(`이미 등록된 뷰: ${key}`);
    }
    set((s) => ({
      views: { ...s.views, [key]: { pluginId, decl, provider } },
      version: s.version + 1,
    }));
    return () => {
      set((s) => {
        if (!s.views[key]) return s; // 이미 해제됨 — 멱등
        const views = { ...s.views };
        delete views[key];
        return { views, version: s.version + 1 };
      });
    };
  },
}));

// 배치별 뷰 목록(아이콘 레일/탭 스트립용) — 등록 순서 유지.
export function viewsForPlacement(
  placement: "sidebar-right" | "sidebar-left" | "content",
): { key: string; view: RegisteredView }[] {
  const { views } = useViewRegistry.getState();
  return Object.entries(views)
    .filter(([, v]) => v.decl.placements.includes(placement))
    .map(([key, view]) => ({ key, view }));
}

export function getRegisteredView(key: string): RegisteredView | null {
  return useViewRegistry.getState().views[key] ?? null;
}
