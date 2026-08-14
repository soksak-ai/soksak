// File viewer registry — extension match, priority, fallback, idempotent dispose contract.
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

describe("registeredFileViewerIds — observing the actual side of declared≡actual", () => {
  it("filtered by pluginId, in registration order", () => {
    reg("ed", "code", ["ts"]);
    reg("ed", "img", ["png"]);
    reg("other", "x", ["md"]);
    expect(registeredFileViewerIds("ed")).toEqual(["code", "img"]);
    expect(registeredFileViewerIds("none")).toEqual([]);
  });
});

describe("resolveFileViewer — extension match, priority, fallback", () => {
  it("an exact extension match", () => {
    reg("ed", "code", ["ts", "js"]);
    expect(resolveFileViewer("/a/b.ts")?.pluginId).toBe("ed");
    expect(resolveFileViewer("/a/b.js")?.decl.id).toBe("code");
  });

  it("an exact match takes priority over the (*) fallback", () => {
    reg("files", "fallback", ["*"]);
    reg("ed", "code", ["ts"]);
    expect(resolveFileViewer("/a/b.ts")?.pluginId).toBe("ed");
    expect(resolveFileViewer("/a/unknown.xyz")?.pluginId).toBe("files");
  });

  it("on the same extension the higher priority viewer is chosen", () => {
    reg("a", "low", ["md"], 0);
    reg("b", "high", ["md"], 10);
    expect(resolveFileViewer("/a/x.md")?.pluginId).toBe("b");
  });

  it("no match answers null", () => {
    reg("ed", "code", ["ts"]);
    expect(resolveFileViewer("/a/x.png")).toBeNull();
  });

  it("unregister is idempotent — a second call is safe", () => {
    const dispose = reg("ed", "code", ["ts"]);
    dispose();
    dispose();
    expect(resolveFileViewer("/a/b.ts")).toBeNull();
  });

  it("duplicate registration throws (§0-3)", () => {
    reg("ed", "code", ["ts"]);
    expect(() => reg("ed", "code", ["js"])).toThrow();
  });
});
