import { describe, expect, it } from "vitest";
import { parseRegistryPayload } from "./registry";
import { CORE_SPEC } from "./release-primitives";

// The published index reads.
//
// The core's spec is the core's, and on 2026-08-16 the registry index was made to wear it too. The
// index is published by a repository this build does not write, so the served document still said
// `soksak-spec-registry@0.0.1` and answered `official -> INVALID_INDEX: registry.spec: 0.0.1
// required`. 54 units, no catalogue, and the reason sat in a field nothing read.
//
// Measured against what is served: sequence 7, 54 units, stamped `soksak-spec-registry@0.0.1`.
const PUBLISHED = {
  spec: "soksak-spec-registry@0.0.1",
  registryId: "official",
  sequence: 1,
  issuedAt: "2026-01-01T00:00:00Z",
  expiresAt: "2027-01-01T00:00:00Z",
  units: [],
};

const specErrors = (raw: unknown): string[] => {
  const result = parseRegistryPayload(raw);
  return result.ok ? [] : result.errors.filter((e) => e.includes("spec"));
};

describe("the registry index", () => {
  it("reads the stamp the registry publishes", () => {
    expect(specErrors(PUBLISHED)).toEqual([]);
  });

  it("refuses the core's spec, which stamps no index", () => {
    expect(specErrors({ ...PUBLISHED, spec: CORE_SPEC }).join(" ")).toContain("spec");
  });

  it("carries the document's own stamp into the value the signature is checked over", () => {
    const result = parseRegistryPayload(PUBLISHED);
    expect(result.ok && result.value.spec).toBe(PUBLISHED.spec);
  });
});
