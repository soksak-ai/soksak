// 로더 생명주기 계약 — activate/deactivate·자동 수거·에러 격리(§0-4).
// blob import 는 jsdom 에서 실행 불가(수동 검증 항목) — 모듈을 직접 주입해
// activatePlugin 의 순수 로직을 전수 테스트한다(구조로 해결, 기준 저하 아님).
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activatePlugin,
  deactivateAll,
  deactivateById,
  enforceImplements,
  enforceTransparency,
  isActive,
  setActive,
} from "./loader";
import type { PluginApiDeps, PluginContext } from "./api";
import { parseManifest, type PluginManifest } from "./spec";
import { useViewRegistry } from "./viewRegistry";

function manifestOf(overrides: Record<string, unknown> = {}): PluginManifest {
  const { manifest, validation } = parseManifest(
    {
      spec: "soksak-spec-plugin@0.0.1",
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
    execute: vi.fn(async () => ({ ok: true as const, code: "OK", message: "ok" })),
    registerCommand: vi.fn(),
    unregisterCommand: vi.fn(() => true),
    getCommandDanger: () => undefined,
    on: vi.fn(() => ({ dispose: () => {} })),
    currentProject: () => null,
    onFsChange: () => () => {},
    onDataChange: () => () => {},
    onClipboardChange: () => () => {},
    getCwd: () => undefined,
    subscribeCwd: () => () => {},
    subscribeCommandFinished: () => () => {},
    subscribeWebview: () => () => {},
  };
}

beforeEach(async () => {
  await deactivateAll();
  useViewRegistry.setState({ views: {}, version: 0 });
});

describe("activatePlugin — conformance inventory(declared-but-not-registered)", () => {
  it("선언했으나 미등록인 contribution → 경고(은폐 0)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // command 'send' 를 선언하지만 activate 에서 register 하지 않는다 → 약속 미이행.
    await activatePlugin(
      { activate: () => {} },
      manifestOf({
        permissions: ["commands"],
        contributes: { commands: [{ name: "send", title: "전송" }] },
      }),
      "/d",
      fakeDeps(),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("declared-but-not-registered"),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("send"));
    warn.mockRestore();
  });

  it("선언한 걸 전부 register 하면 경고 없음", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await activatePlugin(
      {
        activate: (ctx: PluginContext) => {
          ctx.app.commands!.register("send", {
            description: "send",
            handler: async () => ({ ok: true, code: "OK", message: "ok" }),
          });
        },
      },
      manifestOf({
        permissions: ["commands"],
        contributes: { commands: [{ name: "send", title: "전송" }] },
      }),
      "/d",
      fakeDeps(),
    );
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("declared-but-not-registered"),
    );
    warn.mockRestore();
  });
});

