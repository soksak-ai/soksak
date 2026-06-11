import { create } from "zustand";

// 일시적 UI 상태. browserSuppress: 브라우저 child webview 는 네이티브 레이어라 DOM
// 오버레이(드롭 인디케이터/메뉴/모달)가 그 아래 깔린다 → 오버레이가 떠 있는 동안
// 카운터를 올려 모든 브라우저 패널을 잠시 숨긴다(중첩 안전하게 카운트).

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
