// 네이티브/GPU 레이어 파킹 — 단일 진실(R12 규격화).
//
// WebGL 터미널 캔버스(xterm webgl)·네이티브 webview 는 별도 GPU 합성 레이어라 CSS `visibility:hidden`
// 만으로는 가시 영역에서 빠지지 않는다 — 투명해진 hole-punch DOM 아래로 그대로 합성돼, 활성 브라우저
// 슬롯의 홀(.bv-area)을 통해 비치며 그 위를 덮는다("브라우저인데 터미널이 보인다"). 그래서 비활성
// 컨테이너는 화면 밖으로 옮겨 캔버스를 가시 영역에서 빼되, 세션·크기는 보존한다(display:none 의 재-fit
// 회피). 이 규칙은 한 곳에만 정의하고 모든 층(콘텐츠 영역·뷰 슬롯)이 재사용한다 — 한 층에만 적용되면
// 다른 층의 비활성 캔버스가 동일하게 비친다(층 간 불일치 = 누수의 원인).
//
// 멱등: 같은 active 값이면 같은 스타일(재적용 no-op). active=true 는 transform 미설정으로 원위치.
import type { CSSProperties } from "react";

const OFFSCREEN = "translateX(-200vw)";

export function parkedStyle(active: boolean): CSSProperties {
  return {
    visibility: active ? "visible" : "hidden",
    zIndex: active ? 1 : 0,
    transform: active ? undefined : OFFSCREEN,
    // [성능] 비활성 콘텐츠 서브트리를 렌더링(style recalc·layout·paint)에서 통째로 제외한다. content-visibility:
    // hidden 은 display:none 과 달리 DOM·상태·크기를 보존하면서 렌더만 스킵한다(활성 시 즉시 복귀). 이게 없으면
    // 테마/다크라이트 변경 시 보이는 터미널의 스타일시트 교체가 *전 문서*(파킹된 터미널 DOM 포함) style recalc 를
    // 유발해 ~100ms 든다 — 파킹분을 recalc 에서 빼면 보이는 것만 recalc 되어 즉각이다. WebGL/네이티브 레이어
    // 합성 차단은 여전히 transform 오프스크린이 담당(content-visibility 는 별도 GPU 레이어를 못 막는다).
    contentVisibility: active ? "visible" : "hidden",
  } as CSSProperties;
}
