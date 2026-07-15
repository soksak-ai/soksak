import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REGISTRY_WIRE_SPEC,
  canonicalRegistryPayload,
  certifyRegistryIndex,
  isCertifiedRegistryUnitRelease,
  parseRegistryPublicKey,
  parseSignedRegistryIndex,
  resolveRegistryDependency,
  verifyRegistryUnitRelease,
  type RegistryPublicKey,
} from "../src/registry.js";
import { pluginRelease } from "./releaseFixture.js";

const encoder = new TextEncoder();
const AT = Date.parse("2026-07-14T12:00:00Z");
const CORPUS = join(import.meta.dirname, "fixtures/platform-wire");

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function conformance(
  contract: string,
  manifestSha256: string,
  artifactSha256 = "1".repeat(64),
): Record<string, unknown> {
  return {
    spec: "soksak-spec-conformance@0.0.1",
    subject: {
      kind: "plugin",
      id: "weather-plugin",
      version: "0.0.1",
      manifestSha256,
    },
    contract,
    result: "passed",
    validator: { name: "soksak-conformance", version: "0.0.1" },
    artifacts: [{ target: "any", sha256: artifactSha256 }],
  };
}

function closure() {
  const manifestBytes = encoder.encode(`${JSON.stringify(pluginRelease(), null, 2)}\n`);
  const manifestSha256 = sha(manifestBytes);
  const releaseReportBytes = encoder.encode(`${JSON.stringify(conformance("soksak-spec-release@0.0.1", manifestSha256), null, 2)}\n`);
  const pluginReportBytes = encoder.encode(`${JSON.stringify(conformance("soksak-spec-plugin@0.0.1", manifestSha256), null, 2)}\n`);
  const base = "https://github.com/example/weather-plugin/releases/download/v0.0.1";
  const reports = [
    { url: `${base}/plugin.conformance.json`, sha256: sha(pluginReportBytes), bytes: pluginReportBytes },
    { url: `${base}/release.conformance.json`, sha256: sha(releaseReportBytes), bytes: releaseReportBytes },
  ];
  return {
    manifestBytes,
    reports,
    entry: {
      kind: "plugin",
      id: "weather-plugin",
      version: "0.0.1",
      manifest: { url: `${base}/weather-plugin.release.json`, sha256: manifestSha256 },
      reports: reports.map(({ url, sha256 }) => ({ url, sha256 })),
    },
  };
}

function unsigned(sequence = 42, units: unknown[] = [closure().entry]): Record<string, unknown> {
  return {
    spec: REGISTRY_WIRE_SPEC,
    registryId: "fixture",
    sequence,
    issuedAt: "2026-07-14T00:00:00Z",
    expiresAt: "2026-07-15T00:00:00Z",
    units,
  };
}

function signer() {
  const pair = generateKeyPairSync("ed25519");
  const rawPublic = (pair.publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32);
  const publicKey: RegistryPublicKey = {
    algorithm: "ed25519",
    keyId: "fixture-key-2026",
    value: rawPublic.toString("base64"),
  };
  const signed = (payload: Record<string, unknown>) => ({
    ...payload,
    signature: {
      algorithm: "ed25519",
      keyId: publicKey.keyId,
      value: sign(null, canonicalRegistryPayload(payload), pair.privateKey).toString("base64"),
    },
  });
  return { pair, publicKey, signed };
}

function trust(publicKey: RegistryPublicKey, highWater?: { sequence: number; digest: string }) {
  return {
    expectedRegistryId: "fixture",
    expectedKeyId: publicKey.keyId,
    publicKey,
    now: AT,
    highWater,
  };
}

