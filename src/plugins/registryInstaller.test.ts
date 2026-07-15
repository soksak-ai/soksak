import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  certifyRegistryIndex,
  type CertifiedRegistryIndex,
  type RegistryPublicKey,
} from "./spec";
import {
  installRegistryClosure,
  type RegistryArtifactStager,
  type RegistryDocumentLoader,
} from "./registryInstaller";

const FIXTURES = join(
  process.cwd(),
  "packages/plugin-spec/test/fixtures/platform-wire",
);

function bytes(name: string): Uint8Array {
  return readFileSync(join(FIXTURES, name));
}

async function certifiedIndex(): Promise<CertifiedRegistryIndex> {
  const raw = JSON.parse(new TextDecoder().decode(bytes("registry-signed.json")));
  const publicKey = JSON.parse(
    new TextDecoder().decode(bytes("registry-public-key.json")),
  ) as RegistryPublicKey;
  const result = await certifyRegistryIndex(raw, {
    expectedRegistryId: "fixture",
    expectedKeyId: publicKey.keyId,
    publicKey,
    now: Date.parse("2026-07-14T12:00:00Z"),
  });
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.value;
}

function documentLoader(): RegistryDocumentLoader {
  const documents = new Map<string, Uint8Array>();
  const releases = {
    "weather-plugin.release.json": "release-plugin.json",
    "terminal-common.release.json": "release-kit.json",
  } as const;
  for (const [asset, fixture] of Object.entries(releases)) {
    documents.set(asset, bytes(fixture));
  }
  const reports = {
    "plugin-kind.conformance.json": "conformance-plugin-kind.json",
    "plugin-release.conformance.json": "conformance-plugin-release.json",
    "kit-kind.conformance.json": "conformance-kit-kind.json",
    "kit-release.conformance.json": "conformance-kit-release.json",
  } as const;
  for (const [asset, fixture] of Object.entries(reports)) {
    documents.set(asset, bytes(fixture));
  }
  return {
    load: vi.fn(async (url: string) => {
      const parts = url.split("/");
      const asset = parts[parts.length - 1] ?? "";
      const value = documents.get(asset);
      if (!value) throw new Error(`unexpected document: ${url}`);
      return Uint8Array.from(value);
    }),
  };
}

function stager(overrides: Partial<RegistryArtifactStager> = {}): RegistryArtifactStager {
  return {
    begin: vi.fn(async () => ({ transactionId: "tx-1" })),
    stage: vi.fn(async ({ unit, artifact }) => ({
      handle: `${unit.kind}/${unit.id}@${unit.version}`,
      sha256: artifact.sha256,
      extraction: "regular-files-only" as const,
    })),
    readUtf8: vi.fn(async (_transactionId, handle, path) => {
      if (handle.startsWith("plugin/") && path === "plugin.json") {
        return new TextDecoder().decode(bytes("plugin.json"));
      }
      if (handle.startsWith("kit/") && path === "package.json") {
        return JSON.stringify({ name: "terminal-common", version: "0.0.1", private: true });
      }
      throw new Error(`unexpected staged read: ${handle}/${path}`);
    }),
    commit: vi.fn(async () => ({ generation: "generation-1" })),
    rollback: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("registry release installer", () => {
  let certified: CertifiedRegistryIndex;

  beforeEach(async () => {
    certified = await certifiedIndex();
  });

  it("resolves plugin/sidecar/kit only inside one certified origin and commits the complete closure once", async () => {
    const documents = documentLoader();
    const artifacts = stager();

    const result = await installRegistryClosure({
      certified,
      root: { kind: "plugin", id: "weather-plugin", version: "0.0.1" },
      target: "aarch64-apple-darwin",
      documents,
      artifacts,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.units.map((unit) => `${unit.kind}:${unit.id}@${unit.version}`)).toEqual([
      "kit:terminal-common@0.0.1",
      "plugin:weather-plugin@0.0.1",
    ]);
    expect(artifacts.commit).toHaveBeenCalledTimes(1);
    expect(artifacts.rollback).not.toHaveBeenCalled();
    expect(artifacts.commit).toHaveBeenCalledWith(
      "tx-1",
      expect.arrayContaining([
        expect.objectContaining({
          kind: "plugin",
          id: "weather-plugin",
          sourceCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          providers: [],
        }),
      ]),
    );
  });

  it("rolls back every staged unit when native extraction cannot attest regular-file-only bytes", async () => {
    const artifacts = stager({
      stage: vi.fn(async ({ unit, artifact }) => ({
        handle: `${unit.kind}/${unit.id}@${unit.version}`,
        sha256: artifact.sha256,
        extraction: "unverified" as never,
      })),
    });

    const result = await installRegistryClosure({
      certified,
      root: { kind: "plugin", id: "weather-plugin", version: "0.0.1" },
      target: "aarch64-apple-darwin",
      documents: documentLoader(),
      artifacts,
    });

    expect(result).toMatchObject({ ok: false, code: "UNSAFE_EXTRACTION" });
    expect(artifacts.commit).not.toHaveBeenCalled();
    expect(artifacts.rollback).toHaveBeenCalledWith("tx-1");
  });

  it("does not commit a partial graph when an owner report byte fails its registry digest", async () => {
    const loader = documentLoader();
    const load = loader.load;
    loader.load = vi.fn(async (url) => {
      const value = await load(url);
      return url.endsWith("kit-kind.conformance.json")
        ? new TextEncoder().encode("{}")
        : value;
    });
    const artifacts = stager();

    const result = await installRegistryClosure({
      certified,
      root: { kind: "plugin", id: "weather-plugin", version: "0.0.1" },
      target: "aarch64-apple-darwin",
      documents: loader,
      artifacts,
    });

    expect(result).toMatchObject({ ok: false, code: "RELEASE_VERIFICATION_FAILED" });
    expect(artifacts.commit).not.toHaveBeenCalled();
    expect(artifacts.rollback).toHaveBeenCalledWith("tx-1");
  });
});
