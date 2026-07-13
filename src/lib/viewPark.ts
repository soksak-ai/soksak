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

// 뷰가 실제로 보이는가 — **세 층이 모두 참일 때만** 참이다: 프로젝트가 활성이고, 그 프로젝트 안에서
// 그 스페이스가 활성이고, 그 스페이스 안에서 그 뷰가 활성 탭이다. 한 층이라도 빠지면 코어는 보이지 않는
// 뷰를 "보인다"고 듣고 네이티브 child(브라우저 webview·엔진 서피스)를 화면에 남긴다 — 프로젝트를
// 전환해도 이전 프로젝트의 브라우저가 그대로 떠 있던 결함이 정확히 이것이었다(프로젝트 층 누락).
// CSS 는 이 층들을 각자 숨기지만 네이티브 층은 CSS 밖에 있으므로, 판정은 한 식으로 모은다.
export function surfaceShown(projectActive: boolean, spaceActive: boolean, tabActive: boolean): boolean {
  return projectActive && spaceActive && tabActive;
}

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
