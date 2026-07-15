import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContractProviderRef } from "../plugins/spec";

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => mem.get(key) ?? null,
  setItem: (key: string, value: string) => void mem.set(key, value),
  removeItem: (key: string) => void mem.delete(key),
  clear: () => mem.clear(),
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

import { registerPluginCatalog } from "./catalogPlugins";
import { execute, getSpec } from "./registry";
import { usePlugins, type PluginRuntime } from "../state/plugins";
import { parseManifest } from "../plugins/spec";

registerPluginCatalog();

const NOTES_001 = { id: "soksak-spec-plugin-fixture-notes", version: "0.0.1" };
const NOTES_002 = { id: "soksak-spec-plugin-fixture-notes", version: "0.0.2" };
const BOARD_001 = { id: "soksak-spec-plugin-fixture-board", version: "0.0.1" };
const ALPHA = "soksak-plugin-fixture-alpha";
const BETA = "soksak-plugin-fixture-beta";

function fixtureRuntime(
  id: string,
  providers: ContractProviderRef[],
  status: PluginRuntime["status"] = "enabled",
): PluginRuntime {
  const { manifest, validation } = parseManifest({
    spec: "soksak-spec-plugin@0.0.1",
    id,
    name: "Fixture",
    version: "0.0.1",
    description: "contract fixture",
    permissions: [],
    ...(providers.length > 0 ? { implements: providers } : {}),
  }, id);
  if (!manifest) throw new Error(validation.errors.join("; "));
  return { manifest, dir: `/tmp/${id}`, source: "dev", status };
}

beforeEach(() => {
  usePlugins.setState({ plugins: {
    [ALPHA]: fixtureRuntime(ALPHA, [NOTES_001]),
    [BETA]: fixtureRuntime(BETA, [NOTES_002, BOARD_001]),
  } });
});

describe("plugin.implementers", () => {
  it("exposes id and range rather than a name@version parameter", () => {
    const spec = getSpec("plugin.implementers")!;
    expect(spec.params.id).toBeDefined();
    expect(spec.params.range).toBeDefined();
    expect(spec.params.contract).toBeUndefined();
  });

  it("returns every compatible provider and preserves runtime status", async () => {
    const result = await execute("plugin.implementers", {
      id: NOTES_001.id,
      range: ">=0.0.1 <1.0.0",
    }, {}) as any;
    expect(result.ok).toBe(true);
    expect(result.data.requirement).toEqual({ id: NOTES_001.id, range: ">=0.0.1 <1.0.0" });
    expect(result.data.implementers.map((item: { id: string }) => item.id)).toEqual([ALPHA, BETA]);
    expect(result.data.implementers[0]).toEqual({ id: ALPHA, version: "0.0.1", status: "enabled" });
  });

  it("filters by range instead of exact concatenated identity", async () => {
    const result = await execute("plugin.implementers", { id: NOTES_001.id, range: "=0.0.2" }, {}) as any;
    expect(result.data.implementers.map((item: { id: string }) => item.id)).toEqual([BETA]);
  });

  it("lists exact provider evidence when no consumer query is supplied", async () => {
    const result = await execute("plugin.implementers", {}, {}) as any;
    expect(result.data.contracts).toEqual([
      { contract: BOARD_001, implementers: [BETA] },
      { contract: NOTES_001, implementers: [ALPHA] },
      { contract: NOTES_002, implementers: [BETA] },
    ]);
  });

  it("rejects partial or retired exact-string queries", async () => {
    expect((await execute("plugin.implementers", { id: NOTES_001.id }, {}) as any).code).toBe("INVALID_PARAMS");
    expect((await execute("plugin.implementers", { contract: `${NOTES_001.id}@0.0.1` }, {}) as any).code).toBe("INVALID_PARAMS");
  });
});
