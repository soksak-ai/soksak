import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

// 멀티 윈도우 식별자의 단일 진실. 브라우저 child webview label 처럼 *Tauri 전역에서 유일해야 하는*
// 이름은 반드시 여기서 파생한다 — 각 창의 sessions 스토어 id(viewId 등)는 창별 카운터라 창마다 겹친다
// (두 창이 같은 v1 을 만든다). 창 label 로 네임스페이스해 전역 유일성을 보장한다.
//
// [규칙] inline 으로 `b-${viewId}` 를 다시 정의하면(흩어진 정의) 네임스페이스가 빠져 두 창이 같은
// webview label 을 만들고 충돌한다(둘째 창 브라우저 미생성·좀비). 그래서 브라우저 label 은 오직
// browserLabel() 로만 만든다 — webviewLabels.test.ts 가 inline 재정의를 빌드로 막는다.

// 현재 창 label(캐시). 각 창은 독립 JS 컨텍스트라 자기 label 을 캐시한다. Tauri 런타임 밖(jsdom
// 테스트)에서는 getCurrentWebviewWindow 가 동기 throw 하므로 "" 로 폴백한다 — 테스트는 실제 webview 를
// 만들지 않아 이 값이 Tauri 와 대조되지 않는다(폴백 값은 무해).
let cached: string | null = null;
export function currentWindowLabel(): string {
  if (cached !== null) return cached;
  try {
    cached = getCurrentWebviewWindow().label;
  } catch {
    cached = "";
  }
  return cached;
}

// 브라우저 child webview 의 전역 유일 label. 형식: b-<windowLabel>-<viewId>.
export function browserLabel(viewId: string): string {
  return `b-${currentWindowLabel()}-${viewId}`;
}

// 이 창의 브라우저 webview label 접두사 — GC 가 *자기 창* 브라우저만 대조·회수하도록 필터링한다
// (webview_list 는 앱 전역 모든 창의 브라우저를 반환하므로, 접두사로 자기 것만 골라야 다른 창 것을
// 잘못 닫지 않는다).
export function browserLabelPrefix(): string {
  return `b-${currentWindowLabel()}-`;
}
