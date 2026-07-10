// 뷰 본문 슬롯의 유효 가시성(시트 활성 && 탭 활성) — 코어가 한 곳에서 소유한다(R12 의 네이티브 층 확장).
// CSS parkedStyle 은 DOM 층만 다룬다. 네이티브 층은 코어가 직접 정리한다:
//   ① 코어 소유 child webview(browserLabel 스킴)를 표시/숨김 — 숨김은 responder 반납까지 수행
//      (webview_visible), 없는 label 은 코어 커맨드가 조용히 no-op.
//   ② 플러그인에 view.parked 사실을 통지 — 엔진 서피스 소유 플러그인이 표시/숨김·재스냅을 이 사실에
//      맞춘다. 각 플러그인의 뷰포트 추측(IntersectionObserver)·재스냅 경쟁이 규칙 하나로 대체된다.
// 멱등: 같은 상태 재커밋은 no-op — 렌더마다 불러도 비용은 변화 시에만 발생한다.
import { invoke } from "@tauri-apps/api/core";
import { emitPluginEvent } from "../plugins/hooks";
import { browserLabel } from "./webviewLabels";

const visibleByView = new Map<string, boolean>();

export function commitViewVisibility(viewId: string, visible: boolean): void {
  if (visibleByView.get(viewId) === visible) return;
  visibleByView.set(viewId, visible);
  void invoke("webview_visible", { label: browserLabel(viewId), visible }).catch(() => {});
  emitPluginEvent("view.parked", { viewId, parked: !visible });
}

/** 뷰가 영구히 닫힐 때 상태 회수(맵 누적 방지). */
export function dropViewVisibility(viewId: string): void {
  visibleByView.delete(viewId);
}
