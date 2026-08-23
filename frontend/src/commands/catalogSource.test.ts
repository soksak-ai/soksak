import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { registerSourceCatalog } from "./catalogSource";
import { execute, getSpec, unregister } from "./registry";

const COMMANDS = [
  "plugin.source.list", "plugin.source.set",
  "sidecar.source.list", "sidecar.source.set",
  "kit.source.list", "kit.source.set",
  "contract.source.list", "contract.source.set",
  "spec.source.list", "spec.source.set",
] as const;

beforeEach(() => {
  invoke.mockReset();
  registerSourceCatalog();
});

afterEach(() => {
  for (const name of COMMANDS) unregister(name);
});

describe("kind-specific.source.commands", () => {
  it("does not expose a generic kind parameter", () => {
    for (const name of COMMANDS) {
      expect(getSpec(name)).toBeDefined();
      expect(getSpec(name)?.params).not.toHaveProperty("kind");
    }
    expect(getSpec("unit.dev.set")).toBeUndefined();
  });

  it("lists only the requested component type from the environment", async () => {
    invoke.mockResolvedValueOnce({
      revision: 4,
      plugins: { p: { version: "0.0.1", path: "/work/p", source: "development", enabled: true } },
      sidecars: { s: { version: "0.0.1", path: "/work/s", source: "development", target: "aarch64-apple-darwin" } },
      kits: { k: { version: "0.0.1", path: "/work/k", source: "development" } }, contracts: {}, specs: {},
    });
    const result = await execute("sidecar.source.list", {}, {});
    expect(result).toMatchObject({
      ok: true,
      data: { revision: 4, sidecars: { s: { version: "0.0.1", path: "/work/s", source: "development", target: "aarch64-apple-darwin" } } },
    });
  });

  it("sets one plugin through the typed backend command and current revision", async () => {
    invoke.mockResolvedValueOnce({ revision: 7, plugins: {}, sidecars: {}, kits: {}, contracts: {}, specs: {} });
    invoke.mockResolvedValueOnce({ revision: 8 });
    const result = await execute(
      "plugin.source.set",
      { id: "weather", version: "0.0.1", source: "development", path: "/work/weather" },
      {},
    );
    expect(invoke).toHaveBeenNthCalledWith(2, "plugin_source_set", {
      id: "weather", version: "0.0.1", source: "development", path: "/work/weather",
      registry: undefined, target: undefined,
      expectedRevision: 7,
    });
    expect(result).toMatchObject({ ok: true, data: { kind: "plugin", id: "weather", revision: 8 } });
  });

  it("does not guess revision zero when the environment cannot be read", async () => {
    invoke.mockRejectedValueOnce(new Error("environment unreadable"));
    const result = await execute(
      "kit.source.set",
      { id: "terminal-kit", version: "0.0.1", source: "development", path: "/work/kit" },
      {},
    );
    expect(result).toMatchObject({ ok: false, code: "INTERNAL" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
