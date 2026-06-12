// 네이티브 브라우저 child 웹뷰 GC — 불변식: 존재하는 `b-<viewId>` 웹뷰 집합 ⊆
// 스토어의 browser 뷰 집합. 생성/파괴는 BrowserView 컴포넌트 수명주기가 담당하지만,
// 비동기 생성과 빠른 닫기/이동이 겹치면 고아 웹뷰(아무도 못 닫는 유령 창)가 생길 수
// 있다 — 레이아웃이 바뀔 때마다(이벤트 기반, 폴링 없음) 불변식을 검증·회수한다.
// browser 뷰 "집합"이 변한 경우에만 네이티브 질의(browser_list) — 드래그 등
// 무관한 store 쓰기는 문자열 비교 한 번으로 끝난다(docs/PERFORMANCE.md 원칙 5).

import { invoke } from "@tauri-apps/api/core";
import { rafThrottle } from "./rafThrottle";
import { allGroups, useSessions } from "../state/sessions";

function liveBrowserLabels(): Set<string> {
  const live = new Set<string>();
  for (const t of useSessions.getState().tabs) {
    for (const c of t.contents) {
      for (const g of allGroups(c.layout)) {
        for (const v of g.views) {
          if (v.kind === "browser") live.add(`b-${v.id}`);
        }
      }
    }
  }
  return live;
}

let started = false;

export function startBrowserGc(): void {
  if (started) return;
  started = true;

  let lastKey: string | null = null;
  const sweep = rafThrottle(() => {
    const live = liveBrowserLabels();
    const key = [...live].sort().join(",");
    if (key === lastKey) return;
    lastKey = key;
    void invoke<string[]>("browser_list")
      .then((labels) => {
        for (const label of labels) {
          if (!live.has(label)) {
            invoke("browser_close", { label }).catch(() => {});
          }
        }
      })
      .catch(() => {});
  });

  useSessions.subscribe(() => sweep());
  sweep(); // 기동 직후 1회(HMR/이전 상태 잔재 회수)
}
