import { listen } from "@tauri-apps/api/event";

// 창 라이브 리사이즈(가장자리 드래그) 상태 — 네이티브(src-tauri/browser.rs
// install_live_resize_monitor)가 시작/끝을 정확히 알려준다. ResizeObserver 는
// "리사이즈 중"만 알 뿐 "끝났다"를 몰라 디바운스 추측으로 반영이 늦는다. 이
// 신호로 드래그 중엔 fit 을 멈추고(깜빡임 0) 놓는 즉시 0지연 reflow 한다.
//
// 멀티플랫폼·멀티윈도우: 신호원은 OS 마다 다르지만 코어가 이 채널("window-live-resize")로
// emit_to(그 창)하므로, 각 창은 자기 리사이즈만 받는다(프론트 필터 불필요).

let liveResizing = false;
const endCallbacks = new Set<() => void>();

// 앱 수명 1회 구독(모듈 적재 시). Tauri 런타임 밖(테스트 jsdom)에서는 listen 이
// 거부되며 조용히 무시 — 그 환경엔 라이브 리사이즈가 없다.
void listen<boolean>("window-live-resize", (e) => {
  const active = e.payload;
  if (active === liveResizing) return;
  liveResizing = active;
  // 끝나는 순간: 등록된 소비자(각 터미널의 즉시 fit)를 호출한다.
  if (!active) for (const cb of endCallbacks) cb();
}).catch(() => {});

// 지금 창을 가장자리 드래그로 리사이즈 중인가.
export function isLiveResizing(): boolean {
  return liveResizing;
}

// 라이브 리사이즈가 끝나는 순간 호출될 콜백 등록. 반환 = 해지.
export function onLiveResizeEnd(cb: () => void): () => void {
  endCallbacks.add(cb);
  return () => endCallbacks.delete(cb);
}
