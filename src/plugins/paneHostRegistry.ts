// pane host 레지스트리 — paneId → 콘텐츠 뷰 호스트 element 의 단일 진실.
//
// [원칙] 코어가 노출하는 element 는 셀렉터가 아니라 참조로 연결한다. 셀렉터(문자열/속성 매칭)는 못
//   찾으면 throw 가 아니라 null 을 주어 침묵 실패한다 — 코어 DOM 구조/클래스를 바꾸면 소비자가 조용히
//   깨진다(942ae86 회귀의 본질). 레지스트리는 element 를 직접 보유하므로 DOM 표현 변경에 면역이고,
//   미등록은 즉시 드러난다(mountPaneOverlay 가 throw).
//
// 생산자 = PluginViewHost(콘텐츠 배치, viewId 有): mount 시 register, unmount 시 해지.
// 소비자 = app.ui.mountPaneOverlay: paneId 로 host element 를 직접 받아 오버레이를 마운트.
//
// paneId 는 콘텐츠 뷰 인스턴스 id(= sessions view.id) — command.started·statusBarItem 이 발급한 값.
const registry = new Map<string, HTMLElement>();

/** paneId → host element 등록. 반환 = 해지 함수. 같은 paneId 재등록은 최신 element 로 교체한다. */
export function registerPaneHost(paneId: string, el: HTMLElement): () => void {
  registry.set(paneId, el);
  return () => {
    // 교체 후 옛 핸들의 해지가 새 등록을 지우지 않도록 동일성 확인(remount race 안전).
    if (registry.get(paneId) === el) registry.delete(paneId);
  };
}

/** paneId 의 host element. 미등록이면 undefined. */
export function getPaneHost(paneId: string): HTMLElement | undefined {
  return registry.get(paneId);
}
