// UI 정렬 헌법(docs/UI.md) 기계 게이트 — App.css 를 파싱해 규칙 위반 시 실패한다.
// R1(밴드 패딩 계약): 가로 밴드의 항목은 height 를 갖지 않는다(stretch 로 채움).
//   여백은 스트립의 padding-block 변수(--tab-pad/--ws-pad)만이 소유한다.
// R2: 탭류 항목에 위치 보정 핵(음수 오프셋·translateY·scale) 금지.
// 기준을 통과 못 한다고 이 테스트를 약화하지 마라 — 기준이 틀렸으면 docs/UI.md 의
// 규칙을 먼저 정정하라(배신 금지 조항).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src", "App.css"), "utf8");

// 단순 파서: 최상위 "selector { decls }" 단위로 분해(중첩 없음 — App.css 평면 규칙).
// 셀렉터에 붙는 주석은 제거 — 주석 속 쉼표가 셀렉터 분해를 오염시키지 않게.
function rules(): Array<{ selector: string; decls: string }> {
  const out: Array<{ selector: string; decls: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
    out.push({ selector, decls: m[2] });
  }
  return out;
}

// 탭류 박스 클래스(밴드 형제 박스 계약 대상). \w- 경계로 .tabs/.tab-dot 등은 제외.
const BAND_ITEM = /\.(view-tab|view-add|ctab-add|tab-add|ctab|tab)(?![\w-])/;

// 계약 밖 예외: 세로 레일(정사각 칩)·세로 리스트 모드 — 가로 밴드가 아니다.
const EXEMPT = /\.project-rail|\.content-tabs\.vertical/;

