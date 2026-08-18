// Loader lifecycle contract — activate/deactivate, automatic disposal, error isolation (§0-4).
// blob import does not run under jsdom (a manual verification item) — inject the module directly and
// test every branch of activatePlugin's pure logic (solved structurally, not by lowering the bar).
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activatePlugin,
  deactivateAll,
  deactivateById,
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
      name: "Demo",
      version: "1.0.0",
      description: "Test fixture",
      permissions: [],
      ...overrides,
    },
    "demo",
  );
  if (!manifest) throw new Error(`invalid test manifest: ${validation.errors}`);
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
    currentWorkspace: () => null,
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
  it("warns on a declared but unregistered contribution (zero concealment)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Declares command 'send' but never registers it in activate -> promise not kept.
    await activatePlugin(
      { activate: () => {} },
      manifestOf({
        permissions: ["commands"],
        contributes: { commands: [{ name: "send", title: "Send" }] },
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

  it("emits no warning when everything declared is registered", async () => {
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
        contributes: { commands: [{ name: "send", title: "Send" }] },
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

// Composition law C2 (three transparency rules) — manifest static rules enforced at the activation
// boundary. The single truth of the verdict is the spec package (transparency.ts). Current table
// (C2_ENFORCEMENT): command-surface and view-nodes are blocking (activation refused),
// content-view-status starts at warn (ratchet for a new declaration axis — activation is not blocked
// but the violation is surfaced, zero concealment).
describe("activatePlugin — transparency rules (manifest static) at the activation boundary", () => {
  it("views>0 and commands=0 refuses activation as a C2 command-surface violation (blocking)", async () => {
    await expect(
      activatePlugin(
        { activate: () => {} },
        manifestOf({
          permissions: ["ui"],
          contributes: {
            views: [{ id: "panel", title: "Panel", icon: "P" }],
            nodes: [{ id: "send" }],
          },
        }),
        "/d",
        fakeDeps(),
      ),
    ).rejects.toThrow(/C2.*command-surface/);
  });


  it("views>0 and nodes=0 refuses activation as a C2 view-nodes violation (blocking)", async () => {
    await expect(
      activatePlugin(
        { activate: () => {} },
        manifestOf({
          permissions: ["ui", "commands"],
          contributes: {
            views: [{ id: "panel", title: "Panel", icon: "P" }],
            commands: [{ name: "open", title: "Open" }],
          },
        }),
        "/d",
        fakeDeps(),
      ),
    ).rejects.toThrow(/C2.*view-nodes/);
  });

  it("a content view with no status declaration is refused as C2 content-view-status (promoted to blocking)", async () => {
    await expect(
      activatePlugin(
        { activate: () => {} },
        manifestOf({
          permissions: ["ui", "commands"],
          contributes: {
            views: [{ id: "canvas", title: "Canvas", icon: "C", surfaces: ["tab"], decoration: true }],
            commands: [{ name: "open", title: "Open" }],
            nodes: [{ id: "send" }],
          },
        }),
        "/d",
        fakeDeps(),
      ),
    ).rejects.toThrow(/C2.*content-view-status/);
  });

  it("emits no C2 warning for a manifest with all three surfaces", async () => {
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
          views: [{ id: "panel", title: "Panel", icon: "P" }],
          commands: [{ name: "open", title: "Open" }],
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

// blocking mode — a violation of a rule marked blocking in the table refuses activation (mechanism
// verified with an injected table). The current table is all warn, so this path goes live on
// promotion (a re-legislation commit) — the mechanism must exist now.
describe("enforceTransparency — blocking mode (injected table)", () => {
  const violating = () =>
    manifestOf({
      permissions: ["ui"],
      contributes: { views: [{ id: "panel", title: "Panel", icon: "P" }] },
    });

  it("throws on a blocking rule violation (activation refused)", () => {
    expect(() =>
      enforceTransparency(violating(), {
        "command-surface": "blocking",
        "view-status": "blocking",
        "view-nodes": "blocking",
        "content-view-status": "blocking",
      }),
    ).toThrow(/C2/);
  });

  it("does not throw on a warn mode violation (warning only)", () => {
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

// C3 (L2 contract pin) implements generic check enforced at the activation boundary — same shape as
// C2 (current table all blocking). parseManifest does not handle implements yet (the schema is
// plugin-spec's job) — attach the field after parsing and validate it.

describe("activatePlugin — entry point resolution", () => {
  it("supports a named export activate", async () => {
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

  it("prefers the default export object", async () => {
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

  it("refuses a module with no activate", async () => {
    await expect(
      activatePlugin({ foo: 1 }, manifestOf(), "/d", fakeDeps()),
    ).rejects.toThrow(/activate/);
  });
});

describe("activatePlugin — lifecycle and disposal", () => {
  it("deactivate calls the module deactivate, disposes subscriptions in reverse order, and is idempotent", async () => {
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
    await p.deactivate(); // idempotent — no extra call
    expect(deactivate).toHaveBeenCalledOnce();
  });

  it("a failed deactivate does not stop disposal (§0-4)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const disposed = vi.fn();
    const p = await activatePlugin(
      {
        activate: (ctx: PluginContext) => {
          ctx.subscriptions.push({ dispose: disposed });
        },
        deactivate: () => {
          throw new Error("cleanup failed");
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

  it("reclaims every registration (declarative ones included) and rethrows when activate throws", async () => {
    // A conforming manifest that passes the C2 blocking gate (before activation) — this aims at the disposal path itself.
    const m = manifestOf({
      permissions: ["ui", "commands"],
      contributes: {
        views: [{ id: "panel", title: "Panel", icon: "P" }],
        commands: [{ name: "open", title: "Open" }],
        nodes: [{ id: "send" }],
      },
    });
    await expect(
      activatePlugin(
        {
          activate: (ctx: PluginContext) => {
            // Explode after registering — no partially activated state may remain.
            ctx.app.ui!.registerView("panel", { mount: () => {} });
            throw new Error("partial failure");
          },
        },
        m,
        "/d",
        fakeDeps(),
      ),
    ).rejects.toThrow(/activate/);
    expect(useViewRegistry.getState().views["demo.panel"]).toBeUndefined();
  });

  it("awaits an async activate", async () => {
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

describe("active instance registry", () => {
  it("setActive/isActive/deactivateById/deactivateAll", async () => {
    const d1 = vi.fn(async () => {});
    const d2 = vi.fn(async () => {});
    setActive("a", { manifest: manifestOf(), dir: "/a", deactivate: d1 });
    setActive("b", { manifest: manifestOf(), dir: "/b", deactivate: d2 });
    expect(isActive("a")).toBe(true);

    expect(await deactivateById("a")).toBe(true);
    expect(isActive("a")).toBe(false);
    expect(d1).toHaveBeenCalledOnce();
    expect(await deactivateById("a")).toBe(false); // already down

    await deactivateAll();
    expect(isActive("b")).toBe(false);
    expect(d2).toHaveBeenCalledOnce();
  });
});

// Static module contract ({controller, commands, views}) — the window-realm loader accepts the
// canonical SDK shape. Every registration still passes the existing gate (gateContribution
// declared-only) and tracker disposal.
describe("activatePlugin — static module shape ({controller, commands, views})", () => {
  const staticManifest = () =>
    manifestOf({
      permissions: ["commands", "ui"],
      contributes: {
        commands: [{ name: "hello", title: "Hello" }],
        views: [{ id: "panel", title: "Panel", icon: "★" }],
        nodes: [{ id: "root" }],
      },
    });

  it("activates a static module and registers the declared view in viewRegistry", async () => {
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
    expect(ctx.app).toBeTruthy(); // controller.activate({app}) — SDK contract
  });

  it("registers static commands with handler parameter authority, so a parameter the spec does not declare is not blocked by registry validation", async () => {
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

  it("composes the standard answer of a static command from data.message (no label degradation)", async () => {
    const deps = fakeDeps();
    await activatePlugin(
      {
        default: {
          commands: { hello: async () => ({ ok: true, message: "Greeted" }) },
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
    expect(spec.message!({ message: "Greeted" })).toBe("Greeted");
    expect(spec.message!({})).toBe("Hello");
  });

  it("passes a {root, workspaceRoot, restore, signal} context to a static mount (B3 restore seam kept)", async () => {
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
      projectId: "wsp-aaaaaa",
      root: "/proj",
      paneId: null,
      viewId: "tab-aaaaaa",
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
      workspaceRoot?: unknown;
      restore?: unknown;
      signal?: unknown;
      app?: unknown;
    };
    expect(sctx.root).toBe(el); // DOM root
    expect(sctx.workspaceRoot).toBe("/proj"); // workspace path (renamed from ctx.root)
    expect(sctx.restore).toEqual({ cwd: "/proj/sub", state: { url: "https://x" } });
    expect(sctx.signal).toBeInstanceOf(AbortSignal);
    expect(sctx.app).toBeTruthy();
  });

  it("registers the static commands map and passes invocation.execute to the handler", async () => {
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
    expect(typeof hctx.invocation?.execute).toBe("function"); // SDK contract
  });

  it("deactivate calls controller.deactivate and reclaims the registrations", async () => {
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

  it("refuses an undeclared static view and leaves nothing behind (declared-only)", async () => {
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

// Rule — whatever the core waits on answers with a value.
//
// The core waits on `activate` (a plugin's commands and views exist only after registration
// finishes). The plugin defines what happens there, so an activate that reads storage or goes over
// the network puts that whole time on boot. Measured 2026-08-08: with no view open, one plugin
// restored its own document inside activate and spent 429ms; the ledger held only that query, not
// what caused it.
//
// Do not block it. Measure it with a name — what is not measured cannot be named, and what is not
// named nobody fixes.
describe("activate cost stays in the ledger with a name", () => {
  it("emits a boot.step under that plugin's name when activation finishes", async () => {
    const framework = await import("../framework");
    const invoke = vi.spyOn(framework, "invoke").mockResolvedValue(undefined as never);
    await activatePlugin({ activate: () => {} }, manifestOf(), "/d", fakeDeps());
    const stamped = invoke.mock.calls.find(
      ([cmd, args]) =>
        cmd === "activity_publish" &&
        String((args as { payload?: { step?: unknown } })?.payload?.step ?? "").startsWith(
          "plugin-activate:",
        ),
    );
    expect(stamped, "no one recorded the activation cost").toBeTruthy();
    const payload = (stamped?.[1] as { payload: { step: string; tookMs: unknown } }).payload;
    expect(payload.step).toBe("plugin-activate:demo");
    expect(typeof payload.tookMs).toBe("number");
    invoke.mockRestore();
  });

  // A failed activation spends time too — not counting it drops the most expensive spot from the ledger.
  it("records the time spent even when activation fails", async () => {
    const framework = await import("../framework");
    const invoke = vi.spyOn(framework, "invoke").mockResolvedValue(undefined as never);
    await expect(
      activatePlugin(
        {
          activate: () => {
            throw new Error("boom");
          },
        },
        manifestOf(),
        "/d",
        fakeDeps(),
      ),
    ).rejects.toThrow();
    expect(
      invoke.mock.calls.some(
        ([cmd, args]) =>
          cmd === "activity_publish" &&
          (args as { payload?: { step?: string } })?.payload?.step ===
            "plugin-activate:demo",
      ),
    ).toBe(true);
    invoke.mockRestore();
  });
});
