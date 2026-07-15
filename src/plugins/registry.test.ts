import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { certifyRegistryIndex, type RegistryPublicKey } from "./spec";
import {
  OFFICIAL_REGISTRY_ID,
  installState,
  isOfficial,
  isRegistryIndexUrl,
  parseRegistryDescriptor,
  qualifyRegistry,
  registryCredentialSlot,
  resolveRegistryUnit,
  type QualifiedRegistryEntry,
  type RegistryDescriptor,
} from "./registry";

const FIXTURES = join(process.cwd(), "packages/plugin-spec/test/fixtures/platform-wire");

function json(name: string): any {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

const publicKey = json("registry-public-key.json") as RegistryPublicKey;

function descriptor(overrides: Partial<RegistryDescriptor> = {}): RegistryDescriptor {
  return {
    id: "community",
    name: "Community",
    indexUrl: "https://registry.example.test/index.json",
    visibility: "public",
    trustedPublicKey: publicKey,
    ...overrides,
  };
}

async function fixtureUnits(registryId = "fixture"): Promise<QualifiedRegistryEntry[]> {
  const certified = await certifyRegistryIndex(json("registry-signed.json"), {
    expectedRegistryId: "fixture",
    expectedKeyId: publicKey.keyId,
    publicKey,
    now: Date.parse("2026-07-14T12:00:00Z"),
  });
  if (!certified.ok) throw new Error(certified.errors.join("; "));
  return qualifyRegistry({
    ...certified.value,
    index: { ...certified.value.index, registryId },
  });
}

describe("registry descriptor", () => {
  it("pins a credential-free HTTPS index and an Ed25519 public key", () => {
    expect(parseRegistryDescriptor(descriptor())).toEqual(descriptor());
    expect(parseRegistryDescriptor({ ...descriptor(), token: "secret" })).toBeNull();
    expect(parseRegistryDescriptor({ ...descriptor(), trustedPublicKey: undefined })).toBeNull();
  });

  it("derives one collision-free private credential slot from registry identity", () => {
    expect(parseRegistryDescriptor(descriptor({ id: "corp", visibility: "private" })))
      .toMatchObject({ credentialRef: "core_registry-corp/http-authorization" });
    expect(registryCredentialSlot("team.blue_registry")).toEqual({
      namespace: "core_registry-team-dblue-uregistry",
      key: "http-authorization",
      ref: "core_registry-team-dblue-uregistry/http-authorization",
    });
    expect(new Set(["team-blue", "team.blue", "team_blue"].map(
      (id) => registryCredentialSlot(id)?.ref,
    )).size).toBe(3);
    expect(parseRegistryDescriptor(descriptor({
      id: "corp",
      visibility: "private",
      credentialRef: "another-owner/token",
    }))).toBeNull();
  });

  it.each([
    "http://registry.example.test/index.json",
    "https://user:token@registry.example.test/index.json",
    "https://registry.example.test/index.json?token=x",
    "https://registry.example.test/index.json#fragment",
    "https:\\\\registry.example.test\\index.json",
  ])("rejects a non-canonical or credential-bearing index URL: %s", (url) => {
    expect(isRegistryIndexUrl(url)).toBe(false);
    expect(parseRegistryDescriptor(descriptor({ indexUrl: url }))).toBeNull();
  });
});

describe("qualified release catalog", () => {
  it("projects only authenticated release references without repository or branch locators", async () => {
    const units = await fixtureUnits();
    expect(units.map((entry) => entry.kind)).toEqual(["kit", "plugin", "sidecar"]);
    for (const entry of units) {
      expect(entry.registryId).toBe("fixture");
      expect(entry.unitId).toBe(entry.id);
      expect(entry).not.toHaveProperty("repo");
      expect(entry).not.toHaveProperty("branch");
    }
  });

  it("selects the greatest matching release in one registry", async () => {
    const units = await fixtureUnits(OFFICIAL_REGISTRY_ID);
    const plugin = units.find((entry) => entry.kind === "plugin")!;
    const candidates = [
      { ...plugin, version: "0.0.1" },
      { ...plugin, version: "0.1.0" },
      { ...plugin, version: "1.0.0" },
    ];
    expect(resolveRegistryUnit(candidates, {
      unitId: plugin.id,
      kind: "plugin",
      range: ">=0.0.1 <1.0.0",
    })).toMatchObject({ ok: true, entry: { version: "0.1.0" } });
  });

  it("requires registry qualification for custom sources and rejects cross-registry ambiguity", async () => {
    const official = await fixtureUnits(OFFICIAL_REGISTRY_ID);
    const community = await fixtureUnits("community");
    const id = official.find((entry) => entry.kind === "plugin")!.id;
    expect(resolveRegistryUnit(community, { unitId: id, kind: "plugin" }))
      .toMatchObject({ ok: false, reason: "qualification_required" });
    expect(resolveRegistryUnit([...official, ...community], { unitId: id, kind: "plugin" }))
      .toMatchObject({ ok: false, reason: "ambiguous" });
  });
});

describe("catalog install state", () => {
  const entry = { version: "0.0.1" };

  it("marks absent, equal, newer, and development-owned versions without downgrade prompts", () => {
    expect(installState(entry)).toBe("available");
    expect(installState(entry, "0.0.1", "installed")).toBe("installed");
    expect(installState({ version: "0.0.2" }, "0.0.1", "installed")).toBe("update");
    expect(installState({ version: "0.0.2" }, "0.0.1", "dev")).toBe("installed");
  });

  it("recognizes official membership only from qualified authenticated entries", async () => {
    const official = await fixtureUnits(OFFICIAL_REGISTRY_ID);
    const plugin = official.find((entry) => entry.kind === "plugin")!;
    expect(isOfficial(official, plugin.id)).toBe(true);
    expect(isOfficial(await fixtureUnits("community"), plugin.id)).toBe(false);
  });
});
