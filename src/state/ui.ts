import { useEffect } from "react";
import { create } from "zustand";

// 일시적 UI 상태. browserSuppress: 브라우저 child webview 는 네이티브 레이어라 DOM
// 오버레이(드롭 인디케이터/메뉴/모달)가 그 아래 깔린다 → 오버레이가 떠 있는 동안
// 카운터를 올려 모든 브라우저 패널을 잠시 숨긴다(중첩 안전하게 카운트).
// (배경/색은 테마 스토어 state/theme.ts 가 단일 소스.)

interface UiState {
  browserSuppress: number;
  suppressBrowser: () => void;
  releaseBrowser: () => void;
}

export const useUi = create<UiState>((set) => ({
  browserSuppress: 0,
  suppressBrowser: () =>
    set((s) => ({ browserSuppress: s.browserSuppress + 1 })),
  releaseBrowser: () =>
    set((s) => ({ browserSuppress: Math.max(0, s.browserSuppress - 1) })),
}));

// 마운트 동안(active 가 true 인 동안) 브라우저 웹뷰를 숨긴다 — 네이티브 레이어는
// 항상 DOM 위에 그려지므로 모든 모달/메뉴/드롭다운은 반드시 이 훅을 사용한다.
export function useSuppressBrowser(active = true): void {
  const suppress = useUi((s) => s.suppressBrowser);
  const release = useUi((s) => s.releaseBrowser);
  useEffect(() => {
    if (!active) return;
    suppress();
    return () => release();
  }, [active, suppress, release]);
}
