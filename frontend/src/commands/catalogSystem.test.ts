// system.hello contract test — registration (discoverability) and execution delegated to the
// ipc_hello_info core command (single source). invoke is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: (...a: unknown[]) => invoke(...a),
  framework: { name: "test-adapter" },
  engineProvision: {
    chromium: true,
    nativeChildWebview: false,
    engineModules: false,
    supportsDocumentStart: false,
    supportsInputInjection: true,
  },
}));

import { registerSystemCatalog } from "./catalogSystem";
import { execute, getSpec, unregister, type CommandContext } from "./registry";

beforeEach(() => {
  invoke.mockReset();
  registerSystemCatalog();
});
afterEach(() => {
  vi.useRealTimers();
  unregister("system.hello");
  unregister("app.shutdown.commit");
  unregister("app.environment");
  unregister("framework.provision");
});

describe("app.shutdown.commit — the native quit runs after the reply", () => {
  it("a successful response does not quit; it registers the quit for after the reply", async () => {
    invoke.mockResolvedValueOnce({
      phase: "reaped",
      reaped: true,
      processChildrenReaped: 2,
      localPtysReaped: 1,
      daemonPtysTransferred: 3,
      daemonsReaped: 1,
      servicesReaped: 2,
      nativeWindowsDrained: 1,
      nativeSurfacesDrained: 4,
      nativePaneHostsDrained: 2,
      nativeInputMonitorsDrained: 1,
      nativeRemaining: 0,
    });
    const afterReply = vi.fn();

    const result = await execute("app.shutdown.commit", {}, {
      afterReply,
    } as unknown as CommandContext);
    expect(result).toMatchObject({ ok: true });
    expect(result.data).toMatchObject({
      shutdown: { phase: "reaped", processChildrenReaped: 2, daemonPtysTransferred: 3 },
    });
    expect(invoke).toHaveBeenCalledWith("app_shutdown_prepare");
    expect(afterReply).toHaveBeenCalledTimes(1);

    const quit = afterReply.mock.calls[0][0] as () => Promise<void>;
    await quit();
    expect(invoke).toHaveBeenLastCalledWith("app_shutdown_commit");
  });

  it("a remaining native compositor inventory registers no commit", async () => {
    invoke.mockResolvedValueOnce({
      phase: "reaped",
      reaped: true,
      processChildrenReaped: 0,
      localPtysReaped: 0,
      daemonPtysTransferred: 0,
      daemonsReaped: 0,
      servicesReaped: 0,
      nativeWindowsDrained: 1,
      nativeSurfacesDrained: 2,
      nativePaneHostsDrained: 1,
      nativeInputMonitorsDrained: 1,
      nativeRemaining: 1,
    });
    const afterReply = vi.fn();
    const result = await execute("app.shutdown.commit", {}, {
      afterReply,
    } as unknown as CommandContext);
    expect(result).toMatchObject({ ok: false });
    expect(afterReply).not.toHaveBeenCalled();
  });

  it("a missing or false reap count registers no commit", async () => {
    invoke.mockResolvedValueOnce({ phase: "reaped", reaped: true });
    const afterReply = vi.fn();
    const result = await execute("app.shutdown.commit", {}, {
      afterReply,
    } as unknown as CommandContext);
    expect(result).toMatchObject({ ok: false });
    expect(afterReply).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe("app.environment — core identity and unit source mode are separate fields", () => {
  it("is one status command across the three CLIs and delegates to the single core source", async () => {
    invoke.mockResolvedValueOnce({
      coreBuild: "release",
      identity: "com.soksak.app",
      cli: "sok",
      home: "/Users/test/.soksak",
      loginShell: "/bin/zsh",
      buildProfile: "release",
      updaterEnabled: true,
      unitMode: "mixed",
      developmentUnits: [{ kind: "plugin", id: "weather", source: "/work/weather" }],
    }).mockResolvedValueOnce({ mode: "capture-only", desktopVisible: false });

    const spec = getSpec("app.environment");
    expect(spec).toBeDefined();
    // Examples contain the command form only — the binary name is the identity of the presenter (CLI), not data.
    expect(spec!.examples).toEqual(["app.environment"]);
    const r = await execute("app.environment", {}, {});
    expect(invoke).toHaveBeenNthCalledWith(1, "app_environment");
    expect(invoke).toHaveBeenNthCalledWith(2, "app_presentation");
    expect(r).toMatchObject({
      ok: true, data: {
        coreBuild: "release", cli: "sok", loginShell: "/bin/zsh", unitMode: "mixed",
        presentation: { mode: "capture-only", desktopVisible: false },
      },
    });
  });
});

describe("system.hello registration (discoverability)", () => {
  it("declares no params, declares returns and examples, and omits VERSION_SKEW from errors", () => {
    const spec = getSpec("system.hello");
    expect(spec).toBeDefined();
    expect(Object.keys(spec!.params)).toHaveLength(0);
    expect(spec!.returns).toContain("protocol");
    expect(spec!.examples).toContain("hello");
    // This command never emits skew (skew is the transport gate's envelope) — it must not appear in errors.
    expect(spec!.errors ?? []).not.toContain("VERSION_SKEW");
  });
});

describe("system.hello execution (delegated to the single source)", () => {
  it("calls the ipc_hello_info core command and returns its payload unchanged", async () => {
    invoke.mockResolvedValueOnce({
      protocol: 1,
      minClientProtocol: 0,
      appVersion: "9.9.9",
      identity: "com.soksak.test",
      pid: 4242,
      startedAt: 1_700_000_000_000,
      capabilities: ["hello.v1"],
    });
    const r = await execute("system.hello", {}, {});
    expect(invoke).toHaveBeenCalledWith("ipc_hello_info");
    expect(r).toMatchObject({
      ok: true,
      data: { protocol: 1, minClientProtocol: 0, capabilities: ["hello.v1"] },
    });
  });
});

describe("framework.provision public capability", () => {
  it("reports product behavior as explicit fields rather than as an adapter name", async () => {
    const r = await execute("framework.provision", {}, {});
    expect(r).toMatchObject({
      ok: true,
      data: {
        name: "test-adapter",
        engineModules: false,
        supportsDocumentStart: false,
        supportsInputInjection: true,
      },
    });
  });
});
