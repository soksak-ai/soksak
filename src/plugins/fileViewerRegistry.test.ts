// 파일 뷰어 레지스트리 — 확장자 매칭/우선순위/폴백/멱등 해제 계약.
import { beforeEach, describe, expect, it } from "vitest";
import {
  useFileViewerRegistry,
  resolveFileViewer,
  registeredFileViewerIds,
  type FileViewerProvider,
} from "./fileViewerRegistry";

const noop: FileViewerProvider = { mount() {} };

beforeEach(() => {
  useFileViewerRegistry.setState({ viewers: {}, version: 0 });
});

function reg(
  pluginId: string,
  id: string,
  extensions: string[],
  priority?: number,
) {
  return useFileViewerRegistry
    .getState()
    .register(
      pluginId,
      { id, extensions, ...(priority != null ? { priority } : {}) },
      noop,
    );
}

describe("registeredFileViewerIds — declared≡actual 의 actual 관찰", () => {
  it("pluginId 로 필터, 등록 순서", () => {
    reg("ed", "code", ["ts"]);
    reg("ed", "img", ["png"]);
    reg("other", "x", ["md"]);
    expect(registeredFileViewerIds("ed")).toEqual(["code", "img"]);
    expect(registeredFileViewerIds("none")).toEqual([]);
  });
});

describe("resolveFileViewer — 확장자 매칭/우선순위/폴백", () => {
  it("확장자 정확 매칭", () => {
    reg("ed", "code", ["ts", "js"]);
    expect(resolveFileViewer("/a/b.ts")?.pluginId).toBe("ed");
    expect(resolveFileViewer("/a/b.js")?.decl.id).toBe("code");
  });

  it("정확 매칭이 폴백(*)보다 우선", () => {
    reg("files", "fallback", ["*"]);
    reg("ed", "code", ["ts"]);
    expect(resolveFileViewer("/a/b.ts")?.pluginId).toBe("ed");
    expect(resolveFileViewer("/a/unknown.xyz")?.pluginId).toBe("files");
  });

  it("priority 높은 뷰어가 동일 확장자에서 우선", () => {
    reg("a", "low", ["md"], 0);
    reg("b", "high", ["md"], 10);
    expect(resolveFileViewer("/a/x.md")?.pluginId).toBe("b");
  });

  it("매칭 없으면 null", () => {
    reg("ed", "code", ["ts"]);
    expect(resolveFileViewer("/a/x.png")).toBeNull();
  });

  it("해제는 멱등 — 두 번 호출해도 안전", () => {
    const dispose = reg("ed", "code", ["ts"]);
    dispose();
    dispose();
    expect(resolveFileViewer("/a/b.ts")).toBeNull();
  });

  it("중복 등록은 throw(§0-3)", () => {
    reg("ed", "code", ["ts"]);
    expect(() => reg("ed", "code", ["js"])).toThrow();
  });
});
