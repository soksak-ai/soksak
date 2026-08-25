// Plugin API contract — permission surface gate (§0-2), management command block (§0-5), rejection of undeclared bindings.
// All deps are fake injections — fixes the surface rules with no real Tauri/registry.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the framework **at the boundary** — not the vendor. Stubbing the vendor global
// (__TAURI_INTERNALS__) runs the real Tauri adapter in that test, and swapping the framework tears
// the test out with it. The contract states this (framework/contract.ts header).
vi.mock("../framework", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    // The stream is a contract surface, so shape alone suffices — this file measures the permission gate.
    createStream: <T,>() => {
      const subs: ((v: T) => void)[] = [];
      return {
        onmessage: (cb: (v: T) => void) => subs.push(cb),
        toJSON: () => ({ __channel__: 0 }),
      };
    },
  };
});
import {
  buildPluginApi,
  isBlockedForPlugins,
  targetPluginId,
  type PluginApiDeps,
} from "./api";
import { parseManifest, type PluginManifest } from "./spec";
import { useViewRegistry } from "./viewRegistry";
import {
  registerPtyIo,
  resetPtyObservationStoreForTest,
} from "../terminal/ptyObservationStore";
import {
  __resetContentViewHostForTest,
  registerContentViewHost,
  type ContentViewHost,
} from "../lib/contentViews";

function manifestOf(overrides: Record<string, unknown>): PluginManifest {
  const { manifest, validation } = parseManifest(
    {
      id: "demo",
      name: "Demo",
      version: "1.0.0",
      appVersionRequirement: "0.0.1",
      description: "Test",
      permissions: [],
      ...overrides,
    },
    "demo",
  );
  if (!manifest) throw new Error(`invalid test manifest: ${validation.errors}`);
  return manifest;
}

function fakeDeps(overrides: Partial<PluginApiDeps> = {}): PluginApiDeps {
  return {
    appVersion: "1.0.0",
    invoke: vi.fn(async () => null),
    execute: vi.fn(async () => ({ ok: true as const, code: "OK", message: "ok" })),
    registerCommand: vi.fn(),
    unregisterCommand: vi.fn(() => true),
    getCommandDanger: () => undefined,
    on: vi.fn(() => ({ dispose: () => {} })),
    currentWorkspace: () => ({ id: "wsp-aaaaaa", root: "/repo" }),
    onFsChange: () => () => {},
    onDataChange: () => () => {},
    onClipboardChange: () => () => {},
    getCwd: () => undefined,
    subscribeCwd: () => () => {},
    subscribeCommandFinished: () => () => {},
    subscribeWebview: () => () => {},
    ...overrides,
  };
}

beforeEach(() => {
  useViewRegistry.setState({ views: {}, version: 0 });
  __resetContentViewHostForTest();
});

describe("webview input surface (webview permission)", () => {
  it("delegates typeText to the registered content view host input path", async () => {
    const typeText = vi.fn(async () => undefined);
    registerContentViewHost({ typeText } as unknown as ContentViewHost);
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["webview"] }),
      "/d",
      fakeDeps(),
    );

    await api.webview?.typeText("browser.win-main.tab-window-view", "typed text");

    expect(typeText).toHaveBeenCalledExactlyOnceWith("browser.win-main.tab-window-view", "typed text");
  });

  it("exposes no input surface without the webview permission", () => {
    const { api } = buildPluginApi(manifestOf({}), "/d", fakeDeps());
    expect(api.webview).toBeUndefined();
  });
});

describe("fs.readBinary (A13 media — fs:read)", () => {
  it("delegates to read_file_base64 under the fs:read permission", async () => {
    const invoke = vi.fn(async () => ({ mime: "image/png", base64: "AAA" }));
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["fs:read"] }),
      "/d",
      fakeDeps({ invoke }),
    );
    const r = await api.fs?.readBinary?.("/x.png");
    expect(r).toEqual({ mime: "image/png", base64: "AAA" });
    expect(invoke).toHaveBeenCalledWith("read_file_base64", { path: "/x.png" });
  });

  it("has no fs surface when fs:read is undeclared", () => {
    const { api } = buildPluginApi(manifestOf({}), "/d", fakeDeps());
    expect(api.fs).toBeUndefined();
  });
});

describe("fs.url (local file to webview load URL — core standard, idempotent)", () => {
  it("reads through read_file_base64 and returns a blob URL — one invoke and the same URL per path", async () => {
    let n = 0;
    const orig = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => `blob:mock-${n++}`) as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
    try {
      const invoke = vi.fn(async () => ({ mime: "video/mp4", base64: "AAAA" }));
      const { api } = buildPluginApi(
        manifestOf({ permissions: ["fs:read"] }),
        "/d",
        fakeDeps({ invoke }),
      );
      const u1 = await api.fs?.url?.("/clip.mp4");
      const u2 = await api.fs?.url?.("/clip.mp4");
      expect(u1).toMatch(/^blob:/);
      expect(u1).toBe(u2); // idempotent — same path, same URL
      expect(invoke).toHaveBeenCalledTimes(1); // cached — no second read
      expect(invoke).toHaveBeenCalledWith("read_file_base64", { path: "/clip.mp4" });
    } finally {
      URL.createObjectURL = orig;
      URL.revokeObjectURL = origRevoke;
    }
  });

  it("has no fs.url when fs:read is undeclared", () => {
    const { api } = buildPluginApi(manifestOf({}), "/d", fakeDeps());
    expect(api.fs?.url).toBeUndefined();
  });
});


