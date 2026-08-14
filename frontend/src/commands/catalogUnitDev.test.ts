import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async (..._a: unknown[]): Promise<unknown> => undefined),
}));
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: (...a: unknown[]) => invoke(...a),
}));

import { registerUnitDevCatalog } from "./catalogUnitDev";
import { execute, getSpec, unregister } from "./registry";
import { usePlugins } from "../state/plugins";

beforeEach(() => {
  invoke.mockReset();
  registerUnitDevCatalog();
});

afterEach(() => {
  for (const name of ["unit.dev.list", "unit.dev.set", "unit.dev.remove"]) unregister(name);
});

describe("unit.dev.* — the development source surface every core identity shares", () => {
  it("exposes shape-only examples and reports an empty config as official", async () => {
    invoke.mockResolvedValueOnce([]);
    const spec = getSpec("unit.dev.list");
    // Examples show the command shape only — listing the three envs was redundant because the presenter (each binary) prefixes its own name.
    expect(spec?.examples).toEqual(["unit.dev.list"]);
    const r = await execute("unit.dev.list", {}, {});
    expect(r).toMatchObject({ ok: true, data: { unitMode: "official", units: [] } });
  });

  it("delegates the sidecar/kit source choice to the generic core config", async () => {
    invoke.mockResolvedValueOnce({ kind: "kit", id: "browser-common", source: "/work/kit" });
    const r = await execute(
      "unit.dev.set",
      { kind: "kit", id: "browser-common", source: "/work/kit" },
      {},
    );
    expect(invoke).toHaveBeenCalledWith("unit_dev_set", {
      kind: "kit",
      id: "browser-common",
      source: "/work/kit",
    });
    expect(r).toMatchObject({ ok: true, data: { kind: "kit", id: "browser-common" } });
  });

  it("surfaces the core path refusal as INVALID_PARAMS unchanged", async () => {
    invoke.mockRejectedValueOnce(new Error("a development source must be an absolute path"));
    const r = await execute(
      "unit.dev.set",
      { kind: "sidecar", id: "speech", source: "relative/path" },
      {},
    );
    expect(r).toMatchObject({
      ok: false,
      code: "INVALID_PARAMS",
      message: expect.stringContaining("absolute path"),
    });
  });

  it("recomputes the loader after a plugin source is cleared, so the installed build is back", async () => {
    const reload = vi.fn(async () => {});
    usePlugins.setState({ reload });
    invoke.mockResolvedValueOnce(true);
    const r = await execute("unit.dev.remove", { kind: "plugin", id: "weather" }, {});
    expect(invoke).toHaveBeenCalledWith("unit_dev_remove", { kind: "plugin", id: "weather" });
    expect(reload).toHaveBeenCalledOnce();
    expect(r).toMatchObject({ ok: true, data: { removed: true } });
  });
});
