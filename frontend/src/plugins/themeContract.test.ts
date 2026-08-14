// Theme variable contract — core self-consistency pin + unit checks of the ghost detection util.
// The contract data (CORE_THEME_VARS) and the detection logic (findGhostThemeVars) have their single source here.
// Doctor consumes the contract.json the core publishes (themeVarContract()) and reuses the same logic — no copy.
import { describe, expect, it } from "vitest";
import { COLOR_SLOTS } from "../theme/engine";
import { CORE_THEME_VARS, findGhostThemeVars, themeVarContract } from "./themeContract";

describe("theme variable contract — self-consistency pin", () => {
  it("every engine COLOR_SLOT is in the contract, so a new slot forces a contract update", () => {
    const missing = COLOR_SLOTS.filter((s) => !CORE_THEME_VARS.has(s));
    expect(missing).toEqual([]); // non-empty is RED: the engine emits a slot the contract omits
  });

  it("themeVarContract() publishes the vars and vocab lists for Doctor", () => {
    const c = themeVarContract();
    expect(c.vars.length).toBeGreaterThan(COLOR_SLOTS.length);
    expect([...c.vars]).toEqual([...c.vars].sort());
    expect(c.vars).toContain("fg");
    expect(c.vocab).toContain("text"); // the vocabulary holds the semantic alias
  });
});

describe("findGhostThemeVars — detection logic", () => {
  it("catches a ghost that means a core token (--text, --surface)", () => {
    const css = "a{color:var(--text)}b{background:var(--surface,#fff)}c{border:var(--bd)}";
    expect(findGhostThemeVars(css)).toEqual(["surface", "text"]);
  });

  it("CSS that uses contract vars only has 0 ghosts", () => {
    const css = "a{color:var(--fg)}b{background:var(--card)}c{border:1px solid var(--bd)}d{font:var(--app-font)}";
    expect(findGhostThemeVars(css)).toEqual([]);
  });

  it("a library or private variable outside the vocabulary is not a ghost, which blocks a false positive", () => {
    const css = "a{width:var(--radix-popper-available-width)}b{gap:var(--gap)}c{color:var(--color-blue-500)}";
    expect(findGhostThemeVars(css)).toEqual([]);
  });

  it("a variable the CSS defines itself (--X:) is not a ghost", () => {
    const css = ":root{--accent:#f00}a{color:var(--accent)}";
    expect(findGhostThemeVars(css)).toEqual([]);
  });

  it("a numeric variant (bg2, text-2) is judged a ghost by its vocabulary root", () => {
    expect(findGhostThemeVars("a{background:var(--bg2)}b{color:var(--text-2)}")).toEqual(["bg2", "text-2"]);
  });

  it("a repeated reference is reported once", () => {
    expect(findGhostThemeVars("var(--text) var(--text) var(--text)")).toEqual(["text"]);
  });
});
