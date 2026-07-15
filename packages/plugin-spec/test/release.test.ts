import { describe, expect, it } from "vitest";
import {
  parseReleaseManifest,
  verifyPluginRuntimeDependencyProjection,
} from "../src/release.js";
import { kitRelease, pluginRelease, sidecarRelease } from "./releaseFixture.js";

describe("unit-owner release manifest", () => {
  it("accepts explicit plugin, sidecar, and kit entrypoint layouts", () => {
    expect(parseReleaseManifest(pluginRelease()).ok).toBe(true);
    expect(parseReleaseManifest(sidecarRelease()).ok).toBe(true);
    expect(parseReleaseManifest(kitRelease()).ok).toBe(true);
  });

  it("keeps dependencies generic and same-registry by omitting registry selection", () => {
    const parsed = parseReleaseManifest(pluginRelease());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.dependencies).toEqual([{ kind: "kit", id: "terminal-common", range: ">=0.0.1 <1.0.0" }]);
    expect(parsed.value.dependencies[0]).not.toHaveProperty("registryId");
  });

  it("requires the release plugin closure to equal runtime plugin authorization", () => {
    const raw = pluginRelease();
    (raw.dependencies as any[]).push({ kind: "plugin", id: "weather-data", range: ">=0.0.1 <1.0.0" });
    const parsed = parseReleaseManifest(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(verifyPluginRuntimeDependencyProjection({ "weather-data": ">=0.0.1 <1.0.0" }, parsed.value)).toEqual({ ok: true });
    expect(verifyPluginRuntimeDependencyProjection({}, parsed.value).ok).toBe(false);
    expect(verifyPluginRuntimeDependencyProjection({ "weather-data": "=0.0.1" }, parsed.value).ok).toBe(false);
    expect(verifyPluginRuntimeDependencyProjection({
      "weather-data": ">=0.0.1 <1.0.0",
      "weather-extra": "*",
    }, parsed.value).ok).toBe(false);
  });

  it("requires portable plugin/kit artifacts and canonical Rust sidecar target triples", () => {
    const pluginSpecific = pluginRelease();
    (pluginSpecific.artifacts as any[])[0].target = "aarch64-apple-darwin";
    expect(parseReleaseManifest(pluginSpecific).ok).toBe(false);

    const kitSpecific = kitRelease();
    (kitSpecific.artifacts as any[])[0].target = "x86_64-unknown-linux-gnu";
    expect(parseReleaseManifest(kitSpecific).ok).toBe(false);

    const sidecarAny = sidecarRelease();
    (sidecarAny.artifacts as any[])[0].target = "any";
    expect(parseReleaseManifest(sidecarAny).ok).toBe(false);

    const legacyTarget = sidecarRelease();
    (legacyTarget.artifacts as any[])[0].target = "darwin-aarch64";
    expect(parseReleaseManifest(legacyTarget).ok).toBe(false);

    const unsupportedZip = pluginRelease();
    (unsupportedZip.artifacts as any[])[0].format = "zip";
    (unsupportedZip.artifacts as any[])[0].url =
      "https://github.com/example/weather-plugin/releases/download/v0.0.1/weather-plugin-0.0.1.zip";
    expect(parseReleaseManifest(unsupportedZip).ok).toBe(false);
  });

  it("binds every artifact URL to the source GitHub repository and exact release tag", () => {
    for (const url of [
      "https://downloads.example.test/weather.tgz",
      "https://github.com/attacker/weather-plugin/releases/download/v0.0.1/weather.tgz",
      "https://github.com/example/weather-plugin/releases/download/latest/weather.tgz",
      "https://github.com/example/weather-plugin/releases/download/v0.0.2/weather.tgz",
      "https://github.com/example/weather-plugin/releases/download/v0.0.1/%77eather-plugin-0.0.1.tgz",
    ]) {
      const dirty = pluginRelease();
      (dirty.artifacts as any[])[0].url = url;
      expect(parseReleaseManifest(dirty).ok, url).toBe(false);
    }
  });

  it("requires an exact release tag derived from id and version", () => {
    expect(parseReleaseManifest(pluginRelease({ releaseTag: "main" })).ok).toBe(false);
    expect(parseReleaseManifest(pluginRelease({ releaseTag: "weather-v0.0.1" })).ok).toBe(false);
    const fullTag = pluginRelease({ releaseTag: "weather-plugin-v0.0.1" });
    (fullTag.artifacts as any[])[0].url =
      "https://github.com/example/weather-plugin/releases/download/weather-plugin-v0.0.1/weather-plugin-0.0.1.tgz";
    expect(parseReleaseManifest(fullTag).ok).toBe(true);
  });

  it("rejects guessed/default or traversal entrypoints and duplicate names", () => {
    const noManifest = pluginRelease();
    (noManifest.artifacts as any[])[0].entrypoint = { kind: "plugin" };
    expect(parseReleaseManifest(noManifest).ok).toBe(false);

    const traversal = kitRelease();
    (traversal.artifacts as any[])[0].entrypoint.packageManifest = "../package.json";
    expect(parseReleaseManifest(traversal).ok).toBe(false);

    const duplicate = sidecarRelease();
    (duplicate.artifacts as any[])[0].entrypoint.library[0].name = "weather-service";
    expect(parseReleaseManifest(duplicate).ok).toBe(false);

    const emptySidecar = sidecarRelease();
    (emptySidecar.artifacts as any[])[0].entrypoint = {
      kind: "sidecar",
      interface: { id: "soksak-spec-sidecar-weather", version: "0.0.1" },
    };
    expect(parseReleaseManifest(emptySidecar).ok).toBe(false);

    const splitInterface = sidecarRelease();
    (splitInterface.artifacts as any[])[1].entrypoint.interface = { id: "soksak-spec-sidecar-other", version: "0.0.1" };
    expect(parseReleaseManifest(splitInterface).ok).toBe(false);
  });

  it("rejects unknown fields, duplicate dependencies, and unsorted matrices", () => {
    const copiedDocs = pluginRelease({ docs: "README.md" });
    expect(parseReleaseManifest(copiedDocs).ok).toBe(false);

    const duplicateDependency = pluginRelease();
    (duplicateDependency.dependencies as any[]).push({ kind: "kit", id: "terminal-common", range: "*" });
    expect(parseReleaseManifest(duplicateDependency).ok).toBe(false);

    const unsorted = sidecarRelease();
    (unsorted.artifacts as any[]).reverse();
    expect(parseReleaseManifest(unsorted).ok).toBe(false);
  });
});
