import { describe, expect, it } from "vitest";
import { parseManifest, scanHostChromeViolations, semverSatisfies } from "./spec";

const manifest = () => ({ id: "demo", name: "Demo", version: "0.0.1", appVersionRequirement: "0.0.1", description: "Demo", permissions: [] });

describe("canonical plugin spec facade", () => {
  it("parses the current plugin manifest", () => {
    expect(parseManifest(manifest(), "demo")).toMatchObject({ validation: { ok: true } });
  });
  it("rejects obsolete schema metadata and unbounded requirements", () => {
    expect(parseManifest({ ...manifest(), spec: "soksak-spec-plugin@0.0.1" }, "demo").validation.ok).toBe(false);
    expect(semverSatisfies("0.0.1", "*")).toBeNull();
  });
  it("preserves host chrome ownership checks", () => {
    expect(scanHostChromeViolations(".sidebar-body-tab{height:40px}")).toContain(".sidebar-body-tab");
  });
});
