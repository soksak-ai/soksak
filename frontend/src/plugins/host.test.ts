// The standard for plugin host initialization.
//
// What is measured here: whether reclaim completes from the name and the arguments alone.
// Expecting the framework to inject the window confines that command to a process that has a
// window, and then reclaiming the children left by a previous runtime must be reimplemented per
// framework.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: [string, unknown][] = [];
const order: string[] = [];
const reload = vi.fn(async () => {});
const listeners = new Map<string, (event: { payload: unknown }) => void>();

vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: (cmd: string, args?: unknown) => {
    calls.push([cmd, args]);
    if (cmd === "app_is_release") return Promise.resolve(false);
    if (cmd === "composition_settings") {
      order.push("settings");
      return Promise.resolve({ generation: 3 });
    }
    return Promise.resolve(undefined);
  },
  appInfo: { version: () => Promise.resolve("0.0.1") },
}));
vi.mock("./hooks", () => ({ startPluginHooks: () => {} }));
vi.mock("./registryInstallRuntimeNative", () => ({ wireNativeRegistryInstall: () => {} }));
vi.mock("../state/plugins", () => ({
  usePlugins: { setState: () => {}, getState: () => ({ reload }) },
}));
vi.mock("../state/registry", () => ({
  useRegistry: { setState: () => {}, getState: () => ({ refresh: async () => {} }) },
}));
vi.mock("../lib/webviewLabels", () => ({ currentWindowLabel: () => "win-test" }));
vi.mock("../lib/safeListen", () => ({
  safeListenReady: async (event: string, listener: (event: { payload: unknown }) => void) => {
    order.push("listen");
    listeners.set(event, listener);
    return () => { listeners.delete(event); };
  },
}));

describe("reclaiming the previous runtime's children", () => {
  beforeEach(() => {
    calls.length = 0;
    order.length = 0;
    reload.mockClear();
    listeners.clear();
    vi.resetModules();
  });

  /**
   * Pass the label as an argument.
   *
   * Calling with no argument requires the framework to inject the window, and then a process
   * without a window cannot serve that name — making the same name take a label instead returns
   * INVALID_PARAMS to an old caller that passed no argument, and that failure looks like "the
   * command is broken", not "reclaim does not run".
   * So call the name that takes a label (process_reclaim_by_window) — the capability is already
   * there.
   *
   * Measured (2026-07-30): process_reclaim_window was rejected 39 times on the second framework.
   */
  it("calls the name that takes a label", async () => {
    const { initPluginHost } = await import("./host");
    await initPluginHost();
    const reclaim = calls.filter(([c]) => c.startsWith("process_reclaim"));
    expect(reclaim).toHaveLength(1);
    expect(reclaim[0][0]).toBe("process_reclaim_by_window");
    expect(reclaim[0][1]).toEqual({ window: "win-test" });
  });

  /** Without the window label, reclaim no window's children — an empty label reclaims another window's. */
  it("does not call when the label is unknown", async () => {
    vi.doMock("../lib/webviewLabels", () => ({ currentWindowLabel: () => "" }));
    const { initPluginHost } = await import("./host");
    await initPluginHost();
    expect(calls.filter(([c]) => c.startsWith("process_reclaim"))).toEqual([]);
  });

  it("reloads plugins after a newer installation settings generation", async () => {
    const { initPluginHost } = await import("./host");
    await initPluginHost();
    expect(order.slice(0, 2)).toEqual(["listen", "settings"]);
    expect(reload).toHaveBeenCalledTimes(1);
    listeners.get("composition.changed")?.({
      payload: { previousGeneration: 3, generation: 4 },
    });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
  });
});