// 결합 법칙 C2(투명성 3종) — 매니페스트 정적 규칙의 활성화 경계 시행. 판정 단일진실은 스펙 패키지
// (transparency.ts). 현행 입법표(C2_ENFORCEMENT): command-surface·view-nodes 는 blocking(활성화 거부),
// content-view-status 는 warn 출발(선언 축 신설 래칫 — 활성화는 막지 않되 위반을 표면화, 은폐 0).
describe("activatePlugin — 투명성 규칙(매니페스트 정적) 활성화 경계", () => {
  it("views>0 ∧ commands=0 → C2 command-surface 위반으로 활성화 거부(blocking)", async () => {
    await expect(
      activatePlugin(
        { activate: () => {} },
        manifestOf({
          permissions: ["ui"],
          contributes: {
            views: [{ id: "panel", title: "패널", icon: "P" }],
            nodes: [{ id: "send" }],
          },
        }),
        "/d",
        fakeDeps(),
      ),
    ).rejects.toThrow(/C2.*command-surface/);
  });

  it("fileViewers>0 ∧ commands=0 → 활성화 거부(파일 뷰어만 기여해도 기능 보유)", async () => {
    await expect(
      activatePlugin(
        { activate: () => {} },
        manifestOf({
          permissions: ["ui"],
          contributes: {
            fileViewers: [{ id: "image", extensions: ["png", "jpg"] }],
          },
        }),
        "/d",
        fakeDeps(),
      ),
    ).rejects.toThrow(/C2.*command-surface/);
  });

  it("views>0 ∧ nodes=0 → C2 view-nodes 위반으로 활성화 거부(blocking)", async () => {
    await expect(
      activatePlugin(
        { activate: () => {} },
        manifestOf({
          permissions: ["ui", "commands"],
          contributes: {
            views: [{ id: "panel", title: "패널", icon: "P" }],
            commands: [{ name: "open", title: "열기" }],
          },
        }),
        "/d",
        fakeDeps(),
      ),
    ).rejects.toThrow(/C2.*view-nodes/);
  });

  it("콘텐츠 뷰 status 선언 부재 → C2 content-view-status 거부(blocking 승격분)", async () => {
    await expect(
      activatePlugin(
        { activate: () => {} },
        manifestOf({
          permissions: ["ui", "commands"],
          contributes: {
            views: [{ id: "canvas", title: "캔버스", icon: "C", placements: ["content"] }],
            commands: [{ name: "open", title: "열기" }],
            nodes: [{ id: "send" }],
          },
        }),
        "/d",
        fakeDeps(),
      ),
    ).rejects.toThrow(/C2.*content-view-status/);
  });

  it("세 표면을 갖춘 매니페스트 → C2 경고 없음", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await activatePlugin(
      {
        activate: (ctx: PluginContext) => {
          ctx.app.commands!.register("open", {
            description: "open",
            handler: async () => ({ ok: true, code: "OK", message: "ok" }),
          });
          ctx.app.ui!.registerView("panel", { mount: () => {} });
        },
      },
      manifestOf({
        permissions: ["ui", "commands"],
        contributes: {
          views: [{ id: "panel", title: "패널", icon: "P" }],
          commands: [{ name: "open", title: "열기" }],
          nodes: [{ id: "send" }],
        },
      }),
      "/d",
      fakeDeps(),
    );
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("C2 "));
    warn.mockRestore();
  });
});

// blocking 모드 — 입법표가 blocking 인 규칙의 위반은 활성화를 거부한다(주입 표로 기제 검증).
// 현행 표는 전부 warn 이므로 이 경로는 승격(재입법 커밋) 시 살아난다 — 기제는 지금 실존해야 한다.
describe("enforceTransparency — blocking 모드(주입 표)", () => {
  const violating = () =>
    manifestOf({
      permissions: ["ui"],
      contributes: { views: [{ id: "panel", title: "패널", icon: "P" }] },
    });

  it("blocking 규칙 위반 → throw(활성화 거부)", () => {
    expect(() =>
      enforceTransparency(violating(), {
        "command-surface": "blocking",
        "view-status": "blocking",
        "view-nodes": "blocking",
        "content-view-status": "blocking",
      }),
    ).toThrow(/C2/);
  });

  it("warn 모드 위반은 throw 하지 않는다(경고만)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      enforceTransparency(violating(), {
        "command-surface": "warn",
        "view-status": "warn",
        "view-nodes": "warn",
        "content-view-status": "warn",
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("C2 command-surface"),
    );
    warn.mockRestore();
  });
});

