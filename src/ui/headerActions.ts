// 범용 헤더 액션 레지스트리(플러그인 소켓). 플러그인이 타이틀바 우측 컨트롤 그룹(좌/우 사이드바 토글·
// 다크모드·설정) 왼쪽에 토글 아이콘을 등록하면, App 의 PluginHeaderActions 가 flex 로 순차 렌더한다.
// 코어는 아이템의 용도를 모른다(statusBarItems 와 동일 decoupled 원칙). pane 무관 전역 1개.

export interface HeaderAction {
  /** 등록 식별자(해지·갱신 키). data-node 주소(titlebar/<id>)에도 쓰인다. */
  id: string;
  /** 표시 글리프/이모지/짧은 텍스트. */
  label: string;
  /** 툴팁(선택). */
  title?: string;
  /** 활성(토글 on) — true 면 강조. 같은 id 재등록으로 갱신. */
  active?: boolean;
  /** 클릭 동작. */
  onClick: () => void;
}

const actions = new Map<string, HeaderAction>();
const subs = new Set<() => void>();
const notify = () => {
  for (const cb of [...subs]) {
    try {
      cb();
    } catch {
      // 구독자 실패 격리 — 다른 구독자/호스트로 전파하지 않는다.
    }
  }
};

/** 헤더 액션 등록(같은 id 면 교체). 반환 = 해지. */
export function registerHeaderAction(action: HeaderAction): () => void {
  actions.set(action.id, action);
  notify();
  return () => {
    if (actions.delete(action.id)) notify();
  };
}

/** 등록된 헤더 액션(등록 순). */
export function getHeaderActions(): HeaderAction[] {
  return Array.from(actions.values());
}

/** 레지스트리 변경 구독(추가/해지/갱신 시 통지). 반환 = 해지. */
export function subscribeHeaderActions(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}
