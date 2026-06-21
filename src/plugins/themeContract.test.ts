// 테마 변수 계약 — 코어 자기 정합 핀 + 유령 검출 util 의 단위 검증.
// 계약 데이터(CORE_THEME_VARS)와 검출 로직(findGhostThemeVars)은 여기 단일 소스다. Doctor 는 코어가
// 발행하는 contract.json(themeVarContract())을 소비하고 동일 로직을 재사용한다 — 복제 없음.
import { describe, expect, it } from "vitest";
import { COLOR_SLOTS } from "../theme/engine";
import { CORE_THEME_VARS, findGhostThemeVars, themeVarContract } from "./themeContract";

describe("테마 변수 계약 — 자기 정합 핀", () => {
  it("엔진 COLOR_SLOTS 는 전부 계약에 포함된다(슬롯 추가 시 계약 갱신 강제)", () => {
    const missing = COLOR_SLOTS.filter((s) => !CORE_THEME_VARS.has(s));
    expect(missing).toEqual([]); // 비면 RED: 엔진이 새 슬롯을 emit 하는데 계약이 누락
  });

  it("themeVarContract() 는 vars/vocab 발행 목록(Doctor 소비용)", () => {
    const c = themeVarContract();
    expect(c.vars.length).toBeGreaterThan(COLOR_SLOTS.length);
    expect([...c.vars]).toEqual([...c.vars].sort());
    expect(c.vars).toContain("fg");
    expect(c.vocab).toContain("text"); // 어휘에 시맨틱 별칭
  });
});

describe("findGhostThemeVars — 검출 로직", () => {
  it("코어 토큰을 의도한 유령(--text/--surface)을 잡는다", () => {
    const css = "a{color:var(--text)}b{background:var(--surface,#fff)}c{border:var(--bd)}";
    expect(findGhostThemeVars(css)).toEqual(["surface", "text"]);
  });

  it("계약 안 var 만 쓰면 유령 0", () => {
    const css = "a{color:var(--fg)}b{background:var(--card)}c{border:1px solid var(--bd)}d{font:var(--app-font)}";
    expect(findGhostThemeVars(css)).toEqual([]);
  });

  it("라이브러리/사적 변수(어휘 밖)는 유령 아님(false positive 방지)", () => {
    const css = "a{width:var(--radix-popper-available-width)}b{gap:var(--gap)}c{color:var(--color-blue-500)}";
    expect(findGhostThemeVars(css)).toEqual([]);
  });

  it("자체 정의(--X:)한 변수는 유령 아님", () => {
    const css = ":root{--accent:#f00}a{color:var(--accent)}";
    expect(findGhostThemeVars(css)).toEqual([]);
  });

  it("숫자 변형(bg2/text-2)도 어휘 뿌리로 유령 판정", () => {
    expect(findGhostThemeVars("a{background:var(--bg2)}b{color:var(--text-2)}")).toEqual(["bg2", "text-2"]);
  });

  it("중복 참조는 한 번만 보고", () => {
    expect(findGhostThemeVars("var(--text) var(--text) var(--text)")).toEqual(["text"]);
  });
});
