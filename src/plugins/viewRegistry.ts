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
  // 콘텐츠 배치 뷰의 sessions view.id(이 뷰 인스턴스의 안정 키 — 예: app.webview.label(viewId) 로
  // 인스턴스별 webview 라벨 생성). 사이드바 배치는 null.
  viewId: string | null;
  // 이 뷰가 마운트 시 1회 자동 실행할 명령(에이전트 프로그램 — 터미널 뷰가 PTY 로 실행).
  // 프로그램 선언(ContributedProgram.command)이 source. 뷰 종류 무관 채널 — 자동 실행 여부는
  // 뷰 구현이 결정한다(터미널 뷰만 PTY 로 실행). 명령 없으면 null.
  command: string | null;
  // 복원 seam(B3) — 이 마운트가 재시작 복원이면 관찰됐던 런타임(cwd·state)을 싣는다.
  // 터미널 뷰는 restore.cwd 에서 spawn(마지막 작업 위치 복원). state 는 setRestoreState 로
  // 기록했던 플러그인 관찰 상태(예: 브라우저 URL). 새로 연 뷰는 null — 잔재 유입이 구조적으로 불가.
  restore: { cwd: string | null; state: unknown } | null;
  // 이 뷰의 사이드바 탭 배지(읽지않음 표시). number=카운트, "dot"=점, null=해제.
  // 창마다 자체 store라 per-window(그 창의 활성 프로젝트 기준). 데이터는 app.data.watch 로 재계산.
  setBadge: (badge: number | "dot" | null) => void;
  // 이 뷰의 status 보고(R1) — sessions view.status 로. null=회수. 콘텐츠 배치 뷰만 유효(close guard).
  setStatus: (status: { code: string; message?: string } | null) => void;
  // 이 뷰의 탭 제목 동적 갱신(콘텐츠 배치만 — 예: 브라우저 페이지 <title>). 빈 값 무시. 사이드바=no-op.
  setTitle: (title: string) => void;
  // 플러그인 관찰 런타임 상태 보고(B3) — 뷰 레코드에 영속, 복원 마운트의 restore.state 로 돌아온다.
  // 플러그인 kv 에 viewId 키로 영속하지 마라(viewId 재사용 충돌 — 죽은 뷰의 잔재가 새 뷰에 유입).
  // JSON 직렬화 가능 값만. 콘텐츠 배치만 유효, 사이드바=no-op.
  setRestoreState: (state: unknown) => void;
}

export type ViewBadge = number | "dot" | null;

// 플러그인이 구현하는 뷰. React 비요구 — 컨테이너 DOM 에 직접 그린다.
export interface PluginViewProvider {
  mount(container: HTMLElement, ctx: PluginViewContext): void;
  unmount?(container: HTMLElement): void;
  // 라이브 갱신 — 구조(projectId/viewKey)는 그대로인데 추종 대상(paneId=cwd 따라갈 터미널)만 바뀔 때,
  // 호스트가 remount 대신 이걸 호출해 같은 인스턴스에 새 ctx 를 전달한다. 탭 전환마다 활성 pane 이
  // 바뀌므로 paneId 로 remount 하면 매번 뷰를 통째 재생성(파일트리 canvas 재구축 ~36ms)하고 뷰 상태
  // (펼친 폴더 등)도 유실된다. update 를 구현하면 그 churn 을 없앤다. 미구현 provider 는 호스트가
  // 기존대로 paneId 변경에 remount 로 폴백하므로 하위호환. (배지가 version 과 분리된 것과 같은 원칙.)
  update?(container: HTMLElement, ctx: PluginViewContext): void;
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

// 이 플러그인이 실제 등록한 view id(declared≡actual 의 actual). 등록 순서(Object 삽입순) 보존.
export function registeredViewIds(pluginId: string): string[] {
  return Object.values(useViewRegistry.getState().views)
    .filter((v) => v.pluginId === pluginId)
    .map((v) => v.decl.id);
}
