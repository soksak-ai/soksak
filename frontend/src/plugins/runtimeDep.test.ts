import { describe, expect, it } from "vitest";
import {
  classifyHealth,
  accept,
  nextAction,
  reconcilePlan,
  parseProbeVersion,
  type Observed,
} from "./runtimeDep";
import type { LibraryDep } from "./spec";

// Observation → Health 5-state classification (pure). "present == working" is discarded.
describe("classifyHealth — observation to state", () => {
  const base: Observed = {
    present: true,
    working: true,
    partial: false,
    broken: false,
  };
  it("partial (lib present, bin absent) → PARTIAL (the EEXIST case)", () =>
    expect(classifyHealth({ ...base, partial: true })).toBe("PARTIAL"));
  it("broken(dangling) → BROKEN", () =>
    expect(classifyHealth({ ...base, broken: true })).toBe("BROKEN"));
  it("absent → ABSENT", () =>
    expect(classifyHealth({ ...base, present: false })).toBe("ABSENT"));
  it("present but the probe fails → BROKEN", () =>
    expect(classifyHealth({ ...base, working: false })).toBe("BROKEN"));
  it("version below the minimum → VERSION_MISMATCH", () =>
    expect(classifyHealth({ ...base, version: "1.0.0" }, "2.0.0")).toBe(
      "VERSION_MISMATCH",
    ));
  it("working and the version is met → HEALTHY", () =>
    expect(classifyHealth({ ...base, version: "2.1.0" }, "2.0.0")).toBe(
      "HEALTHY",
    ));
  it("working and no minVersion → HEALTHY", () =>
    expect(classifyHealth(base)).toBe("HEALTHY"));
});

describe("accept — HEALTHY only", () => {
  it("HEALTHY true, everything else false", () => {
    expect(accept("HEALTHY")).toBe(true);
    expect(accept("PARTIAL")).toBe(false);
    expect(accept("VERSION_MISMATCH")).toBe(false);
  });
});

describe("nextAction — the reconcile action per state (pure)", () => {
  it("HEALTHY=noop · ABSENT/VERSION_MISMATCH=reach · PARTIAL/BROKEN=cleanup-then-reach", () => {
    expect(nextAction("HEALTHY")).toBe("noop");
    expect(nextAction("ABSENT")).toBe("reach");
    expect(nextAction("VERSION_MISMATCH")).toBe("reach");
    expect(nextAction("PARTIAL")).toBe("cleanup-then-reach");
    expect(nextAction("BROKEN")).toBe("cleanup-then-reach");
  });
});

// parseProbeVersion — probe stdout → version extraction (pure). observe.versionRe pulls the "actual" version out.
// No versionRe means no extraction (undefined) → no accept.minVersion comparison (classifyHealth ignores minVersion).
describe("parseProbeVersion — version extraction from probe stdout", () => {
  it("no versionRe → undefined (nothing to extract with)", () => {
    expect(parseProbeVersion("v1.2.3", undefined)).toBeUndefined();
  });
  it("capture group 1 wins", () => {
    expect(
      parseProbeVersion("gemini version 2.5.1 (abc)", "version (\\d+\\.\\d+\\.\\d+)"),
    ).toBe("2.5.1");
  });
  it("no capture group → the whole match", () => {
    expect(parseProbeVersion("v1.2.3 build", "\\d+\\.\\d+\\.\\d+")).toBe("1.2.3");
  });
  it("no match → undefined", () => {
    expect(parseProbeVersion("no version here", "\\d+\\.\\d+\\.\\d+")).toBeUndefined();
  });
});

// reconcilePlan — dep + observation (Observed) → reconcile step (pure): action + reach execution kind.
// vendor/fetch reach is part of the decision (the whole 4-tuple, not command/install alone).
describe("reconcilePlan — action plus the reach that performs it", () => {
  const lib = (extra: Partial<LibraryDep> = {}): LibraryDep => ({
    name: "x",
    bin: "x",
    install: { darwin: "npm i -g x" },
    ...extra,
  });
  const obs = (extra: Partial<Observed> = {}): Observed => ({
    present: false,
    working: false,
    partial: false,
    broken: false,
    ...extra,
  });
  it("HEALTHY → noop", () => {
    expect(reconcilePlan(lib(), obs({ present: true, working: true }), "darwin")).toEqual({
      action: "noop",
    });
  });
  it("ABSENT → reach command (the legacy install field)", () => {
    expect(reconcilePlan(lib(), obs(), "darwin")).toEqual({
      action: "reach",
      reach: { kind: "command", command: "npm i -g x" },
    });
  });
  it("PARTIAL → cleanup-then-reach", () => {
    expect(reconcilePlan(lib(), obs({ partial: true }), "darwin")).toEqual({
      action: "cleanup-then-reach",
      reach: { kind: "command", command: "npm i -g x" },
    });
  });
  it("reach.vendor → vendor run (path + sha256)", () => {
    expect(
      reconcilePlan(lib({ reach: { vendor: { path: "p", sha256: "h" } } }), obs(), "darwin"),
    ).toEqual({ action: "reach", reach: { kind: "vendor", vendorPath: "p", sha256: "h" } });
  });
  it("reach.fetch → fetch run (this platform's url + sha256)", () => {
    expect(
      reconcilePlan(
        lib({ reach: { fetch: { url: { darwin: "u" }, sha256: { darwin: "h" } } } }),
        obs(),
        "darwin",
      ),
    ).toEqual({ action: "reach", reach: { kind: "fetch", url: "u", sha256: "h" } });
  });
  it("no supply route for this platform → noop", () => {
    expect(reconcilePlan(lib({ install: { linux: "apt" } }), obs(), "darwin")).toEqual({
      action: "noop",
    });
  });
});