describe("registry is a signed installation index, not a unit owner", () => {
  it("matches the language-neutral canonical bytes, digest and independent Ed25519 golden", async () => {
    const signed = JSON.parse(readFileSync(join(CORPUS, "registry-signed.json"), "utf8"));
    const publicKey = JSON.parse(readFileSync(join(CORPUS, "registry-public-key.json"), "utf8"));
    const canonical = readFileSync(join(CORPUS, "registry-canonical.json"));
    const expectedSha = readFileSync(join(CORPUS, "registry-canonical.sha256"), "utf8").trim();
    expect(Buffer.from(canonicalRegistryPayload(signed))).toEqual(canonical.subarray(0, -1));
    expect(sha(canonical.subarray(0, -1))).toBe(expectedSha);
    const raw = Buffer.from(publicKey.value, "base64");
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
    const key = createPublicKey({ key: spki, format: "der", type: "spki" });
    expect(verify(null, canonical.subarray(0, -1), key, Buffer.from(signed.signature.value, "base64"))).toBe(true);
    expect((await certifyRegistryIndex(signed, trust(publicKey))).ok).toBe(true);
  });

  it("verifies every static plugin/sidecar/kit owner closure from one authenticated index", async () => {
    const signed = JSON.parse(readFileSync(join(CORPUS, "registry-signed.json"), "utf8"));
    const publicKey = JSON.parse(readFileSync(join(CORPUS, "registry-public-key.json"), "utf8"));
    const certified = await certifyRegistryIndex(signed, trust(publicKey));
    expect(certified.ok).toBe(true);
    if (!certified.ok) return;
    const cases = [
      {
        identity: { kind: "kit" as const, id: "terminal-common", version: "0.0.1" },
        release: "release-kit.json",
        reports: {
          "kit-kind.conformance.json": "conformance-kit-kind.json",
          "kit-release.conformance.json": "conformance-kit-release.json",
        },
      },
      {
        identity: { kind: "plugin" as const, id: "weather-plugin", version: "0.0.1" },
        release: "release-plugin.json",
        reports: {
          "plugin-kind.conformance.json": "conformance-plugin-kind.json",
          "plugin-release.conformance.json": "conformance-plugin-release.json",
        },
      },
      {
        identity: { kind: "sidecar" as const, id: "weather-sidecar", version: "0.0.1" },
        release: "release-sidecar.json",
        reports: {
          "sidecar-interface.conformance.json": "conformance-sidecar-interface.json",
          "sidecar-kind.conformance.json": "conformance-sidecar-kind.json",
          "sidecar-release.conformance.json": "conformance-sidecar-release.json",
        },
      },
    ];
    for (const current of cases) {
      const entry = certified.value.index.units.find((unit) => unit.id === current.identity.id)!;
      const result = await verifyRegistryUnitRelease(
        certified.value,
        current.identity,
        readFileSync(join(CORPUS, current.release)),
        entry.reports.map((reference) => {
          const asset = reference.url.split("/").at(-1)! as keyof typeof current.reports;
          return { url: reference.url, bytes: readFileSync(join(CORPUS, current.reports[asset])) };
        }),
      );
      expect(result.ok, current.identity.id).toBe(true);
    }
  });

  it("indexes flat plugin/sidecar/kit identities with only manifest and report references", () => {
    const { signed } = signer();
    const index = signed(unsigned());
    const parsed = parseSignedRegistryIndex(index);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.units[0]).toEqual(closure().entry);
    for (const copied of ["source", "artifacts", "dependencies", "name", "docs", "commands"]) {
      const dirty = structuredClone(index) as any;
      dirty.units[0][copied] = copied === "artifacts" || copied === "dependencies" ? [] : "copied";
      expect(parseSignedRegistryIndex(dirty).ok, copied).toBe(false);
    }
  });

  it("rejects non-release URLs, namespaced ids, unknown fields, and malformed signature material", () => {
    const { signed, publicKey } = signer();
    const mutations: Array<(value: any) => void> = [
      (value) => { value.units[0].id = "io.github.example/plugin/weather"; },
      (value) => { value.units[0].manifest.url = "https://downloads.example.test/release.json"; },
      (value) => { value.units[0].manifest.url += "?token=x"; },
      (value) => { value.units[0].reports[0].sha256 = "A".repeat(64); },
      (value) => { value.units[0].extra = true; },
      (value) => { value.signature.value = Buffer.alloc(63).toString("base64"); },
    ];
    for (const mutate of mutations) {
      const dirty = signed(unsigned()) as any;
      mutate(dirty);
      expect(parseSignedRegistryIndex(dirty).ok).toBe(false);
    }
    expect(parseRegistryPublicKey(publicKey).ok).toBe(true);

    const equivalent = ["1.0.0+one", "1.0.0+two"].map((version) => ({
      ...structuredClone(closure().entry),
      version,
    }));
    const equivalentIndex = signed(unsigned()) as any;
    equivalentIndex.units = equivalent;
    expect(parseSignedRegistryIndex(equivalentIndex).ok).toBe(false);
  });

  it("certifies signature, expected identity/key and validity in one fail-closed boundary", async () => {
    const { signed, publicKey } = signer();
    const raw = signed(unsigned());
    const certified = await certifyRegistryIndex(raw, trust(publicKey));
    expect(certified.ok).toBe(true);
    if (!certified.ok) return;
    expect(certified.value.continuity).toBe("initial");

    const tampered = structuredClone(raw) as any;
    tampered.units[0].version = "2.1.1";
    expect((await certifyRegistryIndex(tampered, trust(publicKey))).ok).toBe(false);
    expect((await certifyRegistryIndex(raw, { ...trust(publicKey), expectedRegistryId: "other" })).ok).toBe(false);
    expect((await certifyRegistryIndex(raw, { ...trust(publicKey), expectedKeyId: "other-key" })).ok).toBe(false);
    expect((await certifyRegistryIndex(raw, { ...trust(publicKey), now: Date.parse("2026-07-15T00:00:00Z") })).ok).toBe(false);

    const other = signer().publicKey;
    expect((await certifyRegistryIndex(raw, { ...trust(publicKey), publicKey: other })).ok).toBe(false);
  });

  it("snapshots trust policy before asynchronous signature and digest work", async () => {
    const { signed, publicKey } = signer();
    const raw = signed(unsigned(42));
    const mutablePolicy = trust(publicKey, { sequence: 100, digest: "0".repeat(64) });
    const pending = certifyRegistryIndex(raw, mutablePolicy);

    mutablePolicy.now = Date.parse("2026-07-16T00:00:00Z");
    mutablePolicy.highWater!.sequence = 1;

    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ROLLBACK");
  });

  it("distinguishes initial, unchanged, advance, rollback, and equivocation", async () => {
    const { signed, publicKey } = signer();
    const first = await certifyRegistryIndex(signed(unsigned(42)), trust(publicKey));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const highWater = first.value.highWater;

    const unchanged = await certifyRegistryIndex(signed(unsigned(42)), trust(publicKey, highWater));
    expect(unchanged.ok && unchanged.value.continuity).toBe("unchanged");

    const advanced = await certifyRegistryIndex(signed(unsigned(43)), trust(publicKey, highWater));
    expect(advanced.ok && advanced.value.continuity).toBe("advance");

    const rollback = await certifyRegistryIndex(signed(unsigned(41)), trust(publicKey, highWater));
    expect(rollback.ok).toBe(false);
    if (!rollback.ok) expect(rollback.code).toBe("ROLLBACK");

    const changedEntry = structuredClone(closure().entry);
    changedEntry.version = "0.0.2";
    const equivocation = await certifyRegistryIndex(signed(unsigned(42, [changedEntry])), trust(publicKey, highWater));
    expect(equivocation.ok).toBe(false);
    if (!equivocation.ok) expect(equivocation.code).toBe("EQUIVOCATION");
  });

  it("resolves the greatest satisfying dependency only inside the certified origin registry", async () => {
    const { signed, publicKey } = signer();
    const candidates = ["1.2.0", "1.9.0", "2.0.0"].map((version) => ({
      ...structuredClone(closure().entry),
      id: "weather-data",
      version,
    }));
    const certified = await certifyRegistryIndex(signed(unsigned(42, candidates)), trust(publicKey));
    expect(certified.ok).toBe(true);
    if (!certified.ok) return;
    const resolved = resolveRegistryDependency(certified.value, {
      kind: "plugin",
      id: "weather-data",
      range: "^1.0.0",
    });
    expect(resolved.ok && resolved.value.version).toBe("1.9.0");
    expect(resolveRegistryDependency(certified.value, {
      kind: "plugin",
      id: "outside-only",
      range: "*",
    }).ok).toBe(false);
  });

  it("rejects structurally forged certification objects at every trusted boundary", async () => {
    const data = closure();
    const forged = {
      index: unsigned(42, [data.entry]),
      digest: "0".repeat(64),
      continuity: "initial",
      highWater: { sequence: 42, digest: "0".repeat(64) },
    } as any;

    const dependency = resolveRegistryDependency(forged, {
      kind: "plugin",
      id: "weather-plugin",
      range: "*",
    });
    expect(dependency.ok).toBe(false);
    if (!dependency.ok) expect(dependency.errors).toContain("uncertified registry index");

    const release = await verifyRegistryUnitRelease(
      forged,
      { kind: "plugin", id: "weather-plugin", version: "0.0.1" },
      data.manifestBytes,
      data.reports.map(({ url, bytes }) => ({ url, bytes })),
    );
    expect(release.ok).toBe(false);
    if (!release.ok) expect(release.errors).toContain("uncertified registry index");
  });

  it("verifies downloaded owner manifest identity, byte digest, report digests and complete evidence", async () => {
    const data = closure();
    const { signed, publicKey } = signer();
    const certified = await certifyRegistryIndex(signed(unsigned(42, [data.entry])), trust(publicKey));
    expect(certified.ok).toBe(true);
    if (!certified.ok) return;

    const verified = await verifyRegistryUnitRelease(
      certified.value,
      { kind: "plugin", id: "weather-plugin", version: "0.0.1" },
      data.manifestBytes,
      data.reports.map(({ url, bytes }) => ({ url, bytes })),
    );
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(isCertifiedRegistryUnitRelease(verified.value)).toBe(true);
      expect(verified.value.release.dependencies[0]).not.toHaveProperty("registryId");
      expect(verified.value.reports.map((report) => report.contract)).toEqual([
        "soksak-spec-plugin@0.0.1",
        "soksak-spec-release@0.0.1",
      ]);
    }
    expect(isCertifiedRegistryUnitRelease({
      registryId: "fixture",
      entry: data.entry,
      release: pluginRelease(),
      reports: [],
    })).toBe(false);

    const mutableManifest = Uint8Array.from(data.manifestBytes);
    const mutableDownloads = data.reports.map(({ url, bytes }) => ({ url, bytes: Uint8Array.from(bytes) }));
    const pending = verifyRegistryUnitRelease(
      certified.value,
      { kind: "plugin", id: "weather-plugin", version: "0.0.1" },
      mutableManifest,
      mutableDownloads,
    );
    const originalDependency = encoder.encode("terminal-common");
    const attackerDependency = encoder.encode("attacker-common");
    const offset = Buffer.from(mutableManifest).indexOf(Buffer.from(originalDependency));
    expect(offset).toBeGreaterThanOrEqual(0);
    mutableManifest.set(attackerDependency, offset);
    mutableDownloads[0].bytes.fill(0);
    expect((await pending).ok).toBe(true);

    const tamperedManifest = encoder.encode(new TextDecoder().decode(data.manifestBytes).replace('"version": "0.0.1"', '"version": "0.0.2"'));
    expect((await verifyRegistryUnitRelease(
      certified.value,
      { kind: "plugin", id: "weather-plugin", version: "0.0.1" },
      tamperedManifest,
      data.reports.map(({ url, bytes }) => ({ url, bytes })),
    )).ok).toBe(false);

    expect((await verifyRegistryUnitRelease(
      certified.value,
      { kind: "plugin", id: "other-plugin", version: "0.0.1" },
      data.manifestBytes,
      data.reports.map(({ url, bytes }) => ({ url, bytes })),
    )).ok).toBe(false);
  });
});