describe("terminal cwd surface (A13 raw — terminal permission)", () => {
  it("delegates getCwd/onCwd/onCommandFinished to deps under the terminal permission", () => {
    const getCwd = vi.fn(() => "/cwd");
    const subscribeCwd = vi.fn(() => () => {});
    const subscribeCommandFinished = vi.fn(() => () => {});
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["terminal"] }),
      "/d",
      fakeDeps({ getCwd, subscribeCwd, subscribeCommandFinished }),
    );
    expect(api.terminal?.getCwd?.("tab-aaaaaa")).toBe("/cwd");
    expect(getCwd).toHaveBeenCalledWith("tab-aaaaaa");
    api.terminal?.onCwd?.("tab-aaaaaa", () => {});
    expect(subscribeCwd).toHaveBeenCalled();
    api.terminal?.onCommandFinished?.("tab-aaaaaa", () => {});
    expect(subscribeCommandFinished).toHaveBeenCalled();
  });

  it("has no cwd surface and no terminal object when the terminal permission is undeclared", () => {
    const { api } = buildPluginApi(manifestOf({}), "/d", fakeDeps());
    expect(api.terminal).toBeUndefined();
  });
});

describe("terminal readBuffer/sendText — substrate IO first (GAP2, plugin terminal access)", () => {
  beforeEach(() => resetPtyObservationStoreForTest());

  it("routes readBuffer/sendText to a registered PTY IO handler, independent of the core host-div", () => {
    const sends: string[] = [];
    registerPtyIo("tab-iiiiii", {
      readBuffer: (lines) => `buf:${lines ?? "all"}`,
      sendInput: (data) => sends.push(data),
    });
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["terminal:read", "terminal:write"] }),
      "/d",
      fakeDeps(),
    );
    expect(api.terminal?.readBuffer?.("tab-iiiiii", 3)).toBe("buf:3");
    expect(api.terminal?.sendText?.("tab-iiiiii", "ls\r")).toBe(true);
    expect(sends).toEqual(["ls\r"]);
  });

  it("falls back to the core host-div when no IO is registered, and a missing pane gives false", () => {
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["terminal:write"] }),
      "/d",
      fakeDeps(),
    );
    // No registration IO and no core host (test environment) → false.
    expect(api.terminal?.sendText?.("ghost", "x")).toBe(false);
  });
});

describe("app.terminal.registerIo — the owner's half of a terminal", () => {
  beforeEach(() => resetPtyObservationStoreForTest());

  it("opens the read path through registerIo, and the returned Disposable closes it", () => {
    // It was on app.pty until 2026-08-20, inside a device capability it has nothing to do with:
    // one hands the host a screen, the other hands the decoder a byte stream, and neither is a PTY.
    // They sat there while the core spawned the shell and saw the bytes on the way past; the shell
    // is a unit's now and the core sees nothing it is not given.
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["terminal", "terminal:read"] }),
      "/d",
      fakeDeps(),
    );
    const reg = api.terminal?.registerIo?.("tab-iiiiii", {
      readBuffer: () => "hello",
      sendInput: () => {},
    });
    expect(reg).toBeDefined();
    expect(api.terminal?.readBuffer?.("tab-iiiiii")).toBe("hello");
    reg!.dispose();
    expect(api.terminal?.readBuffer?.("tab-iiiiii")).toBeUndefined();
  });

  it("has no owner's half without the terminal permission", () => {
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["terminal:read"] }),
      "/d",
      fakeDeps(),
    );
    expect(api.terminal?.registerIo).toBeUndefined();
    expect(api.terminal?.observe).toBeUndefined();
  });
});

describe("permission surface gate (§0-2)", () => {
  it("leaves an undeclared permission surface undefined and keeps events/workspace always present", () => {
    const { api } = buildPluginApi(manifestOf({}), "/d", fakeDeps());
    expect(api.commands).toBeUndefined();
    expect(api.ui).toBeUndefined();
    expect(api.storage).toBeUndefined();
    expect(api.fs).toBeUndefined();
    expect(api.events).toBeDefined();
    expect(api.workspace.current()).toEqual({ id: "wsp-aaaaaa", root: "/repo" });
    expect(api.appVersion).toBe("1.0.0");
    expect(api.pluginId).toBe("demo");
  });

  it("gates fs per method by the read and write permissions", () => {
    const ro = buildPluginApi(
      manifestOf({ permissions: ["fs:read"] }),
      "/d",
      fakeDeps(),
    ).api;
    expect(ro.fs?.readText).toBeDefined();
    expect(ro.fs?.writeText).toBeUndefined();
    const wo = buildPluginApi(
      manifestOf({ permissions: ["fs:write"] }),
      "/d",
      fakeDeps(),
    ).api;
    expect(wo.fs?.readText).toBeUndefined();
    expect(wo.fs?.writeText).toBeDefined();
  });
});

