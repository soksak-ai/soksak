// 네이티브 브라우저 child 웹뷰 GC — 불변식: *이 창의* 존재하는 `b-<windowLabel>-<viewId>` 웹뷰 집합
// ⊆ 이 창 스토어의 browser 뷰 집합. 생성/파괴는 BrowserView 컴포넌트 수명주기가 담당하지만, 비동기
// 생성과 빠른 닫기/이동이 겹치면 고아 웹뷰(아무도 못 닫는 유령 창)가 생길 수 있다 — 레이아웃이 바뀔
// 때마다(이벤트 기반, 폴링 없음) 불변식을 검증·회수한다. label 은 창 네임스페이스(webviewLabels 단일
// 진실)라 browser_list(앱 전역)를 이 창 접두사로 걸러 *자기 창* 것만 회수한다(다른 창 것 종료 금지).
// browser 뷰 "집합"이 변한 경우에만 네이티브 질의(browser_list) — 드래그 등 무관한 store 쓰기는 문자열
// 비교 한 번으로 끝난다(docs/PERFORMANCE.md 원칙 5).

import { invoke } from "@tauri-apps/api/core";
import { rafThrottle } from "./rafThrottle";
import { allGroups, useSessions } from "../state/sessions";
import { browserLabel, browserLabelPrefix } from "./webviewLabels";

function liveBrowserLabels(): Set<string> {
  const live = new Set<string>();
  for (const t of useSessions.getState().tabs) {
    for (const c of t.contents) {
      for (const g of allGroups(c.layout)) {
        for (const v of g.views) {
          if (v.kind === "browser") live.add(browserLabel(v.id));
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
    const prefix = browserLabelPrefix();
    void invoke<string[]>("browser_list")
      .then((labels) => {
        for (const label of labels) {
          // browser_list 는 앱 전역(모든 창)의 브라우저 webview 를 반환한다 — 이 창 것(prefix)만
          // 대조·회수한다. 다른 창 브라우저는 그 창 GC 가 맡으므로 절대 건드리지 않는다(교차 종료 금지).
          if (!label.startsWith(prefix)) continue;
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
