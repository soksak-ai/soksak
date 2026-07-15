import { describe, expect, it } from "vitest";
import {
  conformanceContractKey,
  parseConformanceReport,
  requiredConformanceContracts,
  verifyConformanceReport,
} from "../src/conformanceWire.js";
import { parseReleaseManifest } from "../src/release.js";
import { pluginRelease, sidecarRelease } from "./releaseFixture.js";

const WEATHER = { id: "soksak-spec-plugin-weather", version: "0.0.1" };

function report(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    spec: "soksak-spec-conformance@0.0.1",
    subject: {
      kind: "plugin",
      id: "weather-plugin",
      version: "0.0.1",
      manifestSha256: "a".repeat(64),
    },
    contract: "soksak-spec-release@0.0.1",
    result: "passed",
    validator: { name: "soksak-conformance", version: "0.0.1" },
    artifacts: [{ target: "any", sha256: "1".repeat(64) }],
    ...over,
  };
}

describe("conformance contract applicability", () => {
  it("keeps exact platform schema ids separate from domain provider evidence", () => {
    expect(parseConformanceReport(report({ contract: "soksak-spec-plugin@0.0.1" })).ok).toBe(true);
    expect(parseConformanceReport(report({ contract: WEATHER })).ok).toBe(true);
    expect(parseConformanceReport(report({ contract: `${WEATHER.id}@0.0.1` })).ok).toBe(false);
  });

  it("accepts domain evidence only when the owner declares that exact provider", () => {
    const release = parseReleaseManifest(pluginRelease());
    const parsed = parseConformanceReport(report({ contract: WEATHER }));
    expect(release.ok && parsed.ok).toBe(true);
    if (!release.ok || !parsed.ok) return;
    expect(verifyConformanceReport(parsed.value, release.value, "a".repeat(64), [WEATHER])).toEqual({ ok: true });
    expect(verifyConformanceReport(parsed.value, release.value, "a".repeat(64), [])).toEqual({
      ok: false,
      errors: ["conformance domain contract is not declared by the owner"],
    });
  });

  it("derives a sidecar provider from its release entrypoint", () => {
    const release = parseReleaseManifest(sidecarRelease());
    expect(release.ok).toBe(true);
    if (!release.ok) return;
    const contract = { id: "soksak-spec-sidecar-weather", version: "0.0.1" };
    const parsed = parseConformanceReport(report({
      subject: { kind: "sidecar", id: "weather-sidecar", version: "0.0.1", manifestSha256: "a".repeat(64) },
      contract,
      artifacts: release.value.artifacts.map(({ target, sha256 }) => ({ target, sha256 })),
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(verifyConformanceReport(parsed.value, release.value, "a".repeat(64))).toEqual({ ok: true });
  });

  it("has collision-free keys for platform and object contracts", () => {
    expect(conformanceContractKey("soksak-spec-release@0.0.1")).toBe("schema\u0000soksak-spec-release@0.0.1");
    expect(conformanceContractKey(WEATHER)).toBe("domain\u0000soksak-spec-plugin-weather\u00000.0.1");
  });
});

describe("common report binding", () => {
  it("requires the release and unit-kind platform schemas", () => {
    expect(requiredConformanceContracts("plugin")).toEqual([
      "soksak-spec-plugin@0.0.1",
      "soksak-spec-release@0.0.1",
    ]);
  });

  it("binds identity, manifest digest and artifact matrix", () => {
    const release = parseReleaseManifest(pluginRelease());
    const parsed = parseConformanceReport(report());
    expect(release.ok && parsed.ok).toBe(true);
    if (!release.ok || !parsed.ok) return;
    expect(verifyConformanceReport(parsed.value, release.value, "a".repeat(64))).toEqual({ ok: true });
    expect(verifyConformanceReport(parsed.value, release.value, "b".repeat(64)).ok).toBe(false);
  });
});
