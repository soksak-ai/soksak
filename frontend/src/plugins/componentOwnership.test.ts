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

  it("uses direct pluginId on the plugin install command surface", () => {
    const catalog = read("frontend/src/commands/catalogPlugins.ts");
    expect(catalog).toContain("pluginId");
    expect(catalog).not.toContain(["unit", "Id"].join(""));
  });
});