// 크롬 행 band(타이틀바 아래 가로줄의 탭/헤더 스트립). 높이는 테마 표준 변수만 소유(--chrome-row-h=탭행,
// --header-h=타이틀바/뷰 탭행). 하드코딩 px 금지. \.tabs 는 .content-tabs/.view-tabs 를 매치하지 않는다.
const CHROME_ROW = /\.(ft-header|plugin-side-head|left-host-tabs|content-tabs|tabs)(?![\w-])/;
// 허용 표준 변수(둘 다 테마 소유) — 크롬 행 높이는 이 중 하나의 var() 만.
const CHROME_HEIGHT_OK = /height\s*:\s*var\(--(chrome-row|header)-h/;

describe("UI 정렬 헌법 게이트 (docs/UI.md)", () => {
  it("R1: 밴드 항목은 height 금지(auto 만 허용) — 여백은 스트립 패딩이 소유", () => {
    const violations: string[] = [];
    for (const { selector, decls } of rules()) {
      if (!BAND_ITEM.test(selector) || EXEMPT.test(selector)) continue;
      const heights = decls.match(/(?:^|;)\s*height\s*:\s*([^;]+)/g) ?? [];
      for (const h of heights) {
        if (!/height\s*:\s*auto/.test(h)) {
          violations.push(`${selector} → ${h.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("R1: 죽은 변수(--tab-h/--ws-tab-h) 잔재 금지 — 계약 변수는 패딩뿐", () => {
    expect(css).not.toMatch(/--tab-h\b|--ws-tab-h\b/);
  });

  it("R2: 탭류 항목에 위치 보정 핵 금지(음수 오프셋·translateY·scale)", () => {
    const violations: string[] = [];
    for (const { selector, decls } of rules()) {
      if (!BAND_ITEM.test(selector) || EXEMPT.test(selector)) continue;
      if (/(?:^|;)\s*(top|right|bottom|left)\s*:\s*-/.test(decls)) {
        violations.push(`${selector} → 음수 오프셋`);
      }
      if (/transform\s*:\s*[^;]*(translateY|scale)/.test(decls)) {
        violations.push(`${selector} → transform 미세조정`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("R1 계약 규칙 존재: 스트립이 패딩 변수를, 항목이 stretch 를 소비한다", () => {
    // 각 밴드 스트립은 자신의 패딩 변수를 소비한다.
    expect(css).toMatch(/\.view-tabs \{[^}]*padding: var\(--tab-pad/);
    expect(css).toMatch(/\.content-tabs \{[^}]*padding: var\(--ws-pad/);
    expect(css).toMatch(/\.tabs \{[^}]*padding-block: var\(--ws-pad/);
    // 항목 일괄 stretch 계약 블록.
    expect(css).toMatch(
      /\.view-tabs \.view-tab,\s*\.view-tabs \.view-add,\s*\.tab,\s*\.ctab,\s*\.tab-add,\s*\.ctab-add \{[^}]*align-self: stretch/,
    );
  });

  // ── R3/R4: 크롬 행 높이 표준 — 좌측 사이드바 탭 band 와 컨텐츠 탭 band 가 같은 가로줄·같은 높이가 되도록
  //    모든 최상단 위치 band 가 단일 변수 --chrome-row-h 를 소유한다(테마가 그 값을 소유 = 테마별 기준).
  //    기준 미달이라고 이 테스트를 약화하지 마라 — 어긋난 band 의 CSS 를 표준에 맞춰라(배신 금지). ──
  it("R3: 크롬 행 band 높이는 표준 var(--chrome-row-h) 만 — 하드코딩 px 금지", () => {
    const violations: string[] = [];
    for (const { selector, decls } of rules()) {
      if (!CHROME_ROW.test(selector) || EXEMPT.test(selector)) continue;
      // 주석 제거 — ';'/'height' 가 주석 속에 있으면 (?:^|;) 앵커가 깨져 오탐/누락된다.
      const clean = decls.replace(/\/\*[\s\S]*?\*\//g, "");
      const heights = clean.match(/(?:^|;)\s*height\s*:\s*([^;]+)/g) ?? [];
      for (const h of heights) {
        if (!CHROME_HEIGHT_OK.test(h)) {
          violations.push(`${selector.replace(/\s+/g, " ")} → ${h.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("R4: 패널 크롬 높이 변수 정의 존재 — --chrome-row-h·--header-h·--status-h (미정의 → var() 무너짐)", () => {
    const missing: string[] = [];
    for (const v of ["--chrome-row-h", "--header-h", "--status-h"]) {
      if (!new RegExp(`${v}\\s*:`).test(css)) missing.push(v);
    }
    expect(missing).toEqual([]);
  });

  it("B4: 보더 선언에 직색(rgba/hex) 금지 — 토큰(var(--bd*))/transparent 만", () => {
    // 소유권 헌법(docs/UI.md §B4): 구조선 색은 --bd/--bd-soft 두 토큰뿐.
    // outline/box-shadow 가 아닌 border* 선언만 대상(강조 표면은 --accbg 토큰).
    const violations: string[] = [];
    for (const { selector, decls } of rules()) {
      const borders =
        decls.match(/(?:^|;)\s*border[^:;]*:\s*[^;]+/g) ?? [];
      for (const b of borders) {
        if (/rgba?\(|#[0-9a-fA-F]{3}/.test(b)) {
          violations.push(`${selector} → ${b.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("B4: --bd-soft 파생 토큰 정의 존재(내부선 톤의 단일 출처)", () => {
    expect(css).toMatch(/--bd-soft:\s*color-mix\(/);
  });

  // ── §B8 계약 전수성: 스펙이 모르는 경계면은 스펙이 못 잡는다 — 그래서
  //    "CSS 의 구조 보더 ↔ 계약 테이블" 양방향 동기화를 게이트로 강제한다.
  //    구조 보더(--bd/--bd-soft)를 긋는 셀렉터는 반드시 계약에 등재되거나,
  //    경계면이 아닌 "위젯 윤곽"으로 명시 분류돼야 한다. ──

  // 위젯 윤곽(비경계면) 허용 목록 — 입력/카드/배지/스와치 등 폐곡선 윤곽.
  // 경계면(두 영역의 분리선)이 아니므로 소유권 계약 대상이 아니다.
  const WIDGET_OUTLINE = [
    ".plugin-input",
    ".plugin-row",
    ".plugin-badge",
    ".settings-input", // 설정 입력 박스(number/text) — 폐곡선 윤곽
    ".settings-select", // 설정 드롭다운 — 폐곡선 윤곽
    ".settings-list-add", // 설정 리스트 추가 버튼 — 폐곡선 윤곽
    ".settings-list-remove", // 설정 리스트 삭제 버튼 — 폐곡선 윤곽
    ".plugin-consent-item",
    ".plugin-consent-notice",
    ".dremote-confirm-notice", // 원격 confirm 자동거부 안내 박스 — 폐곡선 윤곽(경계면 아님)
    ".plugin-consent-cmd", // 명령 원문 코드 박스 — 폐곡선 윤곽
    ".plugin-contrib-chip", // 역할 칩 — 폐곡선 윤곽
    ".egs-item", // 상태바 플러그인 항목 칩(claude-GUI 의 "gui" 등) — 폐곡선 윤곽
    ".notify-banner", // 인앱 알림 배너 카드 + 액션 버튼(-action) — 폐곡선 윤곽
    ".webview-health-badge", // webview 복구 소진 배지 카드 + 버튼 — 폐곡선 윤곽(notify-banner 동형)
    ".root-missing-banner", // root 부재 격하 배너(B1) — 배너 카드 윤곽(notify-banner 동형)
    ".orch-win", // 오케스트레이터 창맵 항목 카드(A3) — 폐곡선 윤곽
    ".orch-console input", // 오케스트레이터 콘솔 입력 — 폐곡선 윤곽
    ".orch-console button", // 오케스트레이터 실행 버튼 — 폐곡선 윤곽
    ".orch-feed-all", // 피드 전체-필터 해제 버튼 — 폐곡선 윤곽

    ".dctl",
    ".dstepper",
    ".th-cell",
    ".th-swatch",
    ".color-swatch",
    ".rail-add",
    ".plugin-rejected",
    ".ctab-rename",
    ".tab-rename",
    ".rail-rename",
    ".bv-url",
    ".cmf-input",
    ".cmf-field",
    ".icon-btn",
    ".drop-ind",
    ".view-tab", // 칩 윤곽(테마 변형) — 칩 자체의 폐곡선
    ".tab",
    ".ctab",
    ".dbtn",
    ".rail-chip",
  ];

  it("B8: 구조 보더 셀렉터는 계약 등재 또는 위젯 윤곽 분류 — 미지의 경계면 금지", async () => {
    const { BORDER_RULES } = await import("./borderContract");
    const contractSelectors = BORDER_RULES.flatMap((r) =>
      r.selector.split(",").map((s) => s.trim()),
    );
    const inContract = (selector: string) =>
      contractSelectors.some((cs) => {
        const head = cs.split(":")[0]; // ".content-tabs:not(...)" → ".content-tabs"
        return selector.includes(head);
      });
    const isWidget = (selector: string) =>
      WIDGET_OUTLINE.some((w) => selector.includes(w));

    const unknown: string[] = [];
    for (const { selector, decls } of rules()) {
      const borders = decls.match(/(?:^|;)\s*border[^:;]*:\s*[^;]+/g) ?? [];
      const structural = borders.filter((b) => /var\(--bd(-soft)?\)/.test(b));
      if (structural.length === 0) continue;
      for (const single of selector.split(",").map((s) => s.trim())) {
        if (!inContract(single) && !isWidget(single)) {
          unknown.push(`${single} → ${structural[0].trim()}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it("B8 전수성: 조건부 표면은 상태 공간을 빈틈·모순 없이 커버한다", async () => {
    // "존재해야 하는 상태"만 단언하고 반대 상태를 비워두면, 존재하면 안 되는
    // 선이 있어도 RED 가 없다 — 조건부(when) 규칙이 있는 (selector, edge/seam)
    // 단위는 paneStyle×divider 전 조합이 정확히 1개 규칙에 커버돼야 한다.
    const { BORDER_RULES } = await import("./borderContract");
    const PANE = ["flat", "card", "floating"];
    const DIV = ["overlay", "solid"];
    type Key = string; // `${selector}|${edge}`
    const targets = new Map<Key, { rule: string; when?: { paneStyle?: readonly string[]; divider?: readonly string[] } }[]>();
    for (const r of BORDER_RULES) {
      const edges = r.kind === "seam" ? ["seam"] : Object.keys(r.edges ?? {});
      for (const sel of r.selector.split(",").map((s) => s.trim())) {
        for (const e of edges) {
          const k = `${sel}|${e}`;
          if (!targets.has(k)) targets.set(k, []);
          targets.get(k)!.push({ rule: r.id, when: r.when });
        }
      }
    }
    const problems: string[] = [];
    for (const [key, rs] of targets) {
      // 무조건 규칙만 있으면 전 상태 커버 — 통과.
      if (rs.every((r) => !r.when)) {
        if (rs.length > 1) problems.push(`${key}: 무조건 규칙 중복(${rs.map((r) => r.rule)})`);
        continue;
      }
      for (const p of PANE) {
        for (const d of DIV) {
          const hits = rs.filter(
            (r) =>
              (!r.when?.paneStyle || r.when.paneStyle.includes(p)) &&
              (!r.when?.divider || r.when.divider.includes(d)),
          );
          if (hits.length === 0) {
            problems.push(`${key}: 상태 공백 paneStyle=${p},divider=${d}`);
          } else if (hits.length > 1) {
            problems.push(
              `${key}: 상태 모순 paneStyle=${p},divider=${d} → ${hits.map((h) => h.rule).join(",")}`,
            );
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("B8: 계약의 edges 규칙은 CSS 에 대응 선언 존재(공허한 규칙 금지)", async () => {
    const { BORDER_RULES } = await import("./borderContract");
    const empty: string[] = [];
    for (const r of BORDER_RULES) {
      if (r.kind !== "edges" || !r.edges) continue;
      const tokens = Object.values(r.edges).filter((v) => v !== "none");
      if (tokens.length === 0) continue; // none 단언은 선언 부재가 정답
      for (const sel of r.selector.split(",").map((s) => s.trim())) {
        const head = sel.split(":")[0].replace(/^\./, "\\.");
        const re = new RegExp(`${head}[^{]*\\{[^}]*border[^:;]*:[^;]*var\\(--bd`);
        if (!re.test(css)) empty.push(`${r.id} (${sel})`);
      }
    }
    expect(empty).toEqual([]);
  });
});
