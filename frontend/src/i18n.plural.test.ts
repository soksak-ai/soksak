// English has two forms and Korean one, and a sentence that counts has to say so.
//
// Measured 2026-08-16: an English caller asking for one pane was answered "1 panes". I5 forbids
// picking a form in the caller (`n === 1 ? … : …`) because plural rules differ by language — one
// form in Korean, two in English, three in Russian, six in Arabic. The forms are in the table and
// Intl picks one.
import { describe, expect, it } from "vitest";

import { selectPluralForm } from "./i18n";

const PANES = "{n, plural, one {# pane} other {# panes}}";

describe("choosing a form", () => {
  it("English takes one for exactly one and other for the rest", () => {
    expect(selectPluralForm(PANES, "en", 1)).toBe("1 pane");
    expect(selectPluralForm(PANES, "en", 0)).toBe("0 panes");
    expect(selectPluralForm(PANES, "en", 2)).toBe("2 panes");
  });

  it("Korean has one category and takes other whatever the number is", () => {
    // The language matters here, not the script: what this proves is that ko resolves every count
    // to the one category it has.
    const value = "{n, plural, other {# panes}}";
    for (const count of [0, 1, 2, 11]) {
      expect(selectPluralForm(value, "ko", count)).toBe(`${count} panes`);
    }
  });

  it("a plain sentence is itself, whatever the number", () => {
    // Most sentences count nothing, and a notation on all of them would be a thousand places to get
    // wrong.
    expect(selectPluralForm("Opened the page", "en", 3)).toBe("Opened the page");
  });

  it("prose containing a pipe is not read as two forms", () => {
    // The table already writes "flow | pin" and "stroke|fill|both". A bare separator would turn one
    // of those into a form nothing selects.
    expect(selectPluralForm("flow | pin, or omit it", "en", 2)).toBe("flow | pin, or omit it");
  });

  it("a plural with no count is left as written", () => {
    // A caller that passes no number is not asking for a form, and choosing "other" for them turns
    // every uncounted use into the plural sentence.
    expect(selectPluralForm(PANES, "en", undefined)).toBe("# pane");
  });

  it("an exact branch wins over the category", () => {
    const value = "{n, plural, =0 {no panes} one {# pane} other {# panes}}";
    expect(selectPluralForm(value, "en", 0)).toBe("no panes");
    expect(selectPluralForm(value, "en", 1)).toBe("1 pane");
  });

  it("a category the language does not use falls to other", () => {
    // A table written for a language with more categories must not answer nothing when read in one
    // with fewer.
    const value = "{n, plural, one {# pane} few {# panes} other {# panes}}";
    expect(selectPluralForm(value, "ko", 3)).toBe("3 panes");
  });

  it("a mistyped branch does not answer half a sentence", () => {
    // An unbalanced brace is a table entry someone got wrong. Taking what is there would answer a
    // fragment; the value as written is at least whole.
    expect(selectPluralForm("{n, plural, one {# pane other {# panes}}", "en", 1))
      .toBe("{n, plural, one {# pane other {# panes}}");
  });
});

describe("counted messages of the catalog", () => {
  it("renders the local install plan count as a sentence in both languages", async () => {
    const { tmsg } = await import("./i18n");
    const { useSettings } = await import("./state/settings");
    for (const language of ["en", "ko"] as const) {
      useSettings.setState({ language });
      const sentence = tmsg("msg.plugin.install.local.plan", { id: "soksak-plugin-example", n: 3 });
      expect(sentence).not.toContain("plural");
      expect(sentence).toContain("3");
      expect(sentence).toContain("soksak-plugin-example");
    }
  });
});
