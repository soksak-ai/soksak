import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const memory = new Map<string, string>();
const storage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
  clear: () => memory.clear(),
};
vi.stubGlobal("localStorage", storage);

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(async () => undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => invoke(command, args),
}));

import { OFFICIAL_REGISTRY_ID, type RegistryDescriptor } from "../plugins/registry";
import { setRegistryRuntimeDeps, useRegistry } from "./registry";

const FIXTURES = join(process.cwd(), "packages/plugin-spec/test/fixtures/platform-wire");

function json(name: string): any {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

function fixtureDescriptor(overrides: Partial<RegistryDescriptor> = {}): RegistryDescriptor {
  return {
    id: "fixture",
    name: "Fixture",
    indexUrl: "https://registry.example.test/index.json",
    visibility: "public",
    trustedPublicKey: json("registry-public-key.json"),
    ...overrides,
  };
}

const initial = useRegistry.getState();
const bootstrap = {
  entries: [],
  units: [],
  descriptors: structuredClone(initial.descriptors),
  registries: Object.fromEntries(initial.descriptors.map((descriptor) => [descriptor.id, {
    descriptor,
    status: "idle" as const,
    fetchedOnce: false,
    entries: [],
  }])),
  trustRecords: structuredClone(initial.trustRecords),
  status: "idle" as const,
  fetchedOnce: false,
  events: [] as typeof initial.events,
};

let restore = () => {};

describe("registry state", () => {
  beforeEach(() => {
    memory.clear();
    invoke.mockReset();
    useRegistry.setState(structuredClone(bootstrap));
    restore = setRegistryRuntimeDeps({
      load: vi.fn(async () => json("registry-signed.json")),
      now: () => Date.parse("2026-07-14T12:00:00Z"),
    });
  });

  afterEach(() => restore());

  it("keeps each registry independent when another source fails", async () => {
    useRegistry.getState().add(fixtureDescriptor());
    useRegistry.getState().add(fixtureDescriptor({
      id: "offline",
      name: "Offline",
      indexUrl: "https://offline.example.test/index.json",
    }));
    restore();
    restore = setRegistryRuntimeDeps({
      load: vi.fn(async (descriptor) => {
        if (descriptor.id === "offline") throw new Error("offline");
        return json("registry-signed.json");
      }),
      now: () => Date.parse("2026-07-14T12:00:00Z"),
    });

    await useRegistry.getState().refresh(true);

    expect(useRegistry.getState().registries.fixture.status).toBe("live");
    expect(useRegistry.getState().registries.offline.status).toBe("error");
    expect(useRegistry.getState().registries.fixture.entries).toHaveLength(3);
  });

  it("uses a core-derived vault slot for private registry authorization", async () => {
    const privateDescriptor = fixtureDescriptor({ visibility: "private" });
    useRegistry.getState().add(privateDescriptor);
    useRegistry.getState().registries.fixture.descriptor.credentialRef = "another-owner/token";
    invoke.mockResolvedValue({
      status: 200,
      headers: {},
      body: JSON.stringify(json("registry-signed.json")),
    });
    restore();
    restore = setRegistryRuntimeDeps({ now: () => Date.parse("2026-07-14T12:00:00Z") });

    await useRegistry.getState().refresh(true, "fixture");

    expect(invoke).toHaveBeenCalledWith("net_http_request", expect.objectContaining({
      method: "GET",
      url: privateDescriptor.indexUrl,
      ns: "core_registry-fixture",
    }));
    const args = invoke.mock.calls[0][1] as {
      headers: { authorization: string };
      secretSubst: Record<string, string>;
    };
    expect(args.secretSubst).toEqual({ [args.headers.authorization]: "http-authorization" });
    expect(useRegistry.getState().registries.fixture.status).toBe("live");
  });

  it("does not remove the built-in trust root", () => {
    expect(useRegistry.getState().remove(OFFICIAL_REGISTRY_ID))
      .toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  });

  it("exposes explicit lifecycle events without polling", async () => {
    useRegistry.getState().add(fixtureDescriptor());
    await useRegistry.getState().refresh(true, "fixture");
    expect(useRegistry.getState().events.map((event) => event.type)).toEqual([
      "registry.added",
      "registry.refresh.started",
      "registry.refresh.succeeded",
    ]);
  });
});