describe("commands.execute — danger to permission mapping and management command block (§0-5)", () => {
  const dangers: Record<string, "destructive" | "inject" | undefined> = {
    "view.close": "destructive",
    "term.send": "inject",
    "view.list": undefined,
  };
  const deps = () =>
    fakeDeps({ getCommandDanger: (name) => dangers[name] });

  it('runs a command with no danger under "commands" alone', async () => {
    const d = deps();
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["commands"] }),
      "/d",
      d,
    );
    expect(await api.commands!.execute("view.list")).toEqual({ ok: true, code: "OK", message: "ok" });
    expect(d.execute).toHaveBeenCalledWith("view.list", {}, {});
  });

  it.each([
    ["view.close", "commands:destructive"],
    ["term.send", "commands:inject"],
  ] as const)("rejects danger command %s when %s is undeclared", async (name, need) => {
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["commands"] }),
      "/d",
      deps(),
    );
    const r = await api.commands!.execute(name);
    expect(r).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    expect((r as { message: string }).message).toContain(need);
  });

  it("passes when the danger permission is declared", async () => {
    const d = deps();
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["commands", "commands:destructive"] }),
      "/d",
      d,
    );
    expect(await api.commands!.execute("view.close")).toEqual({ ok: true, code: "OK", message: "ok" });
  });

  it("blocks plugin management commands regardless of permission — no self-propagation", async () => {
    const d = deps();
    const { api } = buildPluginApi(
      manifestOf({
        permissions: ["commands", "commands:destructive", "commands:inject"],
      }),
      "/d",
      d,
    );
    for (const name of [
      "plugin.enable",
      "plugin.install",
      "plugin.install.local",
      "sidecar.install.local",
      "sidecar.request",
      "registry.list",
      "registry.add",
      "registry.remove",
      "registry.refresh",
      "registry.status",
      "registry.future-management-command",
    ]) {
      const r = await api.commands!.execute(name);
      expect(r).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    }
    expect(d.execute).not.toHaveBeenCalled();
    // View open and a plugin's own commands are not management commands.
    expect(isBlockedForPlugins("plugin.view.open")).toBe(false);
    expect(isBlockedForPlugins("plugin.demo.go")).toBe(false);
  });

  it("blocks raw secret and network commands that touch registry credentials from bypassing the namespaced facade", async () => {
    const d = deps();
    const { api } = buildPluginApi(
      manifestOf({
        permissions: ["commands", "commands:destructive", "commands:inject", "network", "secrets"],
      }),
      "/d",
      d,
    );
    for (const name of [
      "secret.status",
      "secret.backend",
      "secret.set",
      "secret.has",
      "secret.keys",
      "secret.remove",
      "net.http.request",
    ]) {
      expect(await api.commands!.execute(name)).toMatchObject({
        ok: false,
        code: "PERMISSION_DENIED",
      });
    }
    expect(d.execute).not.toHaveBeenCalled();
  });
});

