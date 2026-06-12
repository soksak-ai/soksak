// 에디터 레지스트리 — 플러그인의 CM6 확장/언어 매핑/포매터 단일 저장소.
// FileViewer 는 version 을 구독해 등록/해제 시 열린 에디터를 자동 재구성한다.
// 확장은 호스트의 @codemirror 모듈로 만들어져야 한다(§0-7 — api.editor.modules).

import { create } from "zustand";
import type { Extension } from "@codemirror/state";

export interface RegisteredExtension {
  pluginId: string;
  languages: string[] | null; // null = 전역(모든 파일)
  extension: Extension;
}

export interface RegisteredLanguage {
  pluginId: string;
  ext: string;
  lang: string; // CM6 언어 키(@uiw/codemirror-extensions-langs)
}

export interface RegisteredFormatter {
  pluginId: string;
  id: string; // 매니페스트 contributes.formatters 선언 id
  title: string;
  languages: string[];
  format: (
    text: string,
    ctx: { path: string; ext: string },
  ) => string | Promise<string>;
}

interface EditorRegistryState {
  version: number;
  extensions: RegisteredExtension[];
  languages: RegisteredLanguage[];
  formatters: RegisteredFormatter[];
  registerExtension: (reg: RegisteredExtension) => () => void;
  registerLanguage: (reg: RegisteredLanguage) => () => void;
  registerFormatter: (reg: RegisteredFormatter) => () => void;
}

function makeRemover<T>(
  pick: (s: EditorRegistryState) => T[],
  key: keyof EditorRegistryState,
  set: (
    fn: (s: EditorRegistryState) => Partial<EditorRegistryState>,
  ) => void,
  item: T,
): () => void {
  return () => {
    set((s) => {
      const list = pick(s);
      if (!list.includes(item)) return {}; // 이미 해제 — 멱등
      return {
        [key]: list.filter((x) => x !== item),
        version: s.version + 1,
      } as Partial<EditorRegistryState>;
    });
  };
}

export const useEditorRegistry = create<EditorRegistryState>((set, get) => ({
  version: 0,
  extensions: [],
  languages: [],
  formatters: [],

  registerExtension: (reg) => {
    set((s) => ({
      extensions: [...s.extensions, reg],
      version: s.version + 1,
    }));
    return makeRemover((s) => s.extensions, "extensions", set, reg);
  },

  registerLanguage: (reg) => {
    // 같은 확장자를 다른 플러그인이 이미 매핑했으면 거부(§0-3 침묵 충돌 금지).
    const existing = get().languages.find((l) => l.ext === reg.ext);
    if (existing) {
      throw new Error(
        `확장자 "${reg.ext}" 는 이미 ${existing.pluginId} 가 매핑함`,
      );
    }
    set((s) => ({
      languages: [...s.languages, reg],
      version: s.version + 1,
    }));
    return makeRemover((s) => s.languages, "languages", set, reg);
  },

  registerFormatter: (reg) => {
    set((s) => ({
      formatters: [...s.formatters, reg],
      version: s.version + 1,
    }));
    return makeRemover((s) => s.formatters, "formatters", set, reg);
  },
}));

// ── 조회(FileViewer/editor.format 소비) ──────────────────────────────────────

// 해당 확장자에 적용할 플러그인 확장(전역 + 언어 일치).
export function extensionsFor(ext: string): Extension[] {
  return useEditorRegistry
    .getState()
    .extensions.filter((e) => e.languages === null || e.languages.includes(ext))
    .map((e) => e.extension);
}

// 플러그인 언어 매핑(내장 별칭보다 우선 — FileViewer 가 먼저 조회).
export function languageFor(ext: string): string | null {
  return (
    useEditorRegistry.getState().languages.find((l) => l.ext === ext)?.lang ??
    null
  );
}

// 확장자에 맞는 포매터 — 복수 일치 시 최초 등록 우선(경고 로그).
export function formatterFor(ext: string): RegisteredFormatter | null {
  const matches = useEditorRegistry
    .getState()
    .formatters.filter((f) => f.languages.includes(ext));
  if (matches.length > 1) {
    console.warn(
      `포매터 ${matches.length}개가 "${ext}" 에 일치 — 최초 등록(${matches[0].pluginId}.${matches[0].id}) 사용`,
    );
  }
  return matches[0] ?? null;
}
