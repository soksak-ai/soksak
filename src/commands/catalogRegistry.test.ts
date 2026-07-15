import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const memory = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
  clear: () => memory.clear(),
});

const { invoke, publishActivity } = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(async () => undefined),
  publishActivity: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => invoke(command, args),
}));
vi.mock("../state/activityFeed", () => ({
  publishActivity: (...args: unknown[]) => publishActivity(...args),
}));

import { registerPluginCatalog } from "./catalogPlugins";
import { execute, getSpec } from "./registry";
import { usePlugins } from "../state/plugins";
import { useRegistry } from "../state/registry";
import {
  certifyRegistryIndex,
  type CertifiedRegistryIndex,
  type RegistryPublicKey,
} from "../plugins/spec";
import { qualifyRegistry, type RegistryDescriptor } from "../plugins/registry";
import { setRegistryInstallRuntime } from "../plugins/registryInstallRuntime";

const FIXTURES = join(process.cwd(), "packages/plugin-spec/test/fixtures/platform-wire");

function json(name: string): any {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

const trustedPublicKey = json("registry-public-key.json") as RegistryPublicKey;
const descriptor: RegistryDescriptor = {
  id: "fixture",
  name: "Fixture",
  indexUrl: "https://registry.example.test/index.json",
  visibility: "public",
  trustedPublicKey,
};

let certified: CertifiedRegistryIndex;
let restoreInstaller = () => {};
const installRelease = vi.fn(async () => ({
  ok: true as const,
  id: "weather-plugin",
  version: "0.0.1",
  generation: "generation-1",
}));

const initialRegistry = useRegistry.getState();
const bootstrap = {
  entries: [],
  units: [],
  descriptors: structuredClone(initialRegistry.descriptors),
  registries: Object.fromEntries(initialRegistry.descriptors.map((value) => [value.id, {
    descriptor: value,
    status: "idle" as const,
    fetchedOnce: false,
    entries: [],
  }])),
  trustRecords: structuredClone(initialRegistry.trustRecords),
  status: "idle" as const,
  fetchedOnce: false,
  events: [] as typeof initialRegistry.events,
};

beforeAll(async () => {
  const result = await certifyRegistryIndex(json("registry-signed.json"), {
    expectedRegistryId: "fixture",
    expectedKeyId: trustedPublicKey.keyId,
    publicKey: trustedPublicKey,
    now: Date.parse("2026-07-14T12:00:00Z"),
  });
  if (!result.ok) throw new Error(result.errors.join("; "));
  certified = result.value;
  if (!getSpec("registry.list")) registerPluginCatalog();
});

beforeEach(() => {
  invoke.mockReset();
  publishActivity.mockReset();
  installRelease.mockClear();
  usePlugins.setState({ plugins: {} });
  useRegistry.setState(structuredClone(bootstrap));
  restoreInstaller = setRegistryInstallRuntime(installRelease);
});

afterEach(() => restoreInstaller());

function seedCertifiedFixture(): void {
  const entries = qualifyRegistry(certified);
  const state = useRegistry.getState();
  useRegistry.setState({
    entries: [],
    units: entries,
    descriptors: [...state.descriptors, descriptor],
    registries: {
      ...state.registries,
      fixture: {
        descriptor,
        status: "live",
        fetchedOnce: true,
        entries,
        certified,
        lastFetchedAt: 10,
      },
    },
    trustRecords: {
      ...state.trustRecords,
      fixture: { publicKey: trustedPublicKey, highWater: certified.highWater },
    },
  });
}

describe("registry commands", () => {
  it("exposes registry lifecycle commands with explicit pinned-key descriptors", () => {
    for (const name of ["registry.list", "registry.add", "registry.remove", "registry.refresh", "registry.status"]) {
      expect(getSpec(name), name).toBeDefined();
    }
    expect(getSpec("registry.add")!.params.descriptor.type).toBe("json");
  });

  it("rejects credentials embedded beside descriptor trust metadata", async () => {
    const result = await execute("registry.add", {
      descriptor: { ...descriptor, token: "secret" },
    }, {});
    expect(result).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  });

  it("lists only authenticated release references without repo or branch fields", async () => {
    seedCertifiedFixture();
    const result = await execute("plugin.catalog", { registryId: "fixture" }, {});
    expect(result.ok).toBe(true);
    const plugins = result.data?.plugins as Record<string, unknown>[];
    expect(plugins).toEqual([
      expect.objectContaining({
        registryId: "fixture",
        unitId: "weather-plugin",
        kind: "plugin",
        version: "0.0.1",
      }),
    ]);
    expect(plugins[0]).not.toHaveProperty("repo");
    expect(plugins[0]).not.toHaveProperty("branch");
    expect(plugins[0]).not.toHaveProperty("commands");
  });
});

describe("certified release installation", () => {
  it("passes an exact certified registry object and exact release identity to the atomic installer", async () => {
    seedCertifiedFixture();
    const result = await execute("plugin.install", {
      registryId: "fixture",
      unitId: "weather-plugin",
    }, {});

    expect(result).toMatchObject({
      ok: true,
      data: { id: "weather-plugin", version: "0.0.1", generation: "generation-1" },
    });
    expect(installRelease).toHaveBeenCalledWith({
      certified,
      root: { kind: "plugin", id: "weather-plugin", version: "0.0.1" },
    });
  });

  it("requires explicit qualification for a custom registry", async () => {
    seedCertifiedFixture();
    const result = await execute("plugin.install", { source: "weather-plugin" }, {});
    expect(result).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(installRelease).not.toHaveBeenCalled();
  });

  it.each([
    "https://github.com/example/weather-plugin.git",
    "example/weather-plugin",
    "/tmp/weather-plugin",
  ])("rejects a repository or filesystem installation source: %s", async (source) => {
    seedCertifiedFixture();
    const result = await execute("plugin.install", { source }, {});
    expect(result).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(installRelease).not.toHaveBeenCalled();
  });
});
