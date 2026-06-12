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
function rules(): Array<{ selector: string; decls: string }> {
  const out: Array<{ selector: string; decls: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    out.push({ selector: m[1].trim(), decls: m[2] });
  }
  return out;
}

// 탭류 박스 클래스(밴드 형제 박스 계약 대상). \w- 경계로 .tabs/.tab-dot 등은 제외.
const BAND_ITEM = /\.(view-tab|view-add|ctab-add|tab-add|ctab|tab)(?![\w-])/;

// 계약 밖 예외: 세로 레일(정사각 칩)·세로 리스트 모드 — 가로 밴드가 아니다.
const EXEMPT = /\.project-rail|\.content-tabs\.vertical/;

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
});
