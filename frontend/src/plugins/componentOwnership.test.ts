import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const core = join(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(join(core, path), "utf8");

describe("component ownership standard", () => {
  it("documents direct kinds, the single spec source, settings, and RED discipline", () => {
    const document = read("docs/tech/COMPONENT-OWNERSHIP.md").toLowerCase();
    for (const phrase of [
      "plugin, sidecar, kit, contract, and spec",
      "only source",
      "payloads do not repeat",
      "registry documents keep separate plugins",
      "contracts, and specs arrays",
      "settings.json",
      "installed.json",
      "no install profiles or dependency closure",
      "tests start red",
    ]) expect(document).toContain(phrase);
  });

  it("does not keep embedded copies of public release, registry, or conformance parsers", () => {
    for (const path of [
      "frontend/src/plugins/spec/release.ts",
      "frontend/src/plugins/spec/registry.ts",
      "frontend/src/plugins/spec/conformanceWire.ts",
      "frontend/src/plugins/spec/release-primitives.ts",
    ]) expect(existsSync(join(core, path)), path).toBe(false);
  });

  it("documents canonical sidecar ownership and installed state", () => {
    const document = read("docs/tech/SIDECARS.md");
    expect(document).toContain("soksak-spec");
    expect(document).toContain("installed.json");
    expect(document).not.toContain("composition contract");
    expect(document).not.toContain("release/unit.json");
  });

  it("uses direct pluginId on the plugin install command surface", () => {
    const catalog = read("frontend/src/commands/catalogPlugins.ts");
    expect(catalog).toContain("pluginId");
    expect(catalog).not.toContain(["unit", "Id"].join(""));
  });

  it("names plugins and sidecars directly on public component surfaces", () => {
    const surfaces = [
      "frontend/src/plugins/api.ts",
      "frontend/src/framework/contract.ts",
      "frontend/src/components/PluginManagerModal.tsx",
      "frontend/src/commands/catalogUpdate.ts",
      "frontend/src/commands/catalogDaemon.ts",
      "core/control/envelope.go",
      "core/control/registry.go",
    ];
    for (const path of surfaces) {
      expect(read(path), path).not.toMatch(/\bunits?\b/i);
    }
  });
});
