// 플러그인 뷰 호스트의 DOM 앵커 계약 — 코어가 발급한 식별자를 DOM 에서 역참조 가능하게 노출한다.
//
// [원칙] 대칭성: 코어가 플러그인에 발급하는 안정 식별자(paneId)는 DOM 에서 역참조 가능해야 한다.
//   statusBarItem 을 paneId 로 붙일 수 있으면, pane 오버레이도 paneId 로 붙일 수 있어야 한다.
//
// data-view-addr: 노드 스캔(nodeScan)의 baseAddress(절대 주소). 모든 배치(content/left/right).
// data-pane-id:   paneId(= 콘텐츠 뷰 인스턴스 id) 역참조 앵커. 콘텐츠 배치(viewId 有)만.
//   command.started·statusBarItem 이 발급한 paneId 로 ui:overlay:pane 플러그인이 이 host 를 찾는다.
//   사이드바 host 의 paneId 는 '추종 대상 터미널'이지 자기 인스턴스 id 가 아니므로 앵커를 안 단다.
//
// [history] 942ae86(내장 터미널 → 플러그인) 에서 코어 터미널 뷰가 박던 data-pane-id 앵커가 통합
//   호스트(PluginViewHost)로 이전되지 못해 누락 → paneId 로 host 를 찾는 claude-gui 가 회귀. 이
//   함수가 단일 진실로 그 앵커를 복원하고, viewHostAnchors.test.ts 가 재발을 차단한다.
export function viewHostAnchors(
  viewAddr: string,
  viewId: string | null,
): Record<string, string> {
  const anchors: Record<string, string> = { "data-view-addr": viewAddr };
  if (viewId) anchors["data-pane-id"] = viewId;
  return anchors;
}
