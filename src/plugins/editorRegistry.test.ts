// 에디터 레지스트리 계약 — 확장 스코프/언어 매핑 충돌/포매터 선택 규칙.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Extension } from "@codemirror/state";
import {
  extensionsFor,
  formatterFor,
  languageFor,
  useEditorRegistry,
} from "./editorRegistry";

const ext = (tag: string): Extension => [{ tag }] as unknown as Extension;

beforeEach(() => {
  useEditorRegistry.setState({
    version: 0,
    extensions: [],
    languages: [],
    formatters: [],
  });
});

describe("editorRegistry — 확장", () => {
  it("전역(null) 확장은 모든 확장자에, 언어 한정은 일치 시에만", () => {
    const g = ext("global");
    const j = ext("json-only");
    useEditorRegistry.getState().registerExtension({
      pluginId: "a",
      languages: null,
      extension: g,
    });
    useEditorRegistry.getState().registerExtension({
      pluginId: "b",
      languages: ["json"],
      extension: j,
    });
    expect(extensionsFor("ts")).toEqual([g]);
    expect(extensionsFor("json")).toEqual([g, j]);
  });

  it("해제는 멱등 + version 신호", () => {
    const v0 = useEditorRegistry.getState().version;
    const remove = useEditorRegistry.getState().registerExtension({
      pluginId: "a",
      languages: null,
      extension: ext("x"),
    });
    expect(useEditorRegistry.getState().version).toBe(v0 + 1);
    remove();
    expect(extensionsFor("ts")).toEqual([]);
    const v = useEditorRegistry.getState().version;
    remove();
    expect(useEditorRegistry.getState().version).toBe(v);
  });
});

describe("editorRegistry — 언어 매핑", () => {
  it("매핑 + 조회, 미등록은 null", () => {
    useEditorRegistry
      .getState()
      .registerLanguage({ pluginId: "a", ext: "svelte", lang: "html" });
    expect(languageFor("svelte")).toBe("html");
    expect(languageFor("unknown")).toBeNull();
  });

  it("동일 확장자 이중 매핑은 거부(침묵 충돌 금지)", () => {
    useEditorRegistry
      .getState()
      .registerLanguage({ pluginId: "a", ext: "svelte", lang: "html" });
    expect(() =>
      useEditorRegistry
        .getState()
        .registerLanguage({ pluginId: "b", ext: "svelte", lang: "javascript" }),
    ).toThrow(/이미.*매핑/);
  });

  it("해제 후 재매핑 가능", () => {
    const remove = useEditorRegistry
      .getState()
      .registerLanguage({ pluginId: "a", ext: "svelte", lang: "html" });
    remove();
    expect(languageFor("svelte")).toBeNull();
    useEditorRegistry
      .getState()
      .registerLanguage({ pluginId: "b", ext: "svelte", lang: "javascript" });
    expect(languageFor("svelte")).toBe("javascript");
  });
});

describe("editorRegistry — 포매터", () => {
  const fmt = (pluginId: string, id: string, languages: string[]) => ({
    pluginId,
    id,
    title: id,
    languages,
    format: (t: string) => t,
  });

  it("확장자 일치 포매터 선택, 없으면 null", () => {
    useEditorRegistry.getState().registerFormatter(fmt("a", "json-fmt", ["json"]));
    expect(formatterFor("json")?.id).toBe("json-fmt");
    expect(formatterFor("ts")).toBeNull();
  });

  it("복수 일치 시 최초 등록 우선 + 경고", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    useEditorRegistry.getState().registerFormatter(fmt("a", "first", ["json"]));
    useEditorRegistry.getState().registerFormatter(fmt("b", "second", ["json"]));
    expect(formatterFor("json")?.id).toBe("first");
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
