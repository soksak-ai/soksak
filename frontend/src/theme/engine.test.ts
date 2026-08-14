// Theme spec invariant gate — border guarantee (docs/UI.md §B1: a panel border always exists).
// Spec validation rejects a theme JSON whose declared token combination removes the border:
//   paneStyle flat (no frame) + divider overlay (no line at rest) = 0 border between panels.
// red/green: this test enforces the invariant first, and the builtin themes conform to it.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME_RELATION,
  applyThemeToDom,
  parseTheme,
} from "./engine";
import { BUILTIN_THEMES } from "./builtin";

function themeWith(chrome: Record<string, unknown>) {
  return {
    name: "Test",
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

describe("theme spec invariant — border guarantee (§B1)", () => {
  it("flat + overlay is refused (the combination that removes the panel border)", () => {
    const { theme, validation } = parseTheme(
      themeWith({ paneStyle: "flat", divider: "overlay" }),
      "test",
    );
    expect(theme).toBeNull();
    expect(validation.errors.some((e) => e.includes("§B1"))).toBe(true);
  });

  it.each([
    ["flat + solid", { paneStyle: "flat", divider: "solid" }],
    ["card + overlay", { paneStyle: "card", divider: "overlay" }],
    ["card + solid", { paneStyle: "card", divider: "solid" }],
    ["floating + overlay", { paneStyle: "floating", divider: "overlay" }],
  ])("%s is allowed (a frame or an always-on seam guarantees the border)", (_l, chrome) => {
    const { theme, validation } = parseTheme(themeWith(chrome), "test");
    expect(validation.errors).toEqual([]);
    expect(theme).not.toBeNull();
  });
});

// [PERF RULE] Single theme-change signal data-theme-epoch — a plugin (terminal) detects when to reapply
// colors from this one attribute alone, which separates it from theme-unrelated mutations such as ⌘±
// (which writes --app-font-size into style). epoch increments by 1 on every apply.
describe("data-theme-epoch — one signal per theme apply", () => {
  it("applyThemeToDom increments epoch by 1 on every call (the plugin decoupling signal)", () => {
    const { theme } = parseTheme(themeWith({}), "test");
    expect(theme).not.toBeNull();
    delete document.documentElement.dataset.themeEpoch; // reset
    applyThemeToDom(theme!, "dark");
    const e1 = Number(document.documentElement.dataset.themeEpoch);
    applyThemeToDom(theme!, "dark");
    const e2 = Number(document.documentElement.dataset.themeEpoch);
    applyThemeToDom(theme!, "light");
    const e3 = Number(document.documentElement.dataset.themeEpoch);
    expect(e1).toBe(1);
    expect(e2).toBe(2); // reapplying the same theme signals too (terminal-side diff gate makes it a no-op when colors are unchanged)
    expect(e3).toBe(3);
  });

  it("every builtin theme satisfies the invariant", () => {
    for (const raw of BUILTIN_THEMES) {
      const { theme, validation } = parseTheme(raw, "builtin");
      expect(validation.errors, `${(raw as { name: string }).name}`).toEqual([]);
      expect(theme).not.toBeNull();
    }
  });
});

describe("theme relation surface contract", () => {
  it("an old theme is normalised to the full relation defaults and stays compatible", () => {
    const { theme, validation } = parseTheme(themeWith({}), "legacy.json");
    expect(validation.errors).toEqual([]);
    expect(theme?.relation).toEqual(DEFAULT_THEME_RELATION);
  });

  it("a declared relation validates every slot and is published as DOM tokens", () => {
    const raw = {
      ...themeWith({}),
      relation: {
        stroke: "var(--ok)",
        fill: "color-mix(in srgb, var(--ok) 9%, transparent)",
        strokeWidth: 2,
        radius: 13,
        label: "badge",
      },
    };
    const { theme, validation } = parseTheme(raw, "test");
    expect(validation.errors).toEqual([]);
    applyThemeToDom(theme!, "dark");
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--relation-stroke")).toBe("var(--ok)");
    expect(root.style.getPropertyValue("--relation-fill")).toContain("var(--ok)");
    expect(root.style.getPropertyValue("--relation-stroke-w")).toBe("2px");
    expect(root.style.getPropertyValue("--relation-radius")).toBe("13px");
    expect(root.dataset.relationLabel).toBe("badge");
  });

  it("toolbar tokens — omitted injects the defaults (28/8), declared injects the theme values", () => {
    // Feature toolbar row contract: the theme defines the values (height, horizontal padding) and the
    // core injects them as variables. The toolbar is an optional surface — a feature may omit it, but
    // must consume these variables when it uses one.
    const def = parseTheme(themeWith({}), "def.json");
    expect(def.validation.errors).toEqual([]);
    applyThemeToDom(def.theme!, "light");
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--toolbar-h")).toBe("28px");
    expect(root.style.getPropertyValue("--toolbar-pad-x")).toBe("8px");

    const custom = parseTheme(
      { ...themeWith({}), toolbar: { height: 32, padX: 12 } },
      "custom.json",
    );
    expect(custom.validation.errors).toEqual([]);
    applyThemeToDom(custom.theme!, "light");
    expect(root.style.getPropertyValue("--toolbar-h")).toBe("32px");
    expect(root.style.getPropertyValue("--toolbar-pad-x")).toBe("12px");
  });

  it("toolbar tokens — an out-of-range number is refused", () => {
    const bad = parseTheme(
      { ...themeWith({}), toolbar: { height: 8, padX: 99 } },
      "bad.json",
    );
    expect(bad.theme).toBeNull();
    expect(bad.validation.errors.some((e) => e.includes("toolbar.height"))).toBe(true);
    expect(bad.validation.errors.some((e) => e.includes("toolbar.padX"))).toBe(true);
  });

  it("a new relation object refuses a partial declaration and an out-of-range number", () => {
    const partial = parseTheme(
      { ...themeWith({}), relation: { stroke: "var(--acc)" } },
      "partial.json",
    );
    expect(partial.theme).toBeNull();
    expect(partial.validation.errors.some((e) => e.includes("relation.fill"))).toBe(true);

    const invalid = parseTheme(
      {
        ...themeWith({}),
        relation: {
          stroke: "var(--acc)", fill: "transparent", strokeWidth: 8,
          radius: -1, label: "always",
        },
      },
      "invalid.json",
    );
    expect(invalid.theme).toBeNull();
  });

  it("a builtin theme declares relation explicitly rather than taking an accidental fallback", () => {
    for (const raw of BUILTIN_THEMES as Array<Record<string, unknown>>) {
      expect(raw.relation, String(raw.name)).toBeTruthy();
    }
  });
});
