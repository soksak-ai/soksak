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

// 결합 법칙 C2(투명성 3종) — 매니페스트 정적 규칙(command-surface·view-nodes)의 활성화 경계 시행.
// 현행 입법표(C2_ENFORCEMENT)는 전부 warn — 활성화는 막지 않되 위반을 표면화한다(은폐 0).
describe("activatePlugin — 투명성 규칙 경고(매니페스트 정적)", () => {
  it("views>0 ∧ commands=0 → C2 command-surface 경고", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await activatePlugin(
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
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("C2 command-surface"),
    );
    warn.mockRestore();
  });

  it("fileViewers>0 ∧ commands=0 → C2 command-surface 경고(파일 뷰어만 기여해도 기능 보유)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await activatePlugin(
      { activate: () => {} },
      manifestOf({
        permissions: ["ui"],
        contributes: {
          fileViewers: [{ id: "image", extensions: ["png", "jpg"] }],
        },
      }),
      "/d",
      fakeDeps(),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("C2 command-surface"),
    );
    warn.mockRestore();
  });

  it("views>0 ∧ nodes=0 → C2 view-nodes 경고", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await activatePlugin(
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
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("C2 view-nodes"));
    warn.mockRestore();
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
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("C2 command-surface"),
    );
    warn.mockRestore();
  });
});

// C3(L2 계약-핀) implements generic 검사의 활성화 경계 시행 — C2 와 같은 결(현행 표 전부 warn).
// parseManifest 는 아직 implements 를 모른다(스키마는 plugin-spec 몫) — 필드는 파싱 뒤 부착해 검증한다.
describe("enforceImplements — C3 implements 활성화 경계", () => {
  const withImplements = (value: unknown) =>
    Object.assign(manifestOf(), { implements: value });

  it("문법 위반 선언 → warn 모드에서 경고(활성화는 계속)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await activatePlugin(
      { activate: () => {} },
      withImplements(["not-a-contract"]),
      "/d",
      fakeDeps(),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("C3 implements-grammar"),
    );
    warn.mockRestore();
  });

  it("정상 선언·무선언 → C3 경고 없음", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await activatePlugin(
      { activate: () => {} },
      withImplements(["fixture-notes-spec@1"]),
      "/d",
      fakeDeps(),
    );
    await activatePlugin({ activate: () => {} }, manifestOf(), "/d", fakeDeps());
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("C3 "));
    warn.mockRestore();
  });

  it("blocking 규칙 위반 → throw(활성화 거부 — 주입 표로 기제 검증)", () => {
    expect(() =>
      enforceImplements(withImplements(["fixture-notes-spec@1", "fixture-notes-spec@1"]), {
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
    const m = manifestOf({
      permissions: ["ui"],
      contributes: {
        views: [{ id: "panel", title: "패널", icon: "P" }],
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
