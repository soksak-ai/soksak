// Plugin-owned user-visible text. Host chrome remains host-i18n; manifest labels are either
// one base string or a language map resolved by the host's current locale.
import { isRecord } from "./util.js";

export type LocalizedText = string | Record<string, string>;

const LANG_KEY_RE = /^[a-z]{2}(-[A-Za-z0-9]{2,8})*$/;

// Exact locale first, then the first declared value so a missing translation never renders blank.
export function resolveText(text: LocalizedText, language: string): string {
  if (typeof text === "string") return text;
  if (text[language] !== undefined) return text[language];
  return Object.values(text)[0] ?? "";
}

export function validateLocalizedText(
  value: unknown,
  label: string,
  errors: string[],
): value is LocalizedText {
  if (typeof value === "string") {
    if (!value.trim()) {
      errors.push(`${label}: 비공백 문자열 필수`);
      return false;
    }
    return true;
  }
  if (!isRecord(value)) {
    errors.push(`${label}: 문자열 또는 언어 맵({ko: …, en: …})이어야 함`);
    return false;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    errors.push(`${label}: 언어 맵은 최소 1개 언어 필요`);
    return false;
  }
  for (const [language, text] of entries) {
    if (!LANG_KEY_RE.test(language)) {
      errors.push(`${label}: 언어 키 형식 위반("${language}" — 예: ko, en, zh-Hans)`);
      return false;
    }
    if (typeof text !== "string" || !text.trim()) {
      errors.push(`${label}.${language}: 비공백 문자열 필수`);
      return false;
    }
  }
  return true;
}

export function normalizeText(text: LocalizedText): LocalizedText {
  if (typeof text === "string") return text.trim();
  return Object.fromEntries(
    Object.entries(text).map(([language, value]) => [language, value.trim()]),
  );
}
