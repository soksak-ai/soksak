import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { EventCallback, EventName, UnlistenFn } from "@tauri-apps/api/event";

// 이 창(webview)으로 *타겟된* 이벤트만 구독한다. Rust 는 멀티 윈도우 신호를 emit_to(label) 로 보내므로
// 각 창은 자기 신호만 받아야 한다. 전역 listen()(@tauri-apps/api/event)은 타겟과 무관하게 모든 창의
// 이벤트를 받는다 — emit_to(win-2) 한 cmd-request 를 main 의 전역 listen 도 실행해 명령이 두 창에서
// 중복 실행된다(창별 독립 붕괴). getCurrentWebviewWindow().listen 은 "이 webview 에 emit 된 이벤트"만
// 받으므로 emit_to 타겟팅이 플랫폼 레벨에서 격리된다 — JS 쪽 label 비교(꼼수) 불요.
//
// getCurrentWebviewWindow() 는 Tauri 런타임 밖(jsdom 테스트)에서 동기적으로 throw 하므로 try 로 감싼다
// (전역 listen 은 promise reject 였지만 이건 동기 throw). 반환 = 해지 함수(언마운트 정리용).
export function listenThisWindow<T>(
  event: EventName,
  handler: EventCallback<T>,
): () => void {
  let off: UnlistenFn | null = null;
  let cancelled = false;
  try {
    void getCurrentWebviewWindow()
      .listen<T>(event, handler)
      .then((fn) => {
        if (cancelled) fn();
        else off = fn;
      })
      .catch(() => {});
  } catch {
    /* Tauri 런타임 없음(테스트) — 구독 없음 */
  }
  return () => {
    cancelled = true;
    if (off) off();
  };
}
