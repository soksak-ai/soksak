import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginManifest } from "@soksak-ai/plugin-spec";
import {
  defineSoksakPlugin,
  derivePluginCommandInventory,
  pluginModuleInventory,
  selectSoksakPluginProvider,
  type PluginCommandOutcome,
  type SoksakPluginModule,
} from "../src/index.js";

describe("plugin-api public isolated-runtime SDK", () => {
  it("derives executable providers without executable icon exports", async () => {
    const outcome: PluginCommandOutcome = {
      ok: true,
      code: "OK",
      message: "refreshed",
      data: { count: 1 },
    };
    const module = defineSoksakPlugin({
      controller: { activate() {} },
      commands: { refresh: async () => outcome },
      views: { main: { mount({ root }) { root.textContent = "main"; } } },
      fileViewers: { code: { mount({ root, context }) { root.textContent = String(context.instance); } } },
      overlays: { mascot: { mount({ root }) { root.textContent = "●"; } } },
    } satisfies SoksakPluginModule);
    expect(await module.commands?.refresh({}, {} as never)).toEqual(outcome);
    expect(pluginModuleInventory(module)).toEqual({
      commands: ["refresh"],
      views: ["main"],
      fileViewers: ["code"],
      overlays: ["mascot"],
    });
    expect(selectSoksakPluginProvider(module, {
      role: "preview",
      previewKind: "view",
      contributionId: "main",
    })).toBe(module.views?.main);
  });

  it("derives runtime-bound and service-bound commands from the real manifest type", () => {
    const commands: PluginManifest["contributes"]["commands"] = [
      { name: "refresh", title: "Refresh" },
      {
        name: "serve",
        title: "Serve",
        bind: "service",
        description: "Serve the unit",
        params: {},
        returns: "object",
      },
    ];
    expect(derivePluginCommandInventory({ commands })).toEqual({
      runtime: ["refresh"],
      service: ["serve"],
    });
  });

  it("exposes only Command Registry execution, not a second domain-operation API", () => {
    const source = readFileSync(join(import.meta.dirname, "../src/index.ts"), "utf8");
    for (const forbidden of [
      "PluginRuntimeOperation",
      "app.call",
      "registerView",
      "registerFileViewer",
      "registerIconSet",
      "commands.register",
      "ManifestCommandDeclarationV1",
      "PluginManifestContributionsV1",
      "readonly iconSets?",
      "ctx.dir",
      "export * from \"./v1.js\"",
      "interface PluginContext",
      "interface SoksakPluginApi",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it("documents the two security boundaries and the unresolved native live gate", () => {
    const readme = readFileSync(join(import.meta.dirname, "../README.md"), "utf8");
    expect(readme).toContain("confidentiality/integrity");
    expect(readme).toContain("availability");
    expect(readme).toContain("dedicated native runtime");
    expect(readme).toContain("third-party plugins stay disabled");
    expect(readme).toContain("Command Registry");
    expect(readme).toContain("preview");
    expect(readme).toContain("logical data asset");
  });
});
