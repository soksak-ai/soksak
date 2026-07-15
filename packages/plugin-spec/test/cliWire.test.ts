import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = join(import.meta.dirname, "..");
const CLI = join(PACKAGE_ROOT, "bin/validate.mjs");
const FIXTURES = join(PACKAGE_ROOT, "test/fixtures/platform-wire");

function run(...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
  });
}

describe("soksak-validate public wire modes", () => {
  it("validates an owner release manifest without the app", () => {
    const result = run("release", join(FIXTURES, "release-plugin.json"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("release-plugin.json");
  });

  it("binds conformance evidence to the exact owner release bytes", () => {
    const valid = run(
      "conformance",
      join(FIXTURES, "conformance-plugin-kind.json"),
      "--release",
      join(FIXTURES, "release-plugin.json"),
      "--plugin-manifest",
      join(FIXTURES, "plugin.json"),
    );
    expect(valid.status, valid.stderr).toBe(0);

    const missingRuntimeProjection = run(
      "conformance",
      join(FIXTURES, "conformance-plugin-kind.json"),
      "--release",
      join(FIXTURES, "release-plugin.json"),
    );
    expect(missingRuntimeProjection.status).toBe(1);

    const wrongOwner = run(
      "conformance",
      join(FIXTURES, "conformance-plugin-kind.json"),
      "--release",
      join(FIXTURES, "release-kit.json"),
      "--plugin-manifest",
      join(FIXTURES, "plugin.json"),
    );
    expect(wrongOwner.status).toBe(1);
  });

  it("certifies a registry only with an explicit trust root and time", () => {
    const valid = run(
      "registry",
      join(FIXTURES, "registry-signed.json"),
      "--public-key",
      join(FIXTURES, "registry-public-key.json"),
      "--registry-id",
      "fixture",
      "--key-id",
      "fixture-2026",
      "--at",
      "2026-07-14T12:00:00Z",
    );
    expect(valid.status, valid.stderr).toBe(0);
    expect(valid.stdout).toContain("sequence=42");

    const noTrustRoot = run("registry", join(FIXTURES, "registry-signed.json"));
    expect(noTrustRoot.status).toBe(2);
  });
});
