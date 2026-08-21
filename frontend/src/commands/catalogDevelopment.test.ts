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

  it("lists only the requested component type from composition settings", async () => {
    invoke.mockResolvedValueOnce({
      generation: 4,
      plugins: [{ id: "p", version: "0.0.1", development: true }],
      sidecars: [{ id: "s", version: "0.0.1", development: true }],
      kits: [{ id: "k", version: "0.0.1", development: true }],
    });
    const result = await execute("sidecar.development.list", {}, {});
    expect(result).toMatchObject({
      ok: true,
      data: { generation: 4, sidecars: [{ id: "s", development: true }] },
    });
  });

  it("sets one plugin through the typed backend command and current generation", async () => {
    invoke.mockResolvedValueOnce({ generation: 7, plugins: [], sidecars: [], kits: [] });
    invoke.mockResolvedValueOnce({ generation: 8 });
    const result = await execute(
      "plugin.development.set",
      { id: "weather", version: "0.0.1", development: true, path: "/work/weather" },
      {},
    );
    expect(invoke).toHaveBeenNthCalledWith(2, "plugin_development_set", {
      id: "weather",
      version: "0.0.1",
      development: true,
      path: "/work/weather",
      manifest: "plugin.json",
      source: { type: "path", path: "/work/weather" },
      expectedGeneration: 7,
    });
    expect(result).toMatchObject({ ok: true, data: { kind: "plugin", id: "weather", generation: 8 } });
  });

  it("does not guess generation zero when settings cannot be read", async () => {
    invoke.mockRejectedValueOnce(new Error("settings unreadable"));
    const result = await execute(
      "kit.development.set",
      { id: "terminal-kit", version: "0.0.1", development: true, path: "/work/kit" },
      {},
    );
    expect(result).toMatchObject({ ok: false, code: "INTERNAL" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
