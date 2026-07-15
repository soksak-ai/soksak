import { describe, expect, it } from "vitest";
import { parseManifest, PLUGIN_ID_RE, PROGRAM_PLATFORMS } from "../src/spec.js";
import {
  ANY_TARGET,
  RUST_SIDECAR_TARGETS,
  STRICT_SEMVER_RE,
  UNIT_ID_RE,
  UNIT_KINDS,
  UNIT_TARGETS,
  parseCanonicalGithubReleaseAssetUrl,
  parseCanonicalGithubRepository,
  isSafeRelativeUnitPath,
  isUnitDependencyRange,
} from "../src/unit.js";

describe("public unit identity single source", () => {
  it("uses one flat, third-party-friendly id grammar for plugin, sidecar, and kit", () => {
    expect(UNIT_KINDS).toEqual(["kit", "plugin", "sidecar"]);
    for (const id of ["weather", "third-party-plugin", "soksak-sidecar-browser-chromium"]) {
      expect(UNIT_ID_RE.test(id), id).toBe(true);
    }
    for (const id of ["io.github.example/plugin/weather", "io.github.example", "Bad", "bad_id", "-bad"]) {
      expect(UNIT_ID_RE.test(id), id).toBe(false);
    }
    expect(UNIT_ID_RE.test(`a${"b".repeat(127)}`)).toBe(true);
    expect(UNIT_ID_RE.test(`a${"b".repeat(128)}`)).toBe(false);
    expect(PLUGIN_ID_RE).toBe(UNIT_ID_RE);
  });

  it("defines strict SemVer and dependency ranges once", () => {
    for (const version of ["0.1.0", "1.2.3-alpha.1", "2.0.0+build.7"]) {
      expect(STRICT_SEMVER_RE.test(version), version).toBe(true);
    }
    for (const version of ["01.0.0", "1.02.0", "1.0.0-01", "1.0", "v1.0.0"]) {
      expect(STRICT_SEMVER_RE.test(version), version).toBe(false);
    }
    for (const range of ["*", "1.2.3", "^1.2.3", "~1.2.3", ">=1.0.0 <2.0.0", "=1.2.3-alpha.1"]) {
      expect(isUnitDependencyRange(range), range).toBe(true);
    }
    for (const range of ["latest", "1.x", "^01.0.0", ">=1.0.0 || <2.0.0", ""]) {
      expect(isUnitDependencyRange(range), range).toBe(false);
    }
  });

  it("uses canonical Rust target triples and reserves any for portable artifacts", () => {
    expect(ANY_TARGET).toBe("any");
    expect(UNIT_TARGETS).toContain("aarch64-apple-darwin");
    expect(UNIT_TARGETS).toContain("x86_64-unknown-linux-gnu");
    expect(UNIT_TARGETS).toContain("x86_64-pc-windows-msvc");
    expect(RUST_SIDECAR_TARGETS).not.toContain("any");
    expect(UNIT_TARGETS).not.toContain("darwin-aarch64");
    expect(PROGRAM_PLATFORMS).toEqual(["darwin", "linux", "win32"]);
  });

  it("accepts only explicit lexical relative paths", () => {
    for (const path of ["plugin.json", "bin/weather-service", "lib/libweather.dylib", "package/package.json"]) {
      expect(isSafeRelativeUnitPath(path), path).toBe(true);
    }
    for (const path of [
      "",
      "/tmp/plugin.json",
      "../plugin.json",
      "dist/../plugin.json",
      "dist//plugin.json",
      "C:\\plugin.json",
      "./plugin.json",
      "한글/plugin.json",
      "safe:name/plugin.json",
      "CON/plugin.json",
      "docs/con.txt",
      "trail./plugin.json",
      `a${"b".repeat(512)}`,
      `${"a".repeat(256)}/plugin.json`,
    ]) {
      expect(isSafeRelativeUnitPath(path), path).toBe(false);
    }
  });

  it("accepts exactly one canonical spelling for GitHub repositories and release assets", () => {
    expect(parseCanonicalGithubRepository("https://github.com/example/weather")).toEqual({
      owner: "example",
      repository: "weather",
    });
    for (const value of [
      "https://github.com/example/weather/",
      "https://github.com//example/weather",
      "https://github.com/example//weather",
    ]) {
      expect(parseCanonicalGithubRepository(value), value).toBeNull();
    }

    const asset =
      "https://github.com/example/weather/releases/download/v1.0.0/weather-1.0.0.tgz";
    expect(parseCanonicalGithubReleaseAssetUrl(asset)).toMatchObject({
      owner: "example",
      repository: "weather",
      releaseTag: "v1.0.0",
      asset: "weather-1.0.0.tgz",
    });
    for (const value of [
      `${asset}/`,
      asset.replace("/releases/", "//releases/"),
      asset.replace("/download/", "//download/"),
    ]) {
      expect(parseCanonicalGithubReleaseAssetUrl(value), value).toBeNull();
    }
  });

  it("keeps source identity solely in the owner release manifest", () => {
    const raw = {
      spec: "soksak-spec-plugin@0.0.1",
      id: "weather",
      name: "Weather",
      version: "1.0.0",
      description: "Weather plugin",
      repo: "https://github.com/example/weather",
      permissions: [],
      contributes: {},
    };
    expect(parseManifest(raw, "weather").validation.ok).toBe(false);
  });

  it("uses the exact owner-release dependency range grammar in plugin.json", () => {
    const manifest = (range: string) => ({
      spec: "soksak-spec-plugin@0.0.1",
      id: "weather",
      name: "Weather",
      version: "1.0.0",
      description: "Weather plugin",
      dependencies: { "weather-data": range },
      permissions: [],
      contributes: {},
    });
    expect(parseManifest(manifest(">=1.0.0 <2.0.0"), "weather").validation.ok).toBe(true);
    expect(parseManifest(manifest(" >=1.0.0 <2.0.0"), "weather").validation.ok).toBe(false);
  });

  it("keeps sidecar artifact location solely in the owner release manifest", () => {
    const raw = {
      spec: "soksak-spec-plugin@0.0.1",
      id: "weather",
      name: "Weather",
      version: "1.0.0",
      description: "Weather plugin",
      permissions: ["sidecar"],
      sidecars: [{
        name: "weather-engine",
        interface: { id: "soksak-spec-sidecar-weather", range: ">=0.0.1 <1.0.0" },
        reach: {
          fetch: {
            url: { darwin: "https://example.invalid/weather.tgz" },
            sha256: { darwin: "a".repeat(64) },
          },
        },
      }],
      contributes: {},
    };
    expect(parseManifest(raw, "weather").validation.ok).toBe(false);
  });
});
