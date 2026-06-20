// 뷰 레지스트리 — 플러그인 뷰 provider 의 단일 저장소.
// 뷰 구현과 배치는 직교(§0-6): 우측/좌측 사이드바·콘텐츠 영역 모두 여기 등록된
// 동일한 provider 를 PluginViewHost 로 소비한다. version 은 UI 재구성 신호.

import { create } from "zustand";
import { qualifiedViewId, type ContributedView } from "./spec";

export interface PluginViewContext {
  projectId: string;
  root: string | null;
  // 이 뷰가 추종/연관하는 터미널 pane(cwd 추종 대상). 사이드바=cwdPaneOf(활성 그룹의 포커스 터미널),
  // 그 외 배치=null. app.terminal.getCwd/onCwd 와 함께 cwd 추종에 쓴다(계약 A13/S7). 없으면 null.
  paneId: string | null;
  // 이 뷰의 사이드바 탭 배지(읽지않음 표시). number=카운트, "dot"=점, null=해제.
  // 창마다 자체 store라 per-window(그 창의 활성 프로젝트 기준). 데이터는 app.data.watch 로 재계산.
  setBadge: (badge: number | "dot" | null) => void;
}

export type ViewBadge = number | "dot" | null;

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
  // 뷰별 배지(읽지않음 표시). version 과 분리 — 배지 변경이 뷰를 remount 시키지 않도록(독립 구독).
  badges: Record<string, ViewBadge>;
  register: (
    pluginId: string,
    decl: ContributedView,
    provider: PluginViewProvider,
  ) => () => void;
  setViewBadge: (key: string, badge: ViewBadge) => void;
}

export const useViewRegistry = create<ViewRegistryState>((set, get) => ({
  views: {},
  version: 0,
  badges: {},

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
        const badges = { ...s.badges };
        delete badges[key]; // 뷰 해제 시 배지도 정리
        return { views, badges, version: s.version + 1 };
      });
    };
  },

  // 배지 설정 — version 미증가(뷰 remount 방지). 동일값이면 no-op(불필요 렌더 차단).
  setViewBadge: (key, badge) =>
    set((s) => {
      const cur = s.badges[key] ?? null;
      const next = badge === 0 ? null : badge; // 0 = 없음으로 정규화
      if (cur === next) return s;
      const badges = { ...s.badges };
      if (next == null) delete badges[key];
      else badges[key] = next;
      return { badges };
    }),
}));

// 배치별 뷰 목록(아이콘 레일/탭 스트립용) — 등록 순서 유지.
export function viewsForPlacement(
  placement: "sidebar-right" | "sidebar-left" | "sidebar-footer" | "content",
): { key: string; view: RegisteredView }[] {
  const { views } = useViewRegistry.getState();
  return Object.entries(views)
    .filter(([, v]) => v.decl.placements.includes(placement))
    .map(([key, view]) => ({ key, view }));
}

export function getRegisteredView(key: string): RegisteredView | null {
  return useViewRegistry.getState().views[key] ?? null;
}
