// Consent summary — fixes the contract for listing dependency plugin permissions transitively
// (no half consent: a dependency's permissions also appear on the consent screen).
import { describe, expect, it } from "vitest";
import { consentSummary } from "./consentSummary";
import type { PluginManifest } from "./spec";
import type { PluginRuntime } from "../state/plugins";

function mani(
  id: string,
  permissions: string[],
  dependencies: Record<string, string> = {},
  version = "0.1.0",
): PluginManifest {
  return {
    spec: "soksak-spec-plugin@0.0.1",
    id,
    name: id,
    version,
    entry: "main.js",
    permissions: permissions as PluginManifest["permissions"],
    runtimeDependencies: Object.keys(dependencies).length ? { plugins: Object.entries(dependencies).map(([depId, depVersion]) => ({ id: depId, version: depVersion.replace(/^\^/, ""), url: `https://github.com/example/${depId}/releases/download/v${depVersion.replace(/^\^/, "")}/release.json`, size: 1, sha256: "a".repeat(64) })) } : undefined,
    contributes: {
      views: [],
      commands: [],
      formatters: [],
      languages: [],
      iconSets: [],
      nodes: [],
      programs: [],
      events: [],
    },
  } as unknown as PluginManifest;
}

function rt(manifest: PluginManifest): PluginRuntime {
  return { manifest, dir: "", source: "registry", status: "disabled" } as PluginRuntime;
}

describe("consentSummary — transitive dependency permissions", () => {
  it("the studio consent summary lists the dependency core's permissions too", () => {
    const core = mani("acp-core", ["process", "fs:read"]);
    const studio = mani("acp-studio", ["ui", "commands"], { "acp-core": "^0.1.0" });
    const installed = { "acp-core": rt(core), "acp-studio": rt(studio) };

    const s = consentSummary(studio, installed);
    expect(s.dependencies.plugins).toHaveLength(1);
    const dep = s.dependencies.plugins[0];
    expect(dep.id).toBe("acp-core");
    expect(dep.requiredVersion).toBe("0.1.0");
    expect(dep.permissions).toEqual(["process", "fs:read"]); // the dependency's permissions are shown
    expect(dep.installedVersion).toBe("0.1.0");
  });

  it("permissions of a transitive dependency (addon→lounge→core) are collected as well", () => {
    const core = mani("core", ["process"]);
    const lounge = mani("lounge", ["ui"], { core: "^0.1.0" });
    const addon = mani("addon", ["commands"], { lounge: "^0.1.0" });
    const installed = { core: rt(core), lounge: rt(lounge), addon: rt(addon) };

    const ids = consentSummary(addon, installed).dependencies.plugins.map((p) => p.id);
    expect(new Set(ids)).toEqual(new Set(["lounge", "core"])); // direct and transitive both
    const coreDep = consentSummary(addon, installed).dependencies.plugins.find((p) => p.id === "core");
    expect(coreDep?.permissions).toEqual(["process"]);
    expect(coreDep?.transitive).toBe(true); // core is a transitive dependency of addon
  });

  it("a dependency that is not installed is listed with unknown permissions (consent after install)", () => {
    const studio = mani("acp-studio", ["ui"], { "acp-core": "^0.1.0" });
    const installed = { "acp-studio": rt(studio) }; // core is not installed
    const dep = consentSummary(studio, installed).dependencies.plugins[0];
    expect(dep.id).toBe("acp-core");
    expect(dep.permissions).toBeUndefined();
  });

  it("no dependencies → plugins is empty", () => {
    const solo = mani("solo", ["ui"]);
    expect(consentSummary(solo, { solo: rt(solo) }).dependencies.plugins).toEqual([]);
  });

  it("a dangerous command appears in the consent summary by name and kind (U4)", () => {
    const m = mani("danger-demo", ["commands", "commands:destructive", "commands:inject"]);
    m.contributes.commands = [
      { name: "wipe", title: "Wipe", danger: "destructive" },
      { name: "send", title: "Send", danger: "inject" },
      { name: "list", title: "List" }, // not dangerous — excluded
    ] as PluginManifest["contributes"]["commands"];
    const s = consentSummary(m, { "danger-demo": rt(m) });
    expect(s.dangerousCommands).toEqual([
      { name: "wipe", danger: "destructive" },
      { name: "send", danger: "inject" },
    ]);
  });
});

describe("consentSummary — exposed DOM nodes (consent screen)", () => {
  it("contributes.nodes becomes exposedNodes (id, description, danger)", () => {
    const m = mani("p", ["ui"]);
    (m.contributes as { nodes: unknown[] }).nodes = [
      { id: "submit", description: { ko: "submit-ko", en: "Submit" } },
      { id: "msg", description: "message row" },
      { id: "wipe", danger: true },
    ];
    const ex = consentSummary(m, { p: rt(m) }).exposedNodes;
    expect(ex.map((n) => n.id)).toEqual(["submit", "msg", "wipe"]);
    expect(ex[2].danger).toBe(true);
    expect(ex[0].description).toEqual({ ko: "submit-ko", en: "Submit" });
  });
  it("no exposed nodes → an empty array", () => {
    const m = mani("p", ["ui"]);
    expect(consentSummary(m, { p: rt(m) }).exposedNodes).toEqual([]);
  });
});
