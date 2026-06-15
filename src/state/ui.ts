import { useEffect } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

// 이 webview 가 속한 창 label — 오버레이 게이트는 창별이라(멀티 윈도우) 자기 창만 갱신한다.
// 비 Tauri(jsdom 테스트)에선 getCurrentWindow 가 throw → "main" 폴백.
let WIN_LABEL = "main";
try {
  WIN_LABEL = getCurrentWindow().label;
} catch {
  // 테스트 환경 — 폴백 유지
}

// 일시적 UI 상태. overlayCount: DOM 오버레이(모달/메뉴/드롭다운/드래그)가 떠 있는
// 동안의 카운터(중첩 안전). 레이어 원칙(src-tauri/browser.rs 머리말): DOM(메인
// webview)은 항상 브라우저 child webview "위"에 그려지므로 브라우저를 숨길 필요가
// 없다 — 오버레이 동안은 홀(브라우저 영역)의 마우스 통과만 차단해(네이티브 hitTest
// 게이트) "바깥 클릭=닫기"가 성립한다. 브라우저는 보이되 비활성(모달의 본래 의미).
// (배경/색은 테마 스토어 state/theme.ts 가 단일 소스.)

interface UiState {
  overlayCount: number;
  pushOverlay: () => void;
  popOverlay: () => void;
}

// 0↔1 경계에서만 네이티브 hitTest 게이트를 동기화(불필요 IPC 억제).
function syncNative(prev: number, next: number): void {
  if (prev > 0 === next > 0) return;
  invoke("browser_overlay_active", { label: WIN_LABEL, active: next > 0 }).catch(() => {});
}

// 부트 정렬: 메인 webview 리로드(HMR/새로고침)는 카운터를 0부터 다시 시작하지만
// 네이티브 게이트엔 직전 상태(true)가 남을 수 있다 — 시작 시 1회 false 로 맞춘다.
invoke("browser_overlay_active", { active: false }).catch(() => {});

export const useUi = create<UiState>((set) => ({
  overlayCount: 0,
  pushOverlay: () =>
    set((s) => {
      syncNative(s.overlayCount, s.overlayCount + 1);
      return { overlayCount: s.overlayCount + 1 };
    }),
  popOverlay: () =>
    set((s) => {
      const next = Math.max(0, s.overlayCount - 1);
      syncNative(s.overlayCount, next);
      return { overlayCount: next };
    }),
}));

// 마운트 동안(active 가 true 인 동안) 오버레이로 등록한다 — 모든 모달/메뉴/
// 드롭다운은 반드시 이 훅을 사용한다(표시 제어가 아니라 입력 게이트다).
export function useOverlayActive(active = true): void {
  const push = useUi((s) => s.pushOverlay);
  const pop = useUi((s) => s.popOverlay);
  useEffect(() => {
    if (!active) return;
    push();
    return () => pop();
  }, [active, push, pop]);
}
