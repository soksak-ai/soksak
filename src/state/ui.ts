import { useEffect } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

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
  // 동의 모달 미리보기(plugin.consent.preview command) — 설정/검사용으로 띄울 플러그인 id. null=닫힘.
  // App 레벨에서 렌더(사이드바 마운트 여부 무관). 활성화는 안 함(검사 전용).
  consentPreviewId: string | null;
  setConsentPreview: (id: string | null) => void;
  // 설정 모달 — null=닫힘, "general"=환경설정, 그 외=플러그인 id(딥링크). 사이드바 "설정" 바로가기 채널.
  settingsSection: string | null;
  setSettingsSection: (s: string | null) => void;
}

// 0↔1 경계에서만 네이티브 hitTest 게이트를 동기화(불필요 IPC 억제).
function syncNative(prev: number, next: number): void {
  if (prev > 0 === next > 0) return;
  // 코어가 호출 창을 자동 인지(window 주입)하므로 label 전달 불요 — 이 창의 게이트만 갱신.
  invoke("webview_overlay_active", { active: next > 0 }).catch(() => {});
}

// 부트 정렬: 메인 webview 리로드(HMR/새로고침)는 카운터를 0부터 다시 시작하지만
// 네이티브 게이트엔 직전 상태(true)가 남을 수 있다 — 시작 시 1회 false 로 맞춘다.
invoke("webview_overlay_active", { active: false }).catch(() => {});

export const useUi = create<UiState>((set) => ({
  overlayCount: 0,
  consentPreviewId: null,
  setConsentPreview: (id) => set({ consentPreviewId: id }),
  settingsSection: null,
  setSettingsSection: (s) => set({ settingsSection: s }),
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
