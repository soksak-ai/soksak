// 최근 프로젝트 목록 — 픽커(새 창 프로젝트 선택)의 데이터원. core kv "recentProjects"
// (makeCoreStore: app.data 권위 + localStorage 캐시 + 크로스윈도우 broadcast — 어느 창에서
// 열어도 전 창의 픽커가 같은 목록을 본다). 기록 시점 = 명시적 열기 성공(addProjectClaimed)
// 과 기본 부트 — 복원은 기록하지 않는다(이미 목록에 있던 것의 유지일 뿐).

import { coreStoreDeps } from "./workspaceBoot";
import { makeCoreStore } from "./coreStore";

export interface RecentProject {
  root: string; // 정체성(P4) — 정규화 경로
  alias: string; // 표시명(비면 폴더명)
  lastOpenedAt: number; // epoch ms
}

export const RECENT_CAP = 20;

/** 순수 upsert — 같은 root 갱신(dedup), 최근 열림 내림차순, 상한 초과는 오래된 것부터 탈락. */
export function upsertRecent(
  list: RecentProject[],
  entry: RecentProject,
  cap: number = RECENT_CAP,
): RecentProject[] {
  const rest = list.filter((r) => r.root !== entry.root);
  rest.push(entry);
  rest.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  return rest.slice(0, cap);
}

type Store = ReturnType<typeof makeCoreStore<RecentProject[]>>;
let store: Store | null = null;
function recentStore(): Store {
  store ??= makeCoreStore<RecentProject[]>({
    key: "recentProjects",
    lsKey: "soksak.recentProjects",
    fallback: [],
    ...coreStoreDeps,
  });
  return store;
}

/** 열기 성공 기록 — 실패해도 열기를 방해하지 않는다(목록은 편의 데이터). */
export async function recordRecentProject(root: string, alias: string): Promise<void> {
  try {
    const s = recentStore();
    const cur = await s.hydrate();
    await s.save(
      upsertRecent(cur, {
        root,
        alias: alias || (root.split("/").filter(Boolean).pop() ?? root),
        lastOpenedAt: Date.now(),
      }),
    );
  } catch (e) {
    console.warn("최근 프로젝트 기록 실패:", e);
  }
}

/** 픽커용 조회. */
export async function listRecentProjects(): Promise<RecentProject[]> {
  try {
    return await recentStore().hydrate();
  } catch {
    return [];
  }
}
