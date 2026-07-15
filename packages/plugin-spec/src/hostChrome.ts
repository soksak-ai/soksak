// §크롬 표준 게이트 — 플러그인 entry(번들) 정적 스캔.
// 호스트가 크롬 행 band(탭/헤더)의 높이·배치를 단독 소유한다(테마별 --chrome-row-h 표준). 플러그인이 자기
// CSS 로 그 셀렉터/변수를 덮으려는 번들은 계약 위반이다 — 적재 전 entry 본문을 스캔해 명백한 위반을
// 저자 경계에서 거부한다. 런타임 보안 경계는 opaque sandbox라 host DOM 접근 자체가 불가능하다;
// 이 정적 게이트는 보안 경계 대체가 아니라 결함을 더 일찍 설명하는 authoring/conformance 진단이다.

// 호스트가 단독 소유하는 크롬 셀렉터·변수. 플러그인 CSS 에 등장하면 위반(자기 본문 슬롯만 스타일링해야 함).
export const HOST_CHROME_TOKENS: readonly string[] = [
  ".left-host-tabs",
  ".left-host-tab",
  ".content-tabs",
  ".view-tabs",
  ".view-tab",
  ".ft-header",
  ".plugin-side-head",
  ".titlebar",
  "--chrome-row-h",
  "--header-h",
  "--status-h",
];

// entry 본문에서 호스트 크롬 토큰 위반을 찾는다. CSS 문맥(뒤에 { 또는 : 가 따르는 대입)만 위반으로 본다 —
// 주석·산문 언급은 오탐하지 않게. 반환 = 발견된 토큰 목록(빈 배열이면 통과).
export function scanHostChromeViolations(entrySource: string): string[] {
  const hits: string[] = [];
  for (const tok of HOST_CHROME_TOKENS) {
    const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 셀렉터: `.left-host-tabs {` / `.left-host-tabs.foo,` 처럼 규칙 머리에 등장 + 선언블록.
    // 변수: `--chrome-row-h:` 처럼 정의/대입.
    const re = tok.startsWith("--")
      ? new RegExp(`${esc}\\s*:`)
      : new RegExp(`${esc}(?![\\w-])[^{}\`]*\\{[^}]*:`);
    if (re.test(entrySource)) hits.push(tok);
  }
  return hits;
}
