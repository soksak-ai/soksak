import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { registerDevelopmentCatalog } from "./catalogDevelopment";
import { execute, getSpec, unregister } from "./registry";

const COMMANDS = [
  "plugin.development.list", "plugin.development.set",
  "sidecar.development.list", "sidecar.development.set",
  "kit.development.list", "kit.development.set",
] as const;

beforeEach(() => {
  invoke.mockReset();
  registerDevelopmentCatalog();
});

afterEach(() => {
  for (const name of COMMANDS) unregister(name);
});

describe("kind-specific development commands", () => {
  it("does not expose a generic kind parameter", () => {
    for (const name of COMMANDS) {
      expect(getSpec(name)).toBeDefined();
      expect(getSpec(name)?.params).not.toHaveProperty("kind");
    }
    expect(getSpec("unit.dev.set")).toBeUndefined();
  });

  it("lists only the requested component type from settings", async () => {
	invoke.mockResolvedValueOnce({
		revision: 4,
		plugins: { p: { enabled: true, development: { path: "/work/p" } } },
		sidecars: { s: { development: { path: "/work/s" } } },
		kits: { k: { development: { path: "/work/k" } } }, contracts: {}, specs: {},
    });
    const result = await execute("sidecar.development.list", {}, {});
    expect(result).toMatchObject({
      ok: true,
		data: { revision: 4, sidecars: { s: { development: { path: "/work/s" } } } },
    });
  });

  it("sets one plugin through the typed backend command and current revision", async () => {
    invoke.mockResolvedValueOnce({ revision: 7, plugins: {}, sidecars: {}, kits: {}, contracts: {}, specs: {} });
    invoke.mockResolvedValueOnce({ revision: 8 });
    const result = await execute(
      "plugin.development.set",
      { id: "weather", development: true, path: "/work/weather" },
      {},
    );
    expect(invoke).toHaveBeenNthCalledWith(2, "plugin_development_set", {
      id: "weather",
      development: true,
      path: "/work/weather",
      expectedRevision: 7,
    });
    expect(result).toMatchObject({ ok: true, data: { kind: "plugin", id: "weather", revision: 8 } });
  });

  it("does not guess revision zero when settings cannot be read", async () => {
    invoke.mockRejectedValueOnce(new Error("settings unreadable"));
    const result = await execute(
      "kit.development.set",
      { id: "terminal-kit", development: true, path: "/work/kit" },
      {},
    );
    expect(result).toMatchObject({ ok: false, code: "INTERNAL" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
