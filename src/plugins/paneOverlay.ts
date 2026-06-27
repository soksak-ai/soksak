// pane 오버레이 마운트 — 플러그인이 전역 document 로 코어 DOM 을 뒤지지 않고, paneId 로 자기 추종
// pane 의 호스트에 오버레이를 붙이게 하는 코어 인터페이스의 구현(app.ui.mountPaneOverlay).
//
// [원칙] host 는 셀렉터가 아니라 레지스트리 참조로 받는다(paneHostRegistry). 코어가 paneId → host
//   element 를 생명주기에 묶어 노출하고, 여기선 그 element 를 직접 받아 마운트한다. 셀렉터 매칭이
//   없으므로 코어 DOM 구조/클래스 변경에 면역이다.
//
// host 는 PluginViewHost 의 .plugin-view-host(콘텐츠 배치)다 — provider 가 replaceChildren 로 비우는
//   .plugin-view-container 의 부모 슬롯이라, 오버레이가 provider 정리에 안 지워진다.
//
// 미등록 host 는 침묵하지 않고 throw 한다 — 셀렉터가 null 을 돌려 조용히 멈추던 942ae86 회귀의 본질을
//   구조적으로 제거한다.
import { getPaneHost } from "./paneHostRegistry";

export function mountPaneOverlay(
  paneId: string,
  element: HTMLElement,
): () => void {
  const host = getPaneHost(paneId);
  if (!host) {
    throw new Error(
      `pane 오버레이 마운트 실패: paneId="${paneId}" 의 호스트가 레지스트리에 없음`,
    );
  }
  host.appendChild(element);
  return () => {
    element.remove();
  };
}