describe("commands.register — the manifest danger is authoritative (U4)", () => {
  const capture = () => {
    const registered: { name: string; danger?: string }[] = [];
    const deps = fakeDeps({
      registerCommand: vi.fn((name: string, spec: { danger?: string }) => {
        registered.push({ name, danger: spec.danger });
      }),
    });
    return { deps, registered };
  };

  it("passes the manifest danger through to the registry", () => {
    const { deps, registered } = capture();
    const { api } = buildPluginApi(
      manifestOf({
        permissions: ["commands", "commands:destructive"],
        contributes: {
          views: [],
          commands: [{ name: "wipe", title: "Wipe", danger: "destructive" }],

        },
      }),
      "/d",
      deps,
    );
    api.commands!.register("wipe", {
      description: "",
      message: () => "Wiped",
      handler: async () => ({ ok: true as const }),
    });
    expect(registered[0]).toMatchObject({
      name: "plugin.demo.wipe",
      danger: "destructive",
    });
  });

  it("rejects a runtime danger that differs from the manifest", () => {
    const { deps } = capture();
    const { api } = buildPluginApi(
      manifestOf({
        permissions: ["commands", "commands:destructive", "commands:inject"],
        contributes: {
          views: [],
          commands: [{ name: "x", title: "X", danger: "destructive" }],

        },
      }),
      "/d",
      deps,
    );
    expect(() =>
      api.commands!.register("x", {
        description: "",
        danger: "inject",
        handler: async () => ({ ok: true as const }),
      }),
    ).toThrow(/danger/);
  });

  it("keeps the gate through the runtime danger fallback when the manifest declares none — a warning, not a rejection", () => {
    const { deps, registered } = capture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { api } = buildPluginApi(
      manifestOf({
        permissions: ["commands", "commands:inject"],
        contributes: {
          views: [],
          commands: [{ name: "y", title: "Y" }],

        },
      }),
      "/d",
      deps,
    );
    api.commands!.register("y", {
      description: "",
      danger: "inject",
      handler: async () => ({ ok: true as const }),
    });
    expect(registered[0]).toMatchObject({ name: "plugin.demo.y", danger: "inject" });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("commands.register — undeclared is rejected and the namespace is enforced", () => {
  it("throws on a name missing from contributes.commands", () => {
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["commands"] }),
      "/d",
      fakeDeps(),
    );
    expect(() =>
      api.commands!.register("undeclared", {
        description: "x",
        handler: () => ({}),
      }),
    ).toThrow(/contributes\.commands/);
  });

  it("registers a declared command as plugin.<id>.<name> and unregisters it on dispose", () => {
    const d = fakeDeps();
    const { api } = buildPluginApi(
      manifestOf({
        permissions: ["commands"],
        contributes: { commands: [{ name: "go", title: "Go" }] },
      }),
      "/d",
      d,
    );
    const disp = api.commands!.register("go", {
      description: "x",
      message: () => "Done",
      handler: () => ({ done: true }),
    });
    expect(d.registerCommand).toHaveBeenCalledWith(
      "plugin.demo.go",
      expect.objectContaining({ description: "x" }),
    );
    disp.dispose();
    expect(d.unregisterCommand).toHaveBeenCalledWith("plugin.demo.go");
  });

  it("collects registrations left undisposed through tracker.disposeAll (§0-4, no leak)", () => {
    const d = fakeDeps();
    const { api, tracker } = buildPluginApi(
      manifestOf({
        permissions: ["commands"],
        contributes: { commands: [{ name: "go", title: "Go" }] },
      }),
      "/d",
      d,
    );
    api.commands!.register("go", { description: "x", message: () => "Done", handler: () => ({}) });
    tracker.disposeAll();
    expect(d.unregisterCommand).toHaveBeenCalledWith("plugin.demo.go");
  });
});

describe("ui — an undeclared view is rejected and the registry is updated", () => {
  const uiManifest = () =>
    manifestOf({
      permissions: ["ui"],
      contributes: { views: [{ id: "panel", title: "Panel", icon: "P" }] },
    });

  it("throws on an undeclared viewId", () => {
    const { api } = buildPluginApi(uiManifest(), "/d", fakeDeps());
    expect(() => api.ui!.registerView("ghost", { mount: () => {} })).toThrow(
      /contributes\.views.*ghost/,
    );
  });

  it("registers into viewRegistry and disposeAll takes it back", () => {
    const { api, tracker } = buildPluginApi(uiManifest(), "/d", fakeDeps());
    api.ui!.registerView("panel", { mount: () => {} });
    expect(useViewRegistry.getState().views["demo.panel"]).toBeDefined();
    tracker.disposeAll();
    expect(useViewRegistry.getState().views["demo.panel"]).toBeUndefined();
  });

  it("delegates openView to plugin.view.open with the global key and nothing else", async () => {
    // It names no place. `plugin.view.open` opens a tab and refuses a view that does not live on
    // one; where a sidebar stands is what a person arranges, and a plugin asking for a place would
    // be arranging the window from inside itself.
    const d = fakeDeps();
    const { api } = buildPluginApi(uiManifest(), "/d", d);
    await api.ui!.openView("panel");
    expect(d.execute).toHaveBeenCalledWith("plugin.view.open", { viewKey: "demo.panel" }, {});
  });
});

describe("storage — JSON round trip and delegation to the dedicated commands", () => {
  it("serializes on write through plugin_data_write and deserializes on read", async () => {
    const calls: Record<string, unknown>[] = [];
    const d = fakeDeps({
      invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, ...args });
        if (cmd === "plugin_data_read") return '{"count":3}';
        return null;
      }),
    });
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["storage"] }),
      "/d",
      d,
    );
    await api.storage!.write("notes", { count: 3 });
    expect(calls[0]).toEqual({
      cmd: "plugin_data_write",
      id: "demo",
      key: "notes",
      value: '{"count":3}',
    });
    expect(await api.storage!.read("notes")).toEqual({ count: 3 });
  });

  it("gives null for a missing key", async () => {
    const d = fakeDeps({ invoke: vi.fn(async () => null) });
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["storage"] }),
      "/d",
      d,
    );
    expect(await api.storage!.read("missing")).toBeNull();
  });
});

describe("data — permission gate, forced ns injection, and cross-window watch filter", () => {
  it('leaves the surface undefined when "data" is undeclared', () => {
    const { api } = buildPluginApi(manifestOf({}), "/d", fakeDeps());
    expect(api.data).toBeUndefined();
  });

  it("injects ns=manifest.id into every call, so no other ns can be given", async () => {
    const calls: Record<string, unknown>[] = [];
    const d = fakeDeps({
      invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, ...args });
        if (cmd === "data_put") return "rec1";
        return null;
      }),
    });
    const { api } = buildPluginApi(manifestOf({ permissions: ["data"] }), "/d", d);
    const id = await api.data!.put("messages", { title: "hello" }, { scope: "projA" });
    expect(id).toBe("rec1");
    expect(calls[0]).toEqual({
      cmd: "data_put",
      ns: "demo",
      coll: "messages",
      scope: "projA",
      id: null,
      doc: { title: "hello" },
    });
  });

  it("calls back only on a ns, coll, and scope match and ignores the rest", () => {
    let emit: ((e: unknown) => void) | null = null;
    const d = fakeDeps({
      onDataChange: (cb) => {
        emit = cb as (e: unknown) => void;
        return () => {};
      },
    });
    const { api } = buildPluginApi(manifestOf({ permissions: ["data"] }), "/d", d);
    const seen: string[] = [];
    api.data!.watch("messages", { scope: "projA" }, (e) => seen.push(e.id ?? ""));

    const ev = (o: Record<string, unknown>) => ({ ns: "demo", coll: "messages", scope: "projA", op: "put", id: "x", ...o });
    emit!(ev({})); // match
    emit!(ev({ ns: "other" })); // other ns
    emit!(ev({ coll: "logs" })); // other coll
    emit!(ev({ scope: "projB" })); // other scope
    emit!(ev({ id: "y" })); // match, different id
    expect(seen).toEqual(["x", "y"]);
  });
});

