import { describe, expect, it } from "vitest";

import { parseContractRequirement } from "./index";

describe("public contract consumer requirements", () => {
  it("accepts the exact 0.0.1 requirement", () => {
    const errors: string[] = [];
    expect(parseContractRequirement(
      { id: "soksak-spec-sidecar-terminal", requirement: "0.0.1" },
      "sidecars[0].interface",
      errors,
    )).toEqual({ id: "soksak-spec-sidecar-terminal", requirement: "0.0.1" });
    expect(errors).toEqual([]);
  });

  it("rejects provider-shaped and obsolete range fields", () => {
    for (const value of [
      { id: "soksak-spec-sidecar-terminal", version: "0.0.1" },
      { id: "soksak-spec-sidecar-terminal", range: "0.0.1" },
    ]) {
      const errors: string[] = [];
      expect(parseContractRequirement(value, "sidecars[0].interface", errors)).toBeNull();
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it("rejects unbounded and package locator requirements", () => {
    for (const requirement of ["*", "1.x", "latest", "github:owner/repository"]) {
      const errors: string[] = [];
      expect(parseContractRequirement(
        { id: "soksak-spec-sidecar-terminal", requirement },
        "sidecars[0].interface",
        errors,
      )).toBeNull();
      expect(errors.join("\n")).toContain("requirement");
    }
  });
});
