// 플러그인 스타일 주입 — 플러그인이 전역 document.head 에 직접 <style> 을 붙이지 않고, 코어가
// 대행하는 인터페이스의 순수 구현(app.ui.injectStyle).
//
// [원칙] 플러그인은 전역 document 를 만지지 않는다. 코어가 head 를 소유하고, key(플러그인 id, 선택적
//   서브 id) 단위로 <style> 을 멱등 관리한다. 같은 key 재주입은 새 태그를 만들지 않고 css 만 교체한다
//   (claude-gui 등이 STYLE_ID 로 중복 가드하던 패턴을 코어가 흡수). dispose 로 제거.
export function injectPluginStyle(
  doc: Document,
  key: string,
  css: string,
): () => void {
  const attr = "data-plugin-style";
  // key 매칭은 selector injection 회피 위해 전수 순회 비교(paneOverlay 선례).
  let style: HTMLStyleElement | null = null;
  for (const s of doc.querySelectorAll<HTMLStyleElement>(`style[${attr}]`)) {
    if (s.getAttribute(attr) === key) {
      style = s;
      break;
    }
  }
  if (!style) {
    style = doc.createElement("style");
    style.setAttribute(attr, key);
    doc.head.appendChild(style);
  }
  style.textContent = css;
  return () => {
    style?.remove();
  };
}
