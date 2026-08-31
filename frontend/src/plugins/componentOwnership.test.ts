import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const core = join(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(join(core, path), "utf8");

describe("component ownership standard", () => {
  it("documents direct kinds, the single spec source, environment, and RED discipline", () => {
    const document = read("docs/tech/COMPONENT-OWNERSHIP.md").toLowerCase();
    for (const phrase of [
      "plugin, sidecar, kit, contract, and spec",
      "only source",
      "payloads do not repeat",
      "registry documents list current plugin roots",
      "build receipts disclose kit",
      "environment.json",
      "no install profiles or stored closure",
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

  it("documents canonical sidecar ownership and environment discovery", () => {
    const document = read("docs/tech/SIDECARS.md");
    expect(document).toContain("soksak-spec");
    expect(document).toContain("environment.json");
    expect(document).not.toContain("composition contract");
    expect(document).not.toContain("release/unit.json");
  });

  it("keeps the terminal platform plan on direct component names and verified pins", () => {
    const document = read("docs/tech/TERMINAL-PLATFORM-PLAN.md");
    for (const phrase of [
      "## Public components",
      "{ id, requirement }",
      "soksak-spec` advanced to `0.0.2",
      "dd5c0d8c74f37a69a805a24b160472805a97c869",
      "d5f52872e805aa29837dcfe55d6833ae681805d3",
    ]) expect(document).toContain(phrase);
    for (const phrase of [
      "Public units",
      "installed unit",
      "engine units",
      "unit identity",
      "obsolete unit baseline",
    ]) expect(document).not.toContain(phrase);
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
