// pane 오버레이 마운트 — 플러그인이 전역 document 로 코어 DOM 을 뒤지지 않고, paneId 로 자기 추종
// pane 의 호스트에 오버레이를 붙이게 하는 코어 인터페이스의 순수 DOM 구현(app.ui.mountPaneOverlay).
//
// [원칙] 플러그인은 코어 DOM 을 raw querySelector 로 만지지 않는다. 코어가 paneId → host lookup 을
//   대행하고 오버레이를 안전 슬롯에 마운트한다. paneId 는 command.started·statusBarItem 이 발급한
//   콘텐츠 뷰 인스턴스 id(= sessions view.id) — data-pane-id 앵커(viewHostAnchors)로 역참조한다.
//
// [안전 슬롯] data-pane-id 앵커는 .plugin-view-container 에 있으나, 그 컨테이너는 provider unmount
//   시 replaceChildren 로 비워진다(PluginViewHost). 따라서 오버레이는 컨테이너가 아니라 그 부모
//   .plugin-view-host(형제 슬롯)에 붙여야 provider 정리에 안 지워진다.
//
// host 부재 시 침묵하지 않고 throw 한다 — 침묵 실패는 942ae86 회귀(claude-gui 가 host 를 못 찾고도
//   조용히 멈춰 오버레이가 영영 안 열림)의 root cause 였다.
export function mountPaneOverlay(
  doc: Document,
  paneId: string,
  element: HTMLElement,
): () => void {
  // data-pane-id 앵커(단일 진실)로만 매칭. selector injection 회피 위해 전수 순회 비교.
  let container: Element | null = null;
  for (const c of doc.querySelectorAll(".plugin-view-container[data-pane-id]")) {
    if (c.getAttribute("data-pane-id") === paneId) {
      container = c;
      break;
    }
  }
  if (!container) {
    throw new Error(`pane 오버레이 마운트 실패: paneId="${paneId}" 의 호스트 부재`);
  }
  const host = container.parentElement; // .plugin-view-host(컨테이너 형제 슬롯)
  if (!host) {
    throw new Error(
      `pane 오버레이 마운트 실패: paneId="${paneId}" 컨테이너에 .plugin-view-host 부모 부재`,
    );
  }
  host.appendChild(element);
  return () => {
    element.remove();
  };
}
