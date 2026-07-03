// 복원 hydration 게이트(B4) — 시각은 원자적, 자원은 지연.
// 재시작 복원은 모든 탭·레이아웃을 즉시 그리되(원자적 외형), 무거운 뷰 본문(터미널 PTY
// spawn·플러그인 마운트)은 화면에 보이는 뷰만 즉시(hot) 마운트하고 나머지(cold)는
// 승격 시점에 마운트한다. 승격 = ① 그 뷰가 화면에 드러나는 즉시(탭 전환·활성화)
// ② 부트 정착 후 idle 체인이 lastActivity 내림차순으로 1개씩(폴링 아님 —
// requestIdleCallback 재귀, 큐가 비면 소멸). 과정은 노출되지 않는다: 파킹/비활성
// 슬롯이라 채워지는 모습은 보이지 않고, 열어보면 이미(또는 즉시) 채워져 있다.

import { create } from "zustand";
import { useSessions, allGroups } from "./sessions";

interface HydrationStore {
  // 아직 본문 마운트를 미룬 뷰 id 집합. 비면 게이트는 전면 통과(평상시 비용 0).
  cold: Set<string>;
  markCold: (viewIds: string[]) => void;
  promote: (viewId: string) => void;
}

export const useHydration = create<HydrationStore>((set, get) => ({
  cold: new Set(),
  markCold: (viewIds) => {
    if (viewIds.length === 0) return;
    set({ cold: new Set([...get().cold, ...viewIds]) });
  },
  promote: (viewId) => {
    const cur = get().cold;
    if (!cur.has(viewId)) return;
    const next = new Set(cur);
    next.delete(viewId);
    set({ cold: next });
  },
}));

/** 복원 직후 1회 — 화면에 보이지 않는 복원 뷰들을 cold 로 표시하고 idle 승격 체인을 켠다.
 *  보이는 뷰 = 활성 프로젝트의 활성 컨텐츠에서 각 그룹의 activeViewId(분할이면 여러 개). */
export function beginRestoreHydration(): void {
  const s = useSessions.getState();
  const cold: string[] = [];
  const activity = new Map<string, number>();
  for (const t of s.tabs) {
    for (const c of t.contents) {
      const contentVisible = t.id === s.activeId && c.id === t.activeContentId;
      for (const g of allGroups(c.layout)) {
        for (const v of g.views) {
          if (v.kind !== "plugin") continue; // 파일 뷰는 가벼움 — 게이트 밖
          const visible = contentVisible && g.activeViewId === v.id;
          if (!visible) {
            cold.push(v.id);
            activity.set(v.id, v.lastActivity ?? 0);
          }
        }
      }
    }
  }
  if (cold.length === 0) return;
  useHydration.getState().markCold(cold);

  // idle 승격 체인 — 최근 활동 순으로 1 tick 1개(부트 직후 CPU 스파이크 분산).
  const queue = [...cold].sort((a, b) => (activity.get(b) ?? 0) - (activity.get(a) ?? 0));
  const ric: (cb: () => void) => void =
    typeof requestIdleCallback === "function"
      ? (cb) => requestIdleCallback(() => cb(), { timeout: 2000 })
      : (cb) => setTimeout(cb, 250); // 폴백(테스트 등) — 체인 1회성이라 폴링 아님
  const step = () => {
    const { cold: cur, promote } = useHydration.getState();
    // 이미 승격(탭 전환)된 항목은 건너뛴다.
    let next: string | undefined;
    while ((next = queue.shift()) !== undefined) {
      if (cur.has(next)) break;
    }
    if (next === undefined) return; // 큐 소진 — 체인 소멸
    promote(next);
    if (queue.length > 0) ric(step);
  };
  ric(step);
}
