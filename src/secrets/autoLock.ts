// [단계③] auto-lock 프론트 배선 — 사용자 활동을 백엔드에 통지(secret_touch, 스로틀)해 idle 타이머를
// 리셋하고, vault 가 idle 로 자동 잠기면(또는 수동 lock) 백엔드의 "secrets-locked" broadcast 를 받아
// DOM 이벤트로 재방출한다. UI·플러그인(터미널 폐기·잠금화면, R14)이 그 DOM 이벤트로 반응한다.
// 활동 reset 은 any-window — 어느 창의 입력이든 전역 vault 타이머를 늦춘다.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// 활동을 최대 이 간격에 한 번만 백엔드에 통지(매 키 입력마다 invoke 하지 않게 스팸 방지).
export const TOUCH_THROTTLE_MS = 10_000;

// 백엔드 broadcast 를 받아 UI 가 듣는 표준 DOM 이벤트 이름(잠금/해제 반응 단일 채널).
export const VAULT_LOCKED_EVENT = "soksak:vault-locked";
export const VAULT_UNLOCKED_EVENT = "soksak:vault-unlocked";

// 활동 통지 스로틀 — 순수 판정(now 주입)이라 테스트 가능. 마지막 통지 후 THROTTLE 경과 시에만 true.
export function shouldTouch(lastTouchMs: number, now: number): boolean {
  return now - lastTouchMs >= TOUCH_THROTTLE_MS;
}

// auto-lock 배선 시작 — cleanup 함수 반환(App useEffect 패턴). 활동 리스너 + lock broadcast 리스너 설치.
export function startAutoLock(): () => void {
  let lastTouch = 0;
  const onActivity = () => {
    const now = Date.now();
    if (!shouldTouch(lastTouch, now)) return;
    lastTouch = now;
    void invoke("secret_touch").catch(() => {});
  };
  const opts = { passive: true, capture: true } as const;
  window.addEventListener("pointerdown", onActivity, opts);
  window.addEventListener("keydown", onActivity, opts);
  window.addEventListener("focus", onActivity, opts);

  const unlisteners: Array<() => void> = [];
  // 잠금/해제 broadcast → DOM 이벤트 재방출. UI/플러그인이 듣고 반응(터미널 폐기↔재-hydrate).
  void listen<number>("secrets-locked", (e) => {
    window.dispatchEvent(new CustomEvent(VAULT_LOCKED_EVENT, { detail: { lockEpoch: e.payload } }));
  })
    .then((u) => unlisteners.push(u))
    .catch(() => {});
  void listen<number>("secrets-unlocked", (e) => {
    window.dispatchEvent(new CustomEvent(VAULT_UNLOCKED_EVENT, { detail: { lockEpoch: e.payload } }));
  })
    .then((u) => unlisteners.push(u))
    .catch(() => {});

  return () => {
    window.removeEventListener("pointerdown", onActivity, opts);
    window.removeEventListener("keydown", onActivity, opts);
    window.removeEventListener("focus", onActivity, opts);
    for (const u of unlisteners) u();
  };
}