describe("secrets — permission gate, forced ns injection, and no get", () => {
  it('leaves the surface undefined when "secrets" is undeclared', () => {
    const { api } = buildPluginApi(manifestOf({}), "/d", fakeDeps());
    expect(api.secrets).toBeUndefined();
  });

  it("exposes set/has/delete/keys/backend and no get, blocking plaintext read-back", () => {
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["secrets"] }),
      "/d",
      fakeDeps(),
    );
    expect(typeof api.secrets?.set).toBe("function");
    expect(typeof api.secrets?.has).toBe("function");
    expect(typeof api.secrets?.delete).toBe("function");
    expect(typeof api.secrets?.keys).toBe("function");
    expect(typeof api.secrets?.backend).toBe("function");
    // get must not exist (injection only — the plaintext read-back path is blocked).
    expect((api.secrets as Record<string, unknown>).get).toBeUndefined();
  });

  it("injects ns=manifest.id on set, so no other ns can be given", async () => {
    const calls: Record<string, unknown>[] = [];
    const d = fakeDeps({
      invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, ...args });
        return null;
      }),
    });
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["secrets"] }),
      "/d",
      d,
    );
    await api.secrets!.set("apiKey", "sk-123");
    expect(calls[0]).toEqual({
      cmd: "secret_set",
      ns: "demo",
      key: "apiKey",
      value: "sk-123",
    });
  });
});

describe("network — permission gate and forced ns injection", () => {
  it("fixes ns to manifest.id on app.network.http, so the caller cannot choose it", async () => {
    const invoke = vi.fn(async () => ({ status: 200, headers: {}, body: "ok" }));
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["network"] }),
      "/d",
      fakeDeps({ invoke }),
    );

    await api.network!.http({
      method: "GET",
      url: "https://api.example.test/data",
      headers: { authorization: "\u0000token\u0000" },
      secretSubst: { "\u0000token\u0000": "api-token" },
    });

    expect(invoke).toHaveBeenCalledWith("net_http_request", expect.objectContaining({
      ns: "demo",
      secretSubst: { "\u0000token\u0000": "api-token" },
    }));
  });
});

describe("notify/sound — permission gate", () => {
  it('leaves both surfaces undefined when "notify" is undeclared and exposes push/sound when declared', () => {
    const off = buildPluginApi(manifestOf({}), "/d", fakeDeps());
    expect(off.api.notify).toBeUndefined();
    expect(off.api.sound).toBeUndefined();
    const on = buildPluginApi(manifestOf({ permissions: ["notify"] }), "/d", fakeDeps());
    expect(typeof on.api.notify?.push).toBe("function");
    expect(on.api.sound?.builtins()).toContain("chime");
  });
});

describe("clipboard — per read/write gate and watch across every window", () => {
  it("leaves the surface undefined when undeclared", () => {
    const { api } = buildPluginApi(manifestOf({}), "/d", fakeDeps());
    expect(api.clipboard).toBeUndefined();
  });

  it("gates methods by the read and write permissions, with watch under read", () => {
    const ro = buildPluginApi(
      manifestOf({ permissions: ["clipboard:read"] }),
      "/d",
      fakeDeps(),
    ).api;
    expect(ro.clipboard?.readText).toBeDefined();
    expect(ro.clipboard?.watch).toBeDefined();
    expect(ro.clipboard?.writeText).toBeUndefined();

    const wo = buildPluginApi(
      manifestOf({ permissions: ["clipboard:write"] }),
      "/d",
      fakeDeps(),
    ).api;
    expect(wo.clipboard?.writeText).toBeDefined();
    expect(wo.clipboard?.readText).toBeUndefined();
    expect(wo.clipboard?.watch).toBeUndefined();
  });

  it("readText→clipboard_read, writeText→clipboard_write", async () => {
    const d = fakeDeps({
      invoke: vi.fn(async (cmd: string) =>
        cmd === "clipboard_read" ? "copied text" : null,
      ),
    });
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["clipboard:read", "clipboard:write"] }),
      "/d",
      d,
    );
    expect(await api.clipboard!.readText!()).toBe("copied text");
    await api.clipboard!.writeText!("new value");
    expect(d.invoke).toHaveBeenCalledWith("clipboard_write", { text: "new value" });
  });

  it("subscribes through clipboard_watch_start and onClipboardChange, and stops on dispose", () => {
    const order: string[] = [];
    let emit: ((text: string) => void) | null = null;
    const d = fakeDeps({
      invoke: vi.fn(async (cmd: string) => {
        order.push(cmd);
        return null;
      }),
      onClipboardChange: (cb) => {
        emit = cb as (text: string) => void;
        return () => order.push("unsubscribe");
      },
    });
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["clipboard:read"] }),
      "/d",
      d,
    );
    const seen: string[] = [];
    const sub = api.clipboard!.watch!((e) => seen.push(e.text));
    emit!("changed text");
    expect(seen).toEqual(["changed text"]);
    sub.dispose();
    expect(order).toContain("clipboard_watch_start");
    expect(order).toContain("clipboard_watch_stop");
  });
});

