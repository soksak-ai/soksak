// 네이티브 child 웹뷰 GC — 불변식: *이 창의* 존재하는 `b-<windowLabel>-<viewId>` 웹뷰 집합
// ⊆ 이 창 스토어의 webview 소유 뷰 집합. 생성/파괴는 브라우저 플러그인(콘텐츠 뷰)의 수명주기가
// 담당하지만, 비동기 생성과 빠른 닫기/이동이 겹치면 고아 웹뷰(아무도 못 닫는 유령 창)가 생길 수
// 있다 — 레이아웃이 바뀔 때마다(이벤트 기반, 폴링 없음) 불변식을 검증·회수한다. label 은 창
// 네임스페이스(webviewLabels 단일 진실)라 browser_list(앱 전역)를 이 창 접두사로 걸러 *자기 창*
// 것만 회수한다(다른 창 것 종료 금지). 소유 뷰 "집합"이 변한 경우에만 네이티브 질의(browser_list)
// — 드래그 등 무관한 store 쓰기는 문자열 비교 한 번으로 끝난다(docs/PERFORMANCE.md 원칙 5).
//
// webview 를 소유하는 콘텐츠 뷰는 브라우저 플러그인 뷰(kind:"plugin", pluginId=soksak-plugin-browser)
// 하나다 — `browserLabel(view.id)` 로 child webview 를 만든다(app.webview.label = browserLabel).

import { invoke } from "@tauri-apps/api/core";
import { rafThrottle } from "./rafThrottle";
import { allGroups, useSessions, type ProjectTab } from "../state/sessions";
import { browserLabel, browserLabelPrefix } from "./webviewLabels";

// child webview 를 소유하는 플러그인 뷰의 플러그인 id. 이 플러그인의 콘텐츠 뷰는 app.webview.open
// 으로 `browserLabel(viewId)` webview 를 만든다 — 레거시 kind:"browser" 와 동일 label 스킴.
const WEBVIEW_OWNER_PLUGIN_ID = "soksak-plugin-browser";

// 순수 — tabs 에서 webview 를 소유하는 모든 뷰의 label 집합. 레거시 브라우저 뷰와 브라우저 플러그인
// 콘텐츠 뷰를 모두 센다(둘 다 browserLabel(view.id) 로 같은 webview 를 만든다). labelOf 주입으로
// 창 네임스페이스(currentWindowLabel)에 의존하지 않는 단위검증이 가능하다.
export function collectBrowserLabels(
  tabs: readonly ProjectTab[],
  labelOf: (viewId: string) => string = browserLabel,
): Set<string> {
  const live = new Set<string>();
  for (const t of tabs) {
    for (const c of t.contents) {
      for (const g of allGroups(c.layout)) {
        for (const v of g.views) {
          // 브라우저 플러그인 콘텐츠 뷰 — browserLabel(view.id) 스킴으로 child webview 소유.
          if (v.kind === "plugin" && v.pluginId === WEBVIEW_OWNER_PLUGIN_ID)
            live.add(labelOf(v.id));
        }
      }
    }
  }
  return live;
}

function liveBrowserLabels(): Set<string> {
  return collectBrowserLabels(useSessions.getState().tabs);
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
