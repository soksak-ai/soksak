// Credentials for the validator itself — fixtures pin "plant a violation, get RED".
// A validator that returns a false GREEN makes the whole contract worthless, so every
// mutation (wrong color/width/missing) asserts the exact violation report. (docs/UI.md §B — the red/green premise)
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

describe("evaluateRules — mutation detection, RED qualification", () => {
  it("GREEN for an exact 1px solid token color", () => {
    const r = evaluateRules(
      [headerRule],
      env({ ".hdr": [el({ edges: { ...el().edges, bottom: edge("1px", "solid", BD) } })] }),
    );
    expect(r).toMatchObject({ pass: true, rulesActive: 1, elementsChecked: 1 });
  });

  it.each([
    ["missing line", NO_LINE, /0px/],
    ["width violation (2px)", edge("2px", "solid", BD), /2px/],
    ["style violation (dashed)", edge("1px", "dashed", BD), /style dashed/],
    ["color violation (literal color)", edge("1px", "solid", "rgba(127, 127, 127, 0.18)"), /rgba\(127/],
    ["color violation (other token)", edge("1px", "solid", BD_SOFT), /rgba\(58, 58, 58, 0\.55\)/],
  ])("%s -> reports 1 violation", (_label, bottom, msgRe) => {
    const r = evaluateRules(
      [headerRule],
      env({ ".hdr": [el({ edges: { ...el().edges, bottom } })] }),
    );
    expect(r.pass).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatchObject({ rule: "hdr", edge: "bottom" });
    expect(r.violations[0].actual).toMatch(msgRe);
  });

  it('"none" assertion: a 1px transparent line is a violation too, it must not occupy layout', () => {
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

describe("evaluateRules — when condition, visibility, multiple matches", () => {
  const conditional: BorderRule = {
    ...headerRule,
    id: "cond",
    when: { paneStyle: ["card", "floating"] },
  };

  it("a rule whose when does not match is inactive and is not checked at all", () => {
    const r = evaluateRules(
      [conditional],
      env({ ".hdr": [el()] }, { paneStyle: "flat" }),
    );
    expect(r).toMatchObject({ pass: true, rulesActive: 0, elementsChecked: 0 });
  });

  it("active when the when condition matches", () => {
    const r = evaluateRules(
      [conditional],
      env({ ".hdr": [el()] }, { paneStyle: "card" }),
    );
    expect(r.pass).toBe(false);
    expect(r.rulesActive).toBe(1);
  });

  it("invisible elements are excluded from judgement, the keep-alive hidden stack", () => {
    const r = evaluateRules(
      [headerRule],
      env({ ".hdr": [el({ visible: false })] }),
    );
    expect(r).toMatchObject({ pass: true, elementsChecked: 0 });
  });

  it("each of multiple matches is judged separately and the index is reported", () => {
    const good = el({ edges: { ...el().edges, bottom: edge("1px", "solid", BD) } });
    const r = evaluateRules([headerRule], env({ ".hdr": [good, el(), good] }));
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].index).toBe(1);
  });

  it("zero matches passes, a surface may be absent — for example a closed sidebar", () => {
    const r = evaluateRules([headerRule], env({}));
    expect(r).toMatchObject({ pass: true, rulesActive: 1, elementsChecked: 0 });
  });
});

describe("evaluateRules — seam, the §B6 exception", () => {
  const solid: BorderRule = {
    id: "seam-solid",
    selector: ".handle",
    kind: "seam",
    seam: "bd-soft",
    when: { gutter: ["solid"] },
    note: "test",
  };
  const overlay: BorderRule = {
    id: "seam-overlay",
    selector: ".handle",
    kind: "seam",
    seam: "rest-transparent",
    when: { gutter: ["overlay"] },
    note: "test",
  };

  it("solid: GREEN when the background gradient holds the token color, RED when it does not", () => {
    const lined = el({
      backgroundImage: `linear-gradient(${BD_SOFT}, ${BD_SOFT})`,
    });
    expect(
      evaluateRules([solid], env({ ".handle": [lined] }, { gutter: "solid" })).pass,
    ).toBe(true);
    const bare = el();
    const r = evaluateRules([solid], env({ ".handle": [bare] }, { gutter: "solid" }));
    expect(r.pass).toBe(false);
    expect(r.violations[0].edge).toBe("seam");
  });

  it("overlay: RED when the resting background is painted, only fully transparent is GREEN", () => {
    const tinted = el({ backgroundColor: "rgba(127, 127, 127, 0.18)" });
    const r = evaluateRules(
      [overlay],
      env({ ".handle": [tinted] }, { gutter: "overlay" }),
    );
    expect(r.pass).toBe(false);
    expect(
      evaluateRules([overlay], env({ ".handle": [el()] }, { gutter: "overlay" })).pass,
    ).toBe(true);
  });
});