describe("app.scheduler — general scheduler surface (schedule permission)", () => {
  it('leaves the scheduler surface undefined when "schedule" is undeclared', () => {
    const { api } = buildPluginApi(manifestOf({}), "/d", fakeDeps());
    expect(api.scheduler).toBeUndefined();
  });

  it("forwards the trigger and command to schedule_register as wire, with no mapping", async () => {
    const d = fakeDeps({ invoke: vi.fn(async () => "sch-7") });
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["schedule"] }),
      "/d",
      d,
    );
    const id = await api.scheduler!.register({
      trigger: { kind: "every", every_ms: 1000 },
      command: "notify.show",
      params: { title: "tick" },
      retry: { max: 3, base_ms: 1000, max_ms: 60_000 },
      timeout_ms: 600_000,
    });
    expect(id).toBe("sch-7");
    expect(d.invoke).toHaveBeenCalledWith("schedule_register", {
      trigger: { kind: "every", every_ms: 1000 },
      command: "notify.show",
      params: { title: "tick" },
      id: null,
      retry: { max: 3, base_ms: 1000, max_ms: 60_000 },
      concurrency: null,
      timeout_ms: 600_000,
      process_lease: null,
      zombie_backstop_ms: null,
      owner: "demo", // B2 owner stamp — the core splits persistence and lifetime on this
    });
  });

  it("binds a scheduled job to the owner lifetime and cancels it on deactivate (B1, same shape as command registration)", async () => {
    const d = fakeDeps({ invoke: vi.fn(async () => "sch-life") });
    const { api, tracker } = buildPluginApi(
      manifestOf({ permissions: ["schedule"] }),
      "/d",
      d,
    );
    await api.scheduler!.register({ trigger: { kind: "reconcile" }, command: "workflow.reconcile" });
    tracker.disposeAll(); // plugin deactivation
    await Promise.resolve(); // cancel once the job id resolves
    await Promise.resolve();
    expect(d.invoke).toHaveBeenCalledWith("schedule_cancel", { id: "sch-life" });
  });

  it("process_lease register — injects the 3h default when no backstop is given", async () => {
    const d = fakeDeps({ invoke: vi.fn(async () => "sch-2") });
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["schedule"] }),
      "/d",
      d,
    );
    await api.scheduler!.register({
      trigger: { kind: "reconcile" },
      command: "workflow.exec-one",
      process_lease: true,
    });
    expect(d.invoke).toHaveBeenCalledWith(
      "schedule_register",
      expect.objectContaining({
        process_lease: true,
        zombie_backstop_ms: 10_800_000, // 3h default.
      }),
    );
  });

  it("process_lease with zombie_backstop_ms null means unbounded (core None)", async () => {
    const d = fakeDeps({ invoke: vi.fn(async () => "sch-3") });
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["schedule"] }),
      "/d",
      d,
    );
    await api.scheduler!.register({
      trigger: { kind: "reconcile" },
      command: "workflow.exec-one",
      process_lease: true,
      zombie_backstop_ms: null,
    });
    expect(d.invoke).toHaveBeenCalledWith(
      "schedule_register",
      expect.objectContaining({ process_lease: true, zombie_backstop_ms: null }),
    );
  });

  it("registers reconcile and requests a state tick through poke with no id", async () => {
    const d = fakeDeps({ invoke: vi.fn(async () => "sch-1") });
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["schedule"] }),
      "/d",
      d,
    );
    await api.scheduler!.register({
      trigger: { kind: "reconcile" },
      command: "workflow.reconcile",
    });
    await api.scheduler!.poke();
    expect(d.invoke).toHaveBeenLastCalledWith("schedule_poke", { id: null });
  });

  it("cancel/list forward", async () => {
    const d = fakeDeps({ invoke: vi.fn(async () => true) });
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["schedule"] }),
      "/d",
      d,
    );
    await api.scheduler!.cancel("sch-3");
    expect(d.invoke).toHaveBeenCalledWith("schedule_cancel", { id: "sch-3" });
    await api.scheduler!.list();
    expect(d.invoke).toHaveBeenLastCalledWith("schedule_list");
  });
});

