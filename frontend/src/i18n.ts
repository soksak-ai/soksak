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

export function tmsg(key: MsgKey, params?: Record<string, string | number>): string {
  const lang = readerLanguage ?? useSettings.getState().language;
  let s: string = messages[lang][key] ?? ko[key] ?? key;
  if (params) for (const k in params) s = s.split(`{${k}}`).join(String(params[k]));
  return s;
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
      let s: string = messages[lang][key] ?? ko[key] ?? key;
      if (params) {
        for (const k in params) s = s.replace(`{${k}}`, String(params[k]));
      }
      return s;
    },
    [lang],
  );
}
