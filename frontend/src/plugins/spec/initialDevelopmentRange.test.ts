import { describe, expect, it } from "vitest";

import { parseContractRequirement } from "./contracts";
import { initialDevelopmentRangeIsExact } from "./semver";

// A consumer of an unstable contract names one version.
//
// SemVer reserves 0.y.z for initial development and promises nothing across it. A declaration such
// as `>=0.0.1 <0.1.0` therefore asserts an interchangeability the publisher never offered, and the
// assertion does not fail at install — it resolves, and the difference arrives later as behaviour
// no manifest declared.
//
// The rule is written against the shape of the range, never against the version this repository
// happens to be at. Measured 2026-08-20: units here stand at 0.0.1 and 0.0.3 at the same time, so a
// rule naming one of those numbers would already be wrong.
describe("a contract in initial development is consumed at one version", () => {
  it("refuses a range that spans 0.0.x", () => {
    const errors: string[] = [];
    const parsed = parseContractRequirement(
      { id: "soksak-spec-sidecar-terminal", range: ">=0.0.1 <0.1.0" },
      "sidecars[0].interface",
      errors,
    );
    expect(parsed).toBeNull();
    expect(errors.join("\n")).toContain("one exact");
  });

  it("accepts the exact version", () => {
    const errors: string[] = [];
    const parsed = parseContractRequirement(
      { id: "soksak-spec-sidecar-terminal", range: "0.0.3" },
      "sidecars[0].interface",
      errors,
    );
    expect(errors).toEqual([]);
    expect(parsed).toEqual({ id: "soksak-spec-sidecar-terminal", range: "0.0.3" });
  });

  it("refuses an operator that widens a 0.0.x pin", () => {
    for (const range of ["^0.0.3", "~0.0.3", ">=0.0.3", "<0.0.9"]) {
      expect(initialDevelopmentRangeIsExact(range)).toBe(false);
    }
  });

  // Past initial development a minor bump is additive, so the operators mean something again and
  // the rule stops applying. Without this the rule would harden into a ban on ranges as such.
  it("leaves 0.1.0 and later alone", () => {
    for (const range of ["^0.1.0", ">=1.2.0 <2.0.0", "~2.3.4", "*"]) {
      expect(initialDevelopmentRangeIsExact(range)).toBe(true);
    }
  });
});
