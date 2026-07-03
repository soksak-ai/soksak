// 마우스가 올라간 분할 divider(리사이즈 경계). 네이티브 child(브라우저 등)는 OS 뷰라 그 위에서
// DOM :hover 가 발동하지 않는다 — 코어 네이티브-마우스 브릿지(App.tsx)가 hover 좌표의 divider 를 여기
// 세팅하고, GroupArea 가 구독해 그 divider 를 강조 + 좌우 셀을 잠깐 물려(seam) 네이티브 밑에서 divider 를
// 드러낸다. flat 테마(pane-inset 0)에서도 "마우스 올릴 때만" 경계가 보이게 하는 단일 진실. key 없으면 null.
import { create } from "zustand";

interface DividerHoverState {
  key: string | null; // `${splitId}:${index}` — 현재 hover 중인 divider. 없으면 null.
  set: (key: string | null) => void;
}

export const useDividerHover = create<DividerHoverState>((set) => ({
  key: null,
  // 같은 값이면 상태 객체를 바꾸지 않는다 — hover 이동(대부분 divider 아님=null)마다 불필요한 리렌더 방지.
  set: (key) => set((s) => (s.key === key ? s : { key })),
}));
