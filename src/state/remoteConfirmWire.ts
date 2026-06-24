// 원격 confirm Tauri 배선(이벤트-우선, 폴링 0 — RULE 7) — Rust app.emit("remote-confirm-request", …)
// 를 store 큐에 연결하고, store 의 결정 sink 를 invoke("remote_confirm_resolve", …) 로 잇는다.
//
// 권위 경계: 이 모듈은 표현층 ↔ Rust 권위의 얇은 어댑터다. 결정은 invoke 한 곳으로만 나가고(데스크톱
// 전용 진입점, 폰은 닿을 경로 0), 토큰/실행은 전적으로 Rust serve loop 에 있다. 이 배선이 끊겨도
// destructive 는 실행되지 않는다 — Rust 가 TTL AUTO-DENY 로 fail-closed(단일 권위).
//
// 글로벌 listen: Rust 는 app.emit(전 창 브로드캐스트)으로 confirm 을 알린다. confirm 권위는 창마다가
// 아니라 데스크톱 단일이므로 글로벌 listen 으로 받는다. 여러 창이 동시에 resolve 해도 Rust resolve 가
// 멱등(두 번째는 false) 이라 안전 — 그래도 큐 enqueue 멱등(request_id)이 중복 표시를 막는다.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  useRemoteConfirm,
  type RemoteConfirmRequest,
} from "./remoteConfirm";

// 앱 부팅 1회 호출 — 결정 sink(→ Rust invoke) 주입 + remote-confirm-request 이벤트 구독.
// 반환 = 해지 함수(언마운트 정리). Tauri 런타임 밖(테스트)에선 listen 이 reject 하므로 무해히 무시.
export function wireRemoteConfirm(): () => void {
  // 결정 sink — 데스크톱 단일 진입점. resolve 실패(미상/이미 해결)는 무해(Rust 가 false 반환).
  useRemoteConfirm.getState().setSink((requestId, approve) => {
    invoke("remote_confirm_resolve", { requestId, approve }).catch(() => {});
  });

  let off: (() => void) | null = null;
  let cancelled = false;
  void listen<RemoteConfirmRequest>("remote-confirm-request", (e) => {
    useRemoteConfirm.getState().enqueue(e.payload);
  })
    .then((fn) => {
      if (cancelled) fn();
      else off = fn;
    })
    .catch(() => {
      /* Tauri 런타임 없음(테스트) — 구독 없음 */
    });

  return () => {
    cancelled = true;
    if (off) off();
    useRemoteConfirm.getState().setSink(null);
  };
}