// C3(L2 계약-핀) implements generic 검사의 활성화 경계 시행 — C2 와 같은 결(현행 표 전부 blocking).
// parseManifest 는 아직 implements 를 모른다(스키마는 plugin-spec 몫) — 필드는 파싱 뒤 부착해 검증한다.
describe("enforceImplements — C3 implements 활성화 경계", () => {
  const withImplements = (value: unknown) =>
    Object.assign(manifestOf(), { implements: value });

  it("문법 위반 선언 → 거부(blocking 승격분)", async () => {
    await expect(
      activatePlugin(
        { activate: () => {} },
        withImplements([{ id: "not-a-contract", version: "0.0.1" }]),
        "/d",
        fakeDeps(),
      ),
    ).rejects.toThrow(/C3.*implements-grammar/);
  });

  it("정상 선언·무선언 → C3 경고 없음", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await activatePlugin(
      { activate: () => {} },
      withImplements([{ id: "soksak-spec-plugin-fixture-notes", version: "0.0.1" }]),
      "/d",
      fakeDeps(),
    );
    await activatePlugin({ activate: () => {} }, manifestOf(), "/d", fakeDeps());
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("C3 "));
    warn.mockRestore();
  });

  it("blocking 규칙 위반 → throw(활성화 거부 — 주입 표로 기제 검증)", () => {
    expect(() =>
      enforceImplements(withImplements([
        { id: "soksak-spec-plugin-fixture-notes", version: "0.0.1" },
        { id: "soksak-spec-plugin-fixture-notes", version: "0.0.1" },
      ]), {
        "implements-shape": "blocking",
        "implements-grammar": "blocking",
        "implements-duplicate": "blocking",
      }),
    ).toThrow(/C3/);
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
    // C2 blocking 게이트(활성화 전)를 통과하는 적합 매니페스트 — 회수 경로 자체를 겨눈다.
    const m = manifestOf({
      permissions: ["ui", "commands"],
      contributes: {
        views: [{ id: "panel", title: "패널", icon: "P" }],
        commands: [{ name: "open", title: "열기" }],
        nodes: [{ id: "send" }],
      },
    });
    await expect(
      activatePlugin(
        {
          activate: (ctx: PluginContext) => {
            // 등록 후 폭발 — 부분 활성 상태가 남으면 안 된다.
            ctx.app.ui!.registerView("panel", { mount: () => {} });
            throw new Error("부분 실패");
          },
        },
        m,
        "/d",
        fakeDeps(),
      ),
    ).rejects.toThrow(/activate 실패/);
    expect(useViewRegistry.getState().views["demo.panel"]).toBeUndefined();
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

// 정적 모듈 계약({controller, commands, views}) — SDK 정본 형태를 창-realm 로더가 수용한다.
// 등록은 전부 기존 게이트(gateContribution declared-only)와 tracker 수거를 그대로 통과한다.
describe("activatePlugin — 정적 모듈 형태({controller, commands, views})", () => {
  const staticManifest = () =>
    manifestOf({
      permissions: ["commands", "ui"],
      contributes: {
        commands: [{ name: "hello", title: "Hello" }],
        views: [{ id: "panel", title: "패널", icon: "★" }],
        nodes: [{ id: "root" }],
      },
    });

  it("정적 모듈이 활성화되고 선언 뷰가 viewRegistry 에 등록된다", async () => {
    const activateSpy = vi.fn();
    await activatePlugin(
      {
        default: {
          controller: { activate: activateSpy, deactivate: vi.fn() },
          commands: { hello: async () => ({ ok: true }) },
          views: { panel: { mount: vi.fn() } },
        },
      },
      staticManifest(),
      "/d",
      fakeDeps(),
    );
    expect(useViewRegistry.getState().views["demo.panel"]).toBeTruthy();
    expect(activateSpy).toHaveBeenCalledOnce();
    const ctx = activateSpy.mock.calls[0][0] as { app?: unknown };
    expect(ctx.app).toBeTruthy(); // controller.activate({app}) — SDK 계약
  });

  it("정적 commands 는 파라미터를 핸들러 권위로 등록한다(스펙 미선언 파라미터가 레지스트리 검증에 막히지 않게)", async () => {
    const deps = fakeDeps();
    await activatePlugin(
      {
        default: {
          commands: { hello: async () => ({ ok: true }) },
          views: { panel: { mount: vi.fn() } },
        },
      },
      staticManifest(),
      "/d",
      deps,
    );
    const call = (deps.registerCommand as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === "plugin.demo.hello",
    );
    expect(call).toBeTruthy();
    expect((call![1] as { paramsAuthority?: string }).paramsAuthority).toBe("handler");
  });

  it("정적 commands 는 표준 답변을 data.message 로 합성한다(라벨 열화 방지)", async () => {
    const deps = fakeDeps();
    await activatePlugin(
      {
        default: {
          commands: { hello: async () => ({ ok: true, message: "인사 완료" }) },
          views: { panel: { mount: vi.fn() } },
        },
      },
      staticManifest(),
      "/d",
      deps,
    );
    const call = (deps.registerCommand as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === "plugin.demo.hello",
    );
    const spec = call![1] as { message?: (d: Record<string, unknown>) => string };
    expect(typeof spec.message).toBe("function");
    expect(spec.message!({ message: "인사 완료" })).toBe("인사 완료");
    expect(spec.message!({})).toBe("Hello");
  });

  it("정적 mount 는 {root, projectRoot, restore, signal} 컨텍스트를 받는다(B3 복원 seam 보존)", async () => {
    const mountSpy = vi.fn();
    await activatePlugin(
      {
        default: {
          commands: { hello: async () => ({ ok: true }) },
          views: { panel: { mount: mountSpy } },
        },
      },
      staticManifest(),
      "/d",
      fakeDeps(),
    );
    const reg = useViewRegistry.getState().views["demo.panel"];
    const el = document.createElement("div");
    const viewCtx = {
      projectId: "p1",
      root: "/proj",
      paneId: null,
      viewId: "v1",
      command: null,
      restore: { cwd: "/proj/sub", state: { url: "https://x" } },
      setBadge: vi.fn(),
      setStatus: vi.fn(),
      setTitle: vi.fn(),
      setRestoreState: vi.fn(),
      requestFocus: vi.fn(),
    };
    reg.provider.mount(el, viewCtx as never);
    expect(mountSpy).toHaveBeenCalledOnce();
    const sctx = mountSpy.mock.calls[0][0] as {
      root?: unknown;
      projectRoot?: unknown;
      restore?: unknown;
      signal?: unknown;
      app?: unknown;
    };
    expect(sctx.root).toBe(el); // DOM 루트
    expect(sctx.projectRoot).toBe("/proj"); // 프로젝트 경로(구 ctx.root 개명)
    expect(sctx.restore).toEqual({ cwd: "/proj/sub", state: { url: "https://x" } });
    expect(sctx.signal).toBeInstanceOf(AbortSignal);
    expect(sctx.app).toBeTruthy();
  });

  it("정적 commands 맵이 레지스트리에 등록되고 handler 가 invocation.execute 를 받는다", async () => {
    const handler = vi.fn(async () => ({ ok: true, data: 1 }));
    const deps = fakeDeps();
    await activatePlugin(
      {
        default: {
          commands: { hello: handler },
          views: { panel: { mount: vi.fn() } },
        },
      },
      staticManifest(),
      "/d",
      deps,
    );
    const call = (deps.registerCommand as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === "plugin.demo.hello",
    );
    expect(call).toBeTruthy();
    const spec = call![1] as {
      handler: (p: Record<string, unknown>, c?: unknown) => Promise<unknown>;
    };
    await spec.handler({ x: 1 }, { origin: "user", parent: null });
    expect(handler).toHaveBeenCalledOnce();
    const [params, hctx] = handler.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { invocation?: { execute?: unknown } },
    ];
    expect(params).toEqual({ x: 1 });
    expect(typeof hctx.invocation?.execute).toBe("function"); // SDK 계약
  });

  it("deactivate 가 controller.deactivate 를 부르고 등록을 수거한다", async () => {
    const deactivateSpy = vi.fn();
    const active = await activatePlugin(
      {
        default: {
          controller: { activate: vi.fn(), deactivate: deactivateSpy },
          commands: { hello: async () => ({ ok: true }) },
          views: { panel: { mount: vi.fn() } },
        },
      },
      staticManifest(),
      "/d",
      fakeDeps(),
    );
    await active.deactivate();
    expect(deactivateSpy).toHaveBeenCalledOnce();
    expect(useViewRegistry.getState().views["demo.panel"]).toBeUndefined();
  });

  it("미선언 정적 view 는 거부되고 아무것도 남지 않는다(declared-only)", async () => {
    await expect(
      activatePlugin(
        {
          default: {
            commands: { hello: async () => ({ ok: true }) },
            views: { panel: { mount: vi.fn() }, ghost: { mount: vi.fn() } },
          },
        },
        staticManifest(),
        "/d",
        fakeDeps(),
      ),
    ).rejects.toThrow();
    expect(useViewRegistry.getState().views["demo.panel"]).toBeUndefined();
    expect(useViewRegistry.getState().views["demo.ghost"]).toBeUndefined();
  });
});
