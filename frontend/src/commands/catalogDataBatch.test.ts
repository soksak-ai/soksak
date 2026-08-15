import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()), invoke }));

import { registerDataCatalog } from "./catalogData";
import { catalogJson, execute, getSpec, unregister } from "./registry";

let registered: string[] = [];

beforeEach(() => {
  invoke.mockReset();
  const before = new Set(catalogJson().map(({ name }) => name));
  registerDataCatalog();
  registered = catalogJson().map(({ name }) => name).filter((name) => !before.has(name));
});

afterEach(() => {
  for (const name of registered) unregister(name);
  registered = [];
});

describe("data.kv.entries", () => {
  it("answers the prefix key/value snapshot in one call, in the same public shape", async () => {
    invoke.mockResolvedValue({
      ns: "core",
      entries: [{ key: "window/w-1", value: { workspaces: [] } }],
    });

    const out = await execute("data.kv.entries", { ns: "core", prefix: "window" }, {});

    expect(out).toMatchObject({
      ok: true,
      data: { ns: "core", entries: [{ key: "window/w-1", value: { workspaces: [] } }] },
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("data_kv_entries", { ns: "core", prefix: "window" });
  });
});

describe("data.kv.deleteMany", () => {
  it("publishes one deduped call for exact keys and a one-line batch message", async () => {
    invoke.mockResolvedValue({ ns: "core", requested: 2, deleted: 1, absent: 1 });

    const out = await execute(
      "data.kv.deleteMany",
      { ns: "core", keys: ["window/a", "window/a", "window/a#prev"] },
      {},
    );

    expect(out).toMatchObject({
      ok: true,
      message: expect.stringContaining("1 deleted"),
      data: { ns: "core", requested: 2, deleted: 1, absent: 1 },
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("data_kv_delete_many", {
      ns: "core",
      keys: ["window/a", "window/a#prev"],
    });
    expect(getSpec("data.kv.deleteMany")?.danger).toBe("destructive");
  });

  it.each([
    { label: "empty", keys: [] },
    { label: "empty key", keys: [""] },
    { label: "non-string", keys: ["ok", 1] },
    { label: "overflow", keys: Array.from({ length: 4_097 }, (_, i) => `k-${i}`) },
  ])("rejects $label keys before the native call", async ({ keys }) => {
    const out = await execute("data.kv.deleteMany", { ns: "core", keys }, {});
    expect(out).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(invoke).not.toHaveBeenCalled();
  });
});
