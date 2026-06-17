// 로더 생명주기 계약 — activate/deactivate·자동 수거·에러 격리(§0-4).
// blob import 는 jsdom 에서 실행 불가(수동 검증 항목) — 모듈을 직접 주입해
// activatePlugin 의 순수 로직을 전수 테스트한다(구조로 해결, 기준 저하 아님).
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activatePlugin,
  deactivateAll,
  deactivateById,
  isActive,
  setActive,
} from "./loader";
import type { PluginApiDeps, PluginContext } from "./api";
import { parseManifest, type PluginManifest } from "./spec";
import { languageFor, useEditorRegistry } from "./editorRegistry";
import { useViewRegistry } from "./viewRegistry";

function manifestOf(overrides: Record<string, unknown> = {}): PluginManifest {
  const { manifest, validation } = parseManifest(
    {
      spec: "soksak-plugin-spec@1",
      id: "demo",
      name: "데모",
      version: "1.0.0",
      description: "테스트",
      permissions: [],
      ...overrides,
    },
    "demo",
  );
  if (!manifest) throw new Error(`테스트 매니페스트 불량: ${validation.errors}`);
  return manifest;
}

function fakeDeps(): PluginApiDeps {
  return {
    appVersion: "1.0.0",
    invoke: vi.fn(async () => null),
    execute: vi.fn(async () => ({ ok: true as const })),
    registerCommand: vi.fn(),
    unregisterCommand: vi.fn(() => true),
    getCommandDanger: () => undefined,
    on: vi.fn(() => ({ dispose: () => {} })),
    currentProject: () => null,
    activeFile: () => null,
    setFileText: () => false,
    onFsChange: () => () => {},
    onDataChange: () => () => {},
  };
}

beforeEach(async () => {
  await deactivateAll();
  useViewRegistry.setState({ views: {}, version: 0 });
  useEditorRegistry.setState({
    version: 0,
    extensions: [],
    languages: [],
    formatters: [],
  });
});

describe("activatePlugin — 진입점 해석", () => {
  it("named export activate 지원", async () => {
    const activate = vi.fn();
    const p = await activatePlugin({ activate }, manifestOf(), "/d", fakeDeps());
    expect(activate).toHaveBeenCalledOnce();
    const ctx = activate.mock.calls[0][0] as PluginContext;
    expect(ctx.manifest.id).toBe("demo");
    expect(ctx.dir).toBe("/d");
    expect(ctx.app.pluginId).toBe("demo");
    expect(ctx.subscriptions).toEqual([]);
    await p.deactivate();
  });

  it("default export 객체 우선", async () => {
    const namedActivate = vi.fn();
    const defaultActivate = vi.fn();
    const p = await activatePlugin(
      { activate: namedActivate, default: { activate: defaultActivate } },
      manifestOf(),
      "/d",
      fakeDeps(),
    );
    expect(defaultActivate).toHaveBeenCalledOnce();
    expect(namedActivate).not.toHaveBeenCalled();
    await p.deactivate();
  });

  it("activate 없는 모듈은 거부", async () => {
    await expect(
      activatePlugin({ foo: 1 }, manifestOf(), "/d", fakeDeps()),
    ).rejects.toThrow(/activate/);
  });
});

describe("activatePlugin — 생명주기·수거", () => {
  it("deactivate: 모듈 deactivate 호출 + subscriptions 역순 자동 dispose + 멱등", async () => {
    const order: string[] = [];
    const deactivate = vi.fn(() => {
      order.push("module-deactivate");
    });
    const p = await activatePlugin(
      {
        activate: (ctx: PluginContext) => {
          ctx.subscriptions.push({ dispose: () => order.push("sub-1") });
          ctx.subscriptions.push({ dispose: () => order.push("sub-2") });
        },
        deactivate,
      },
      manifestOf(),
      "/d",
      fakeDeps(),
    );
    await p.deactivate();
    expect(order).toEqual(["module-deactivate", "sub-2", "sub-1"]);
    await p.deactivate(); // 멱등 — 추가 호출 없음
    expect(deactivate).toHaveBeenCalledOnce();
  });

  it("deactivate 실패도 수거를 막지 못함(§0-4)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const disposed = vi.fn();
    const p = await activatePlugin(
      {
        activate: (ctx: PluginContext) => {
          ctx.subscriptions.push({ dispose: disposed });
        },
        deactivate: () => {
          throw new Error("정리 실패");
        },
      },
      manifestOf(),
      "/d",
      fakeDeps(),
    );
    await p.deactivate();
    expect(disposed).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("activate throw → 등록분(선언적 언어 포함) 전부 회수 후 전파", async () => {
    const m = manifestOf({
      permissions: ["editor", "ui"],
      contributes: {
        languages: [{ ext: "svelte", lang: "html" }],
        views: [{ id: "panel", title: "패널", icon: "P" }],
      },
    });
    await expect(
      activatePlugin(
        {
          activate: (ctx: PluginContext) => {
            // 등록 후 폭발 — 부분 활성 상태가 남으면 안 된다.
            ctx.app.ui!.registerView("panel", { mount: () => {} });
            expect(languageFor("svelte")).toBe("html"); // 선언적 자동 등록 확인
            throw new Error("부분 실패");
          },
        },
        m,
        "/d",
        fakeDeps(),
      ),
    ).rejects.toThrow(/activate 실패/);
    expect(languageFor("svelte")).toBeNull();
    expect(useViewRegistry.getState().views["demo.panel"]).toBeUndefined();
  });

  it("선언적 언어 매핑은 활성화에 적용되고 비활성화에 제거", async () => {
    const m = manifestOf({
      permissions: ["editor"],
      contributes: { languages: [{ ext: "svelte", lang: "html" }] },
    });
    const p = await activatePlugin({ activate: () => {} }, m, "/d", fakeDeps());
    expect(languageFor("svelte")).toBe("html");
    await p.deactivate();
    expect(languageFor("svelte")).toBeNull();
  });

  it("async activate 대기", async () => {
    let resolved = false;
    const p = await activatePlugin(
      {
        activate: async () => {
          await Promise.resolve();
          resolved = true;
        },
      },
      manifestOf(),
      "/d",
      fakeDeps(),
    );
    expect(resolved).toBe(true);
    await p.deactivate();
  });
});

describe("활성 인스턴스 보관", () => {
  it("setActive/isActive/deactivateById/deactivateAll", async () => {
    const d1 = vi.fn(async () => {});
    const d2 = vi.fn(async () => {});
    setActive("a", { manifest: manifestOf(), dir: "/a", deactivate: d1 });
    setActive("b", { manifest: manifestOf(), dir: "/b", deactivate: d2 });
    expect(isActive("a")).toBe(true);

    expect(await deactivateById("a")).toBe(true);
    expect(isActive("a")).toBe(false);
    expect(d1).toHaveBeenCalledOnce();
    expect(await deactivateById("a")).toBe(false); // 이미 내려감

    await deactivateAll();
    expect(isActive("b")).toBe(false);
    expect(d2).toHaveBeenCalledOnce();
  });
});
