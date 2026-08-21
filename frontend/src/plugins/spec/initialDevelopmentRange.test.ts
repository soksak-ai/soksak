import { describe, expect, it } from "vitest";

import { parseContractRequirement } from "./contracts";

// Contract compatibility is not inferred. Providers and consumers name the version they tested.
describe("a public contract reference names one exact version", () => {
  it("refuses a range field even when it contains one exact version", () => {
    const errors: string[] = [];
    const parsed = parseContractRequirement(
      { id: "soksak-spec-sidecar-terminal", range: "0.0.1" },
      "sidecars[0].interface",
      errors,
    );
    expect(parsed).toBeNull();
    expect(errors.join("\n")).toContain("version");
  });

  it("accepts the exact version", () => {
    const errors: string[] = [];
    const parsed = parseContractRequirement(
      { id: "soksak-spec-sidecar-terminal", version: "0.0.1" },
      "sidecars[0].interface",
      errors,
    );
    expect(errors).toEqual([]);
    expect(parsed).toEqual({ id: "soksak-spec-sidecar-terminal", version: "0.0.1" });
  });

  it("refuses a compatibility range at every version", () => {
    for (const range of ["^0.0.1", ">=0.1.0 <1.0.0", "~2.3.4", "*"]) {
      const errors: string[] = [];
      expect(parseContractRequirement(
        { id: "terminal-session", range },
        "consumes[0]",
        errors,
      )).toBeNull();
      expect(errors.join("\n")).toContain("version");
    }
  });
});
