// 전역 tauri listen 의 안전 구독 — 단일 진실 유틸(교차 파생 한 곳 규칙).
//
// listen 은 async 라 해지가 등록 완료 전에 도착할 수 있고(중간 해지), 이미 해제된 리스너를
// 다시 해지하면 tauri 내부 맵 접근이 TypeError 로 reject 된다(HMR 모듈 폐기·StrictMode
// 이중 마운트·중복 dispose — 실측: 창 부트마다 "reject: TypeError … listeners[eventId]" 가
// boot.error 로 수확). 파일마다 손구현하던 disposed 가드+try/catch 를 여기 한 곳으로 모은다.
// 창-스코프 수신이 필요하면 lib/windowEvents.listenThisWindow(별도 유틸)를 쓴다.

import { listen, type EventCallback } from "@tauri-apps/api/event";

/** 전역 이벤트 구독(브로드캐스트 수신용). 반환 = 멱등·안전 해지. */
export function safeListen<T>(event: string, handler: EventCallback<T>): () => void {
  let un = () => {};
  let disposed = false;
  const safeUnlisten = (u: () => void) => {
    try {
      // tauri v2 의 UnlistenFn 은 내부적으로 async — 이미 해제된 리스너의 TypeError 가
      // 동기 throw 가 아니라 "반환된 promise 의 reject" 로 온다(실측 스택: _unlisten async →
      // unhandledrejection → boot.error). 동기·비동기 양쪽을 모두 무해화해야 재해지가 멱등이다.
      const r = u() as unknown;
      if (r && typeof (r as Promise<unknown>).catch === "function") {
        void (r as Promise<unknown>).catch(() => {});
      }
    } catch {
      // 이미 해제된 리스너(tauri 내부 맵 소거) — 재해지는 no-op.
    }
  };
  listen<T>(event, handler).then(
    (u) => {
      if (disposed) safeUnlisten(u);
      else un = () => safeUnlisten(u);
    },
    () => {
      // 백엔드 부재(테스트 하니스) — 구독 없음, 해지는 no-op 유지.
    },
  );
  return () => {
    disposed = true;
    un();
    un = () => {};
  };
}
