// 테마 스펙 불변식 게이트 — 경계 보장(docs/UI.md §B1: 패널 경계는 무조건 존재).
// 테마 JSON 이 선언하는 토큰 조합이 경계를 소멸시키면 스펙 검증에서 거부한다:
//   paneStyle flat(프레임 무) + divider overlay(휴면 무선) = 패널 사이 경계 0.
// red/green: 이 테스트가 먼저 불변식을 강제하고, 내장 테마가 그에 정합한다.
import { describe, expect, it } from "vitest";
import { applyThemeToDom, parseTheme } from "./engine";
import { BUILTIN_THEMES } from "./builtin";

function themeWith(chrome: Record<string, unknown>) {
  return {
    name: "테스트",
    defaultMode: "dark",
    colors: {
      bg: "#111111", card: "#222222", side: "#1a1a1a", inset: "#0d0d0d",
      fg: "#eeeeee", fg2: "#bbbbbb", fg3: "#888888", bd: "#333333",
      acc: "#4488ff", accbg: "#223355", ok: "#33aa66", shadow: "0 0 0 #000",
    },
    chrome: {
      titlebar: "side", tabBar: "side", tabShape: "chip",
      paneStyle: "flat", panePad: "0px", divider: "solid",
      statusBg: "side", font: "system",
      ...chrome,
    },
  };
}

describe("테마 스펙 불변식 — 경계 보장(§B1)", () => {
  it("flat + overlay 는 거부(패널 경계가 소멸하는 조합)", () => {
    const { theme, validation } = parseTheme(
      themeWith({ paneStyle: "flat", divider: "overlay" }),
      "test",
    );
    expect(theme).toBeNull();
    expect(validation.errors.some((e) => e.includes("경계"))).toBe(true);
  });

  it.each([
    ["flat + solid", { paneStyle: "flat", divider: "solid" }],
    ["card + overlay", { paneStyle: "card", divider: "overlay" }],
    ["card + solid", { paneStyle: "card", divider: "solid" }],
    ["floating + overlay", { paneStyle: "floating", divider: "overlay" }],
  ])("%s 는 허용(프레임 또는 상시 seam 이 경계 보장)", (_l, chrome) => {
    const { theme, validation } = parseTheme(themeWith(chrome), "test");
    expect(validation.errors).toEqual([]);
    expect(theme).not.toBeNull();
  });
});

// [성능 RULE] 테마 변경 단일 신호 data-theme-epoch — 플러그인(터미널)이 색 재적용 시점을 이 한 속성으로만
// 알아, ⌘±(--app-font-size 가 style 에 씀) 같은 테마-무관 변이와 분리된다. 적용마다 epoch 가 1 증가한다.
describe("data-theme-epoch — 테마 적용 단일 신호", () => {
  it("applyThemeToDom 매 호출마다 epoch 1 증가(플러그인 디커플링 신호)", () => {
    const { theme } = parseTheme(themeWith({}), "test");
    expect(theme).not.toBeNull();
    delete document.documentElement.dataset.themeEpoch; // 초기화
    applyThemeToDom(theme!, "dark");
    const e1 = Number(document.documentElement.dataset.themeEpoch);
    applyThemeToDom(theme!, "dark");
    const e2 = Number(document.documentElement.dataset.themeEpoch);
    applyThemeToDom(theme!, "light");
    const e3 = Number(document.documentElement.dataset.themeEpoch);
    expect(e1).toBe(1);
    expect(e2).toBe(2); // 같은 테마 재적용도 신호(터미널 측 diff 게이트가 색 무변경이면 no-op 처리)
    expect(e3).toBe(3);
  });

  it("내장 테마 전부가 불변식을 만족한다", () => {
    for (const raw of BUILTIN_THEMES) {
      const { theme, validation } = parseTheme(raw, "builtin");
      expect(validation.errors, `${(raw as { name: string }).name}`).toEqual([]);
      expect(theme).not.toBeNull();
    }
  });
});
