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

import { setRegistryRuntimeDeps, useRegistry } from "./registry";
import type { RegistryDescriptor } from "../plugins/registry";

const FIXTURES = join(
  process.cwd(),
  "packages/plugin-spec/test/fixtures/platform-wire",
);

function json(name: string): any {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

const descriptor: RegistryDescriptor = {
  id: "fixture",
  name: "Fixture",
  indexUrl: "https://registry.example.test/index.json",
  visibility: "public",
  trustedPublicKey: json("registry-public-key.json"),
};

const initial = useRegistry.getState();
const bootstrap = {
  entries: [],
  units: [],
  descriptors: structuredClone(initial.descriptors),
  registries: Object.fromEntries(initial.descriptors.map((value) => [value.id, {
    descriptor: value,
    status: "idle" as const,
    fetchedOnce: false,
    entries: [],
  }])),
  status: "idle" as const,
  fetchedOnce: false,
  events: [] as typeof initial.events,
  trustRecords: structuredClone(initial.trustRecords),
};

let restore = () => {};

describe("registry state trust continuity", () => {
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

  it("starts with no unsigned catalog projection", () => {
    expect(useRegistry.getState().entries).toEqual([]);
    expect(useRegistry.getState().units).toEqual([]);
    expect(useRegistry.getState().registries.official.status).toBe("idle");
  });

  it("stores the certified high-water before exposing release-only entries", async () => {
    expect(useRegistry.getState().add(descriptor)).toMatchObject({ ok: true });
    await useRegistry.getState().refresh(true, "fixture");

    const source = useRegistry.getState().registries.fixture;
    expect(source.status).toBe("live");
    expect(source.entries.map((entry) => entry.kind)).toEqual(["kit", "plugin", "sidecar"]);
    expect(source.entries[1]).not.toHaveProperty("repo");
    expect(source.entries[1]).not.toHaveProperty("branch");
    expect(useRegistry.getState().trustRecords.fixture.highWater).toEqual({
      sequence: 42,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const persisted = JSON.parse(memory.get("soksak.registries") ?? "{}");
    expect(persisted.trustRecords.fixture.highWater.sequence).toBe(42);
  });

  it("rejects rollback and same-sequence equivocation without replacing the last live index", async () => {
    expect(useRegistry.getState().add(descriptor)).toMatchObject({ ok: true });
    await useRegistry.getState().refresh(true, "fixture");
    const accepted = useRegistry.getState().registries.fixture.entries;
    const signed = json("registry-signed.json");

    restore();
    restore = setRegistryRuntimeDeps({
      load: vi.fn(async () => ({ ...signed, sequence: 41 })),
      now: () => Date.parse("2026-07-14T12:00:00Z"),
    });
    await useRegistry.getState().refresh(true, "fixture");
    expect(useRegistry.getState().registries.fixture.status).toBe("uncertified");
    expect(useRegistry.getState().registries.fixture.entries).toEqual(accepted);
  });

  it("retains a removed registry trust pin so re-adding the same id cannot replace its key", () => {
    expect(useRegistry.getState().add(descriptor)).toMatchObject({ ok: true });
    expect(useRegistry.getState().remove("fixture")).toMatchObject({ ok: true });
    expect(useRegistry.getState().add({
      ...descriptor,
      trustedPublicKey: {
        ...descriptor.trustedPublicKey,
        keyId: "attacker-key",
        value: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      },
    })).toMatchObject({ ok: false, code: "TRUST_CONFLICT" });
  });
});