describe("cross-plugin dependency gate (executeGated and scheduler.register)", () => {
  it("targetPluginId — extracts only plugin.<id>.<cmd> and gives null for core, view, dev, and management", () => {
    expect(targetPluginId("plugin.foo-bar.baz")).toBe("foo-bar");
    expect(targetPluginId("plugin.foo-bar.baz.qux")).toBe("foo-bar"); // multi-segment cmd.
    expect(targetPluginId("notify.show")).toBeNull(); // core, no plugin. prefix.
    expect(targetPluginId("plugin.view.open")).toBeNull(); // view ops.
    expect(targetPluginId("plugin.install.local")).toBeNull(); // management.
    expect(targetPluginId("plugin.list")).toBeNull(); // management, 2 segments.
  });

  it("denies an undeclared cross-plugin call and blocks execution", async () => {
    const d = fakeDeps();
    const { api } = buildPluginApi(manifestOf({ permissions: ["commands"] }), "/d", d);
    const out = await api.commands!.execute("plugin.other-plugin.foo");
    expect(out).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    expect(d.execute).not.toHaveBeenCalled();
  });

  it("passes a declared cross-plugin call", async () => {
    const d = fakeDeps();
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["commands"], runtimeDependencies: { plugins: [{ id: "other-plugin", version: "0.0.1", url: "https://github.com/example/other-plugin/releases/download/v0.0.1/release.json", size: 1, sha256: "a".repeat(64) }] } }),
      "/d",
      d,
    );
    const out = await api.commands!.execute("plugin.other-plugin.foo");
    expect(out).toEqual({ ok: true, code: "OK", message: "ok" });
    expect(d.execute).toHaveBeenCalledWith("plugin.other-plugin.foo", {}, {});
  });

  it("passes a compatible contract call without a plugin id dependency", async () => {
    const d = fakeDeps({
      implementsOf: (id) =>
        id === "other-plugin" ? [{ id: "soksak-spec-plugin-terminal-session", version: "0.0.1" }] : [],
    });
    const { api } = buildPluginApi(
      manifestOf({
        permissions: ["commands"],
        consumes: [{ id: "soksak-spec-plugin-terminal-session", requirement: "0.0.1" }],
      }),
      "/d",
      d,
    );
    const out = await api.commands!.execute("plugin.other-plugin.foo");
    expect(out).toEqual({ ok: true, code: "OK", message: "ok" });
    expect(d.execute).toHaveBeenCalledWith("plugin.other-plugin.foo", {}, {});
  });

  it("rejects an incompatible contract provider", async () => {
    const d = fakeDeps({
      implementsOf: () => [{ id: "soksak-spec-plugin-terminal-session", version: "1.0.0" }],
    });
    const { api } = buildPluginApi(
      manifestOf({
        permissions: ["commands"],
        consumes: [{ id: "soksak-spec-plugin-terminal-session", requirement: "0.0.1" }],
      }),
      "/d",
      d,
    );
    const out = await api.commands!.execute("plugin.other-plugin.foo");
    expect(out).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    expect(d.execute).not.toHaveBeenCalled();
  });

  it("rejects a call to a plugin that is not a declared dependency", async () => {
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["commands"] }),
      "/d",
      fakeDeps(),
    );
    const out = await api.commands!.execute("plugin.other-plugin.foo");
    expect(out.ok).toBe(false);
    expect(out.code).toBe("PERMISSION_DENIED");
  });

  it("allows own commands, core commands, and plugin.view regardless of dependencies", async () => {
    const d = fakeDeps();
    const { api } = buildPluginApi(manifestOf({ permissions: ["commands"] }), "/d", d);
    expect((await api.commands!.execute("plugin.demo.foo")).ok).toBe(true); // self(id=demo).
    expect((await api.commands!.execute("notify.show")).ok).toBe(true); // core.
    expect((await api.commands!.execute("plugin.view.open")).ok).toBe(true); // view ops.
    expect(d.execute).toHaveBeenCalledTimes(3);
  });

  it("scheduler.register — rejects scheduling an undeclared cross-plugin command, blocking the remote trigger bypass", async () => {
    const inv = vi.fn(async () => "sch-1");
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["schedule"] }),
      "/d",
      fakeDeps({ invoke: inv }),
    );
    await expect(
      api.scheduler!.register({
        trigger: { kind: "reconcile" },
        command: "plugin.other-plugin.exec",
      }),
    ).rejects.toThrow(/other-plugin/);
    expect(inv).not.toHaveBeenCalled(); // the registration itself is blocked.
  });

  it.each([
    "registry.list",
    "registry.add",
    "registry.remove",
    "registry.refresh",
    "registry.status",
  ])("scheduler.register — a plugin cannot schedule the %s management call", async (command) => {
    const inv = vi.fn(async () => "sch-registry");
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["schedule"] }),
      "/d",
      fakeDeps({ invoke: inv }),
    );

    await expect(
      api.scheduler!.register({ trigger: { kind: "reconcile" }, command }),
    ).rejects.toThrow(/§0-5/);
    expect(inv).not.toHaveBeenCalled();
  });

  it("scheduler.register — passes declared cross-plugin and core commands", async () => {
    const inv = vi.fn(async () => "sch-1");
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["schedule"], runtimeDependencies: { plugins: [{ id: "other-plugin", version: "0.0.1", url: "https://github.com/example/other-plugin/releases/download/v0.0.1/release.json", size: 1, sha256: "a".repeat(64) }] } }),
      "/d",
      fakeDeps({ invoke: inv }),
    );
    await api.scheduler!.register({
      trigger: { kind: "reconcile" },
      command: "plugin.other-plugin.exec",
    });
    await api.scheduler!.register({ trigger: { kind: "reconcile" }, command: "notify.show" });
    expect(inv).toHaveBeenCalledTimes(2);
  });
});
describe("app.sidecar — permission gate and declaration equals reality", () => {
  beforeEach(() => {
  });
  it("has no API without the sidecar permission", () => {
    const { api } = buildPluginApi(manifestOf({}), "/d", fakeDeps());
    expect(api.sidecar).toBeUndefined();
  });
  it("opens only a declared sidecar and rejects an undeclared name", async () => {
    const m = manifestOf({
      permissions: ["sidecar"],
      runtimeDependencies: { sidecars: [{ id: "soksak-sidecar-chromium", version: "0.0.1", url: "https://github.com/example/soksak-sidecar-chromium/releases/download/v0.0.1/release.json", size: 1, sha256: "a".repeat(64) }] },
    });
    const { api } = buildPluginApi(m, "/d", fakeDeps());
    await expect(api.sidecar!.open("undeclared")).rejects.toThrow(/undeclared/);
  });
  it("delegates open of a declared name to the sidecar_open invoke with the consumer requirement", async () => {
    const invoke = vi.fn<PluginApiDeps["invoke"]>(async (command) =>
      command === "sidecar_open" ? { name: "soksak-sidecar-chromium" } : { ok: true });
    const m = manifestOf({
      permissions: ["sidecar"],
      runtimeDependencies: { sidecars: [{ id: "soksak-sidecar-chromium", version: "0.0.1", url: "https://github.com/example/soksak-sidecar-chromium/releases/download/v0.0.1/release.json", size: 1, sha256: "a".repeat(64) }] },
    });
    const { api } = buildPluginApi(m, "/d", fakeDeps({ invoke }));
    const h = await api.sidecar!.open("soksak-sidecar-chromium");
    expect(invoke).toHaveBeenCalledWith(
      "sidecar_open",
      expect.objectContaining({
        consumer: { id: m.id, version: m.version },
        sidecar: { id: "soksak-sidecar-chromium", version: "0.0.1", url: "https://github.com/example/soksak-sidecar-chromium/releases/download/v0.0.1/release.json", size: 1, sha256: "a".repeat(64) },
      }),
    );
    const openArgs = invoke.mock.calls.find((call) => call[0] === "sidecar_open")?.[1];
    expect(openArgs).not.toHaveProperty("interface");
    await h.send({ type: "ping" });
    expect(invoke).toHaveBeenCalledWith(
      "sidecar_send",
      expect.objectContaining({ name: "soksak-sidecar-chromium", payload: '{"type":"ping"}' }),
    );
    const sendArgs = invoke.mock.calls.find((call) => call[0] === "sidecar_send")?.[1];
    expect(sendArgs).not.toHaveProperty("handle");
    // Closing a channel releases it and never ends the unit.
    //
    // A unit is a separate process so that what it holds outlives this application. A plugin being
    // disabled, or a channel being let go, is this application finishing with the unit rather than
    // the unit's work being over — and closing one on deactivation ended the shells somebody was
    // working in (measured 2026-08-20). Ending a unit is `sidecar_stop`, which nothing on this path
    // calls.
    await h.close();
    await h.close();
    const calls = (invoke as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.filter((c) => c[0] === "sidecar_release").length).toBe(1);
    expect(calls.filter((c) => c[0] === "sidecar_stop").length).toBe(0);
  });

  it("settles a stream close only after Core closes the exact connection", async () => {
    let finishClose!: () => void;
    const closing = new Promise<void>((resolve) => { finishClose = resolve; });
    const invoke = vi.fn<PluginApiDeps["invoke"]>(async (command) => {
      if (command === "sidecar_open") return { name: "soksak-sidecar-chromium" };
      if (command === "sidecar_stream_close") await closing;
      return {};
    });
    const manifest = manifestOf({
      permissions: ["sidecar"],
      runtimeDependencies: { sidecars: [{ id: "soksak-sidecar-chromium", version: "0.0.1", url: "https://github.com/example/soksak-sidecar-chromium/releases/download/v0.0.1/release.json", size: 1, sha256: "a".repeat(64) }] },
    });
    const { api } = buildPluginApi(manifest, "/d", fakeDeps({ invoke }));
    const channel = await api.sidecar!.open("soksak-sidecar-chromium");
    const stream = await channel.stream({}, { onBytes() {} });
    let settled = false;
    void stream.close.settled.then(() => { settled = true; });
    stream.close.dispose();
    await Promise.resolve();
    expect(settled).toBe(false);
    finishClose();
    await stream.close.settled;
    expect(settled).toBe(true);
  });
});

// The window realm declares its own identity too. With only one side declaring, a plugin has to
// probe again for whether a realm exists at all, and that probing is what killed offscreen in the
// first place.
describe("realm declaration (window realm)", () => {
  it("declares the window realm identity and its actual capabilities", () => {
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["commands"] }),
      "/d",
      fakeDeps(),
    );

    expect(api.realm.id).toBe("window");
    expect(api.realm.supports("commands.register")).toBe(true);
    expect(api.realm.supports("commands.execute")).toBe(true);
  });

  it("reports a surface as absent when the permission is missing — the declaration derives from the object", () => {
    const { api } = buildPluginApi(manifestOf({}), "/d", fakeDeps());

    expect(api.commands).toBeUndefined();
    expect(api.realm.supports("commands.register")).toBe(false);
    expect(api.realm.supports("commands.execute")).toBe(false);
    // A surface always present regardless of permission still reports as present.
    expect(api.realm.supports("events.on")).toBe(true);
  });
});
