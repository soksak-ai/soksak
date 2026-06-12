// 검증기 자체의 자격 증명 — "위반을 심으면 반드시 RED" 를 픽스처로 고정한다.
// 검증기가 가짜 GREEN 을 내면 계약 전체가 무의미하므로, 변이(잘못된 색/폭/누락)
// 마다 정확한 위반 보고를 단언한다. (docs/UI.md §B — red/green 의 전제)
import { describe, expect, it } from "vitest";
import {
  evaluateRules,
  type ElementProbe,
  type ValidateEnv,
} from "./borderValidate";
import type { BorderRule } from "./borderContract";

const BD = "rgb(58, 58, 58)";
const BD_SOFT = "rgba(58, 58, 58, 0.55)";

function edge(width: string, style: string, color: string) {
  return { width, style, color };
}
const NO_LINE = edge("0px", "none", "rgba(0, 0, 0, 0)");

function el(partial: Partial<ElementProbe> = {}): ElementProbe {
  return {
    edges: { top: NO_LINE, right: NO_LINE, bottom: NO_LINE, left: NO_LINE },
    backgroundColor: "rgba(0, 0, 0, 0)",
    backgroundImage: "none",
    visible: true,
    ...partial,
  };
}

function env(
  elements: Record<string, ElementProbe[]>,
  dataset: Record<string, string> = {},
): ValidateEnv {
  return {
    queryAll: (sel) => elements[sel] ?? [],
    dataset: (name) => dataset[name],
    resolveToken: (t) => (t === "bd" ? BD : BD_SOFT),
  };
}

const headerRule: BorderRule = {
  id: "hdr",
  selector: ".hdr",
  kind: "edges",
  edges: { bottom: "bd" },
  note: "test",
};

describe("evaluateRules — 변이 적발(RED 자격)", () => {
  it("정확한 1px solid 토큰색이면 GREEN", () => {
    const r = evaluateRules(
      [headerRule],
      env({ ".hdr": [el({ edges: { ...el().edges, bottom: edge("1px", "solid", BD) } })] }),
    );
    expect(r).toMatchObject({ pass: true, rulesActive: 1, elementsChecked: 1 });
  });

  it.each([
    ["선 누락", NO_LINE, /폭 0px|선/],
    ["폭 위반(2px)", edge("2px", "solid", BD), /폭 2px/],
    ["style 위반(dashed)", edge("1px", "dashed", BD), /style dashed/],
    ["색 위반(직색)", edge("1px", "solid", "rgba(127, 127, 127, 0.18)"), /색 rgba\(127/],
    ["색 위반(다른 토큰)", edge("1px", "solid", BD_SOFT), /색/],
  ])("%s → 위반 1건 보고", (_label, bottom, msgRe) => {
    const r = evaluateRules(
      [headerRule],
      env({ ".hdr": [el({ edges: { ...el().edges, bottom } })] }),
    );
    expect(r.pass).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatchObject({ rule: "hdr", edge: "bottom" });
    expect(r.violations[0].actual).toMatch(msgRe);
  });

  it('"none" 단언: 1px transparent 선도 위반(레이아웃 점유 금지)', () => {
    const rule: BorderRule = {
      id: "tool",
      selector: ".tool",
      kind: "edges",
      edges: { left: "none" },
      note: "test",
    };
    const bad = el({
      edges: { ...el().edges, left: edge("1px", "solid", "rgba(0, 0, 0, 0)") },
    });
    const r = evaluateRules([rule], env({ ".tool": [bad] }));
    expect(r.pass).toBe(false);
    const ok = evaluateRules([rule], env({ ".tool": [el()] }));
    expect(ok.pass).toBe(true);
  });
});

describe("evaluateRules — when 조건/가시성/다중 매치", () => {
  const conditional: BorderRule = {
    ...headerRule,
    id: "cond",
    when: { paneStyle: ["card", "floating"] },
  };

  it("when 불일치 규칙은 비활성(검사 자체를 안 함)", () => {
    const r = evaluateRules(
      [conditional],
      env({ ".hdr": [el()] }, { paneStyle: "flat" }),
    );
    expect(r).toMatchObject({ pass: true, rulesActive: 0, elementsChecked: 0 });
  });

  it("when 일치 시 활성", () => {
    const r = evaluateRules(
      [conditional],
      env({ ".hdr": [el()] }, { paneStyle: "card" }),
    );
    expect(r.pass).toBe(false);
    expect(r.rulesActive).toBe(1);
  });

  it("비가시 요소는 판정 제외(keep-alive 숨김 스택)", () => {
    const r = evaluateRules(
      [headerRule],
      env({ ".hdr": [el({ visible: false })] }),
    );
    expect(r).toMatchObject({ pass: true, elementsChecked: 0 });
  });

  it("다중 매치는 각자 판정 + index 보고", () => {
    const good = el({ edges: { ...el().edges, bottom: edge("1px", "solid", BD) } });
    const r = evaluateRules([headerRule], env({ ".hdr": [good, el(), good] }));
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].index).toBe(1);
  });

  it("매치 0개는 통과(부재 가능 표면 — 예: 닫힌 사이드바)", () => {
    const r = evaluateRules([headerRule], env({}));
    expect(r).toMatchObject({ pass: true, rulesActive: 1, elementsChecked: 0 });
  });
});

describe("evaluateRules — seam(§B6 예외)", () => {
  const solid: BorderRule = {
    id: "seam-solid",
    selector: ".handle",
    kind: "seam",
    seam: "bd-soft",
    when: { divider: ["solid"] },
    note: "test",
  };
  const overlay: BorderRule = {
    id: "seam-overlay",
    selector: ".handle",
    kind: "seam",
    seam: "rest-transparent",
    when: { divider: ["overlay"] },
    note: "test",
  };

  it("solid: 배경 그라데이션에 토큰색 있으면 GREEN, 없으면 RED", () => {
    const lined = el({
      backgroundImage: `linear-gradient(${BD_SOFT}, ${BD_SOFT})`,
    });
    expect(
      evaluateRules([solid], env({ ".handle": [lined] }, { divider: "solid" })).pass,
    ).toBe(true);
    const bare = el();
    const r = evaluateRules([solid], env({ ".handle": [bare] }, { divider: "solid" }));
    expect(r.pass).toBe(false);
    expect(r.violations[0].edge).toBe("seam");
  });

  it("overlay: 휴면 배경이 칠해져 있으면 RED(완전 투명만 GREEN)", () => {
    const tinted = el({ backgroundColor: "rgba(127, 127, 127, 0.18)" });
    const r = evaluateRules(
      [overlay],
      env({ ".handle": [tinted] }, { divider: "overlay" }),
    );
    expect(r.pass).toBe(false);
    expect(
      evaluateRules([overlay], env({ ".handle": [el()] }, { divider: "overlay" })).pass,
    ).toBe(true);
  });
});
