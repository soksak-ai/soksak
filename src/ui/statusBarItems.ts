// 범용 상태바 아이템 레지스트리(플러그인 소켓). 플러그인이 paneId 에 연관된 상태바
// 아이템(라벨 + 클릭 핸들러)을 등록하면, 그 pane 이 활성 터미널인 그룹의 상태바
// (GroupStatusBar)가 렌더한다. 코어는 아이템의 용도를 모른다 — claude-GUI 등 도메인은
// 전부 플러그인 소유(command.started·data-pane-id 와 동일 decoupled 원칙).

export interface StatusBarItem {
  /** 등록 식별자(해지·갱신 키). 보통 "<plugin>:<paneId>". */
  id: string;
  /** 이 아이템이 보일 터미널 pane. */
  paneId: string;
  /** 표시 텍스트. */
  label: string;
  /** 툴팁(선택). */
  title?: string;
  /** 활성(토글 on) 상태 — true 면 강조색으로 렌더. 같은 id 로 재등록해 갱신한다. */
  active?: boolean;
  /** 클릭 동작. */
  onClick: () => void;
}

const items = new Map<string, StatusBarItem>();
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

/** 상태바 아이템 등록(같은 id 면 교체). 반환 = 해지. */
export function registerStatusBarItem(item: StatusBarItem): () => void {
  items.set(item.id, item);
  notify();
  return () => {
    if (items.delete(item.id)) notify();
  };
}

/** 특정 pane 에 연관된 아이템들(등록 순). */
export function statusBarItemsForPane(paneId: string): StatusBarItem[] {
  const out: StatusBarItem[] = [];
  for (const it of items.values()) if (it.paneId === paneId) out.push(it);
  return out;
}

/** 레지스트리 변경 구독(추가/해지 시 통지). 반환 = 해지. */
export function subscribeStatusBarItems(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}
