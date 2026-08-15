import { useCallback } from "react";
import { useSettings, type Language } from "./state/settings";
import { resolveText, type LocalizedText } from "./plugins/spec";

// Resolves plugin text (manifest LocalizedText §3.5) into the current language.
// Separate from host i18n (the key table) — the plugin defines its own text and the
// host only selects the current language. Re-render on language change is done by the
// consuming component via useT()/language subscription (this function is a pure getter
// that reads the latest value at call time).
// Key existence check (for dynamic key consumers — cmd.* command label lookup). base(ko) is the coverage baseline.
export function hasMessage(key: string): boolean {
  return key in ko;
}

// For the language parity gate (commandMessages.test) — the key set of each language table.
export function langKeySets(): { ko: string[]; en: string[] } {
  return { ko: Object.keys(ko), en: Object.keys(en) };
}

export function localize(t: LocalizedText): string {
  return resolveText(t, useSettings.getState().language);
}

// Non-React translation (for building command message/speak) — the out-of-hook equivalent
// of useT. Resolves the key in the current conversation language and fills {placeholder}
// from params. A command response message is built at execution time (outside React), so it
// uses this function. Per-language sentences have a single owner, the key table (ko/en below)
// — adding a language = adding a table column (call sites unchanged, P0). Coverage is
// enforced by commandMessages.test.ts.
// The language the sentence being built right now is for.
//
// A command answers whoever asked, and the window's own display language is a different fact.
// Measured 2026-08-16, an English sok call was answered TARGET_NOT_FOUND with its sentence in
// Korean — the window rendered its own language because nothing had told it the caller reads
// another.
//
// Null outside a scope, which is the ordinary case: a window drawing its own chrome reads its own
// setting, and a caller who named no language is not a caller asking for English.
let readerLanguage: Language | null = null;

/**
 * Builds sentences for a given reader for the length of one synchronous stretch.
 *
 * Synchronous on purpose. The answer — message, speak, hint — is assembled in one unbroken run, so
 * a module-level current language is exact there. It would not be across an await: two commands
 * from callers reading different languages would interleave and each could finish inside the
 * other's scope. That is why a refusal holds its key rather than a finished sentence.
 *
 * A language this build does not serve is ignored rather than substituted. Answering English to
 * someone who asked for French is a guess; answering the window's language is at least a fact
 * about this build.
 */
export function withReaderLanguage<T>(language: string | null | undefined, run: () => T): T {
  const previous = readerLanguage;
  readerLanguage = language === "ko" || language === "en" ? language : previous;
  try {
    return run();
  } finally {
    readerLanguage = previous;
  }
}

// Plural rules per language, kept because building one is not free and every counted sentence
// needs it. A caller never chooses a form itself: `n === 1 ? … : …` is right for English, wrong for
// Korean, which has one form, and wrong differently for Russian and Arabic — which is why I5
// forbids it.
const pluralRules = new Map<string, Intl.PluralRules>();

function rulesFor(language: string): Intl.PluralRules {
  let rules = pluralRules.get(language);
  if (!rules) {
    rules = new Intl.PluralRules(language);
    pluralRules.set(language, rules);
  }
  return rules;
}

/**
 * Picks one form out of an ICU plural value, and puts the number where `#` is.
 *
 *     "{n, plural, one {# pane} other {# panes}}"
 *
 * ICU because a bare separator is not safe here: the table already writes prose containing `|`
 * ("flow | pin", "stroke|fill|both"), and a separator that also appears in sentences turns one of
 * them into two forms nothing selects.
 *
 * A value that is not a plural is itself — most sentences count nothing, and a notation on all of
 * them would be a thousand places to get wrong.
 *
 * No count keeps the value as written. A caller that passes no number is not asking for a form, and
 * choosing "other" for them turns every uncounted use into the plural sentence.
 */
export function selectPluralForm(
  value: string,
  language: string,
  count: number | undefined,
): string {
  const head = /^\{\s*(\w+)\s*,\s*plural\s*,/.exec(value);
  if (!head || !value.endsWith("}")) return value;
  const forms = pluralBranches(value.slice(head[0].length, -1));
  if (forms.size === 0) return value;
  if (count === undefined) {
    // The first branch as written, so an uncounted read is a sentence rather than a notation.
    return [...forms.values()][0];
  }
  const category = rulesFor(language).select(count);
  // exact=N wins over the category, which is how ICU writes "no panes" without a rule for it.
  const chosen = forms.get(`=${count}`) ?? forms.get(category) ?? forms.get("other") ?? [...forms.values()][0];
  return chosen.split("#").join(String(count));
}

/** `one {…} other {…}` → the branches, in the order written. */
function pluralBranches(body: string): Map<string, string> {
  const branches = new Map<string, string>();
  const pattern = /(=\d+|\w+)\s*\{/g;
  for (let match = pattern.exec(body); match; match = pattern.exec(body)) {
    let depth = 1;
    let index = pattern.lastIndex;
    while (index < body.length && depth > 0) {
      if (body[index] === "{") depth += 1;
      else if (body[index] === "}") depth -= 1;
      index += 1;
    }
    // An unbalanced branch is a table entry someone mistyped. Taking what is there would answer half
    // a sentence; leaving it out lets the caller fall through to another branch or to the value.
    if (depth !== 0) break;
    branches.set(match[1], body.slice(pattern.lastIndex, index - 1));
    pattern.lastIndex = index;
  }
  return branches;
}

export function tmsg(key: MsgKey, params?: Record<string, string | number>): string {
  const lang = readerLanguage ?? useSettings.getState().language;
  const stored: string = messages[lang][key] ?? ko[key] ?? key;
  const count = countIn(params);
  let s = selectPluralForm(stored, lang, count);
  if (params) for (const k in params) s = s.split(`{${k}}`).join(String(params[k]));
  return s;
}

/** The number a sentence counts. `count` first, `n` as the name this table already uses. */
function countIn(params?: Record<string, string | number>): number | undefined {
  if (!params) return undefined;
  for (const name of ["count", "n"] as const) {
    const value = params[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

// Simple i18n: message key → ko/en. useT() returns a translation function for the current language.
// Placeholders of the form {name} are substituted from params.

import { ko } from "./i18n.ko";
import { en } from "./i18n.en";

import type { MsgKey } from "./i18n.ko";
export type { MsgKey };


const messages = { ko, en };

export type TFn = (key: MsgKey, params?: Record<string, string | number>) => string;

// Translation function for the current language. On a language change, subscribing components re-render.
// The returned function keeps a stable reference while the language is unchanged (useCallback) — passing
// t as a prop does not break a React.memo boundary (performance constitution principle 2).
export function useT(): TFn {
  const lang = useSettings((s) => s.language);
  return useCallback<TFn>(
    (key, params) => {
      // The same rule as tmsg: the forms are in the table and Intl picks one. A component that
      // chose here would be right for English and wrong for Korean.
      const stored: string = messages[lang][key] ?? ko[key] ?? key;
      let s = selectPluralForm(stored, lang, countIn(params));
      if (params) {
        for (const k in params) s = s.replace(`{${k}}`, String(params[k]));
      }
      return s;
    },
    [lang],
  );
}
