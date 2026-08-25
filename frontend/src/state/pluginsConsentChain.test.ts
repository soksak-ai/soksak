// Transitive consent chain — enabling studio also requires consent for the dependency core,
// dependency first. Pins the contract that blocks half consent.
import { describe, expect, it } from "vitest";
import {
  consentRequiredMessage,
  consentValid,
  pendingConsentChain,
  type ConsentRecord,
  type PluginRuntime,
} from "./plugins";
import { tmsg } from "../i18n";
import type { PluginManifest } from "../plugins/spec";

function rt(
  id: string,
  permissions: string[],
  dependencies: Record<string, string> = {},
  opts: { source?: "registry" | "local"; version?: string } = {},
): PluginRuntime {
  const manifest = {
    spec: "soksak-spec-plugin@0.0.1",
    id,
    name: id,
    version: opts.version ?? "0.1.0",
    entry: "main.js",
    permissions,
    runtimeDependencies: Object.keys(dependencies).length ? { plugins: Object.entries(dependencies).map(([depId, version]) => ({ id: depId, version: version.replace(/^\^/, ""), url: `https://github.com/example/${depId}/releases/download/v${version.replace(/^\^/, "")}/release.json`, size: 1, sha256: "a".repeat(64) })) } : undefined,
    contributes: {
      views: [], commands: [], formatters: [], languages: [], iconSets: [], programs: [], events: [],
    },
  } as unknown as PluginManifest;
  return { manifest, dir: "", source: opts.source ?? "registry", status: "disabled" } as PluginRuntime;
}

const consent = (version: string, permissions: string[]): ConsentRecord => ({
  version,
  permissions: permissions as ConsentRecord["permissions"],
});

describe("pendingConsentChain — the pending consent chain, dependency first", () => {
  const plugins = {
    "acp-core": rt("acp-core", ["process", "fs:read"]),
    "acp-studio": rt("acp-studio", ["ui", "commands"], { "acp-core": "^0.1.0" }),
  };

  it("neither consented: [core, studio], dependency first", () => {
    expect(pendingConsentChain("acp-studio", plugins, {})).toEqual(["acp-core", "acp-studio"]);
  });

  it("only core consented: [studio] remains", () => {
    const consents = { "acp-core": consent("0.1.0", ["process", "fs:read"]) };
    expect(pendingConsentChain("acp-studio", plugins, consents)).toEqual(["acp-studio"]);
  });

  it("both consented: empty array, activation can proceed", () => {
    const consents = {
      "acp-core": consent("0.1.0", ["process", "fs:read"]),
      "acp-studio": consent("0.1.0", ["ui", "commands"]),
    };
    expect(pendingConsentChain("acp-studio", plugins, consents)).toEqual([]);
  });

  it("changed dependency terms (core gained a permission) put core back in the chain as pending", () => {
    const changed = {
      "acp-core": rt("acp-core", ["process", "fs:read", "network"]), // permission added
      "acp-studio": rt("acp-studio", ["ui", "commands"], { "acp-core": "^0.1.0" }),
    };
    const consents = {
      "acp-core": consent("0.1.0", ["process", "fs:read"]), // old consent, no network
      "acp-studio": consent("0.1.0", ["ui", "commands"]),
    };
    // studio's own consent is valid, but the dependency core needs re-consent, so core is in the chain.
    expect(pendingConsentChain("acp-studio", changed, consents)).toEqual(["acp-core"]);
  });

  it("a local dependency uses the same consent gate", () => {
    const localCore = {
      "acp-core": rt("acp-core", ["process"], {}, { source: "local" }),
      "acp-studio": rt("acp-studio", ["ui"], { "acp-core": "^0.1.0" }),
    };
    expect(pendingConsentChain("acp-studio", localCore, {})).toEqual(["acp-core", "acp-studio"]);
  });

  it("consentRequiredMessage: the only target is itself — plain prose for that consent alone", () => {
    expect(consentRequiredMessage("soksak-plugin-kanban", ["soksak-plugin-kanban"])).toBe(
      tmsg("plugin.consent.required", { id: "soksak-plugin-kanban" }),
    );
  });

  it("consentRequiredMessage: dependencies pending too — lists every consent target in order", () => {
    expect(consentRequiredMessage("acp-studio", ["acp-core", "acp-studio"])).toBe(
      tmsg("plugin.consent.requiredChain", { id: "acp-studio", pending: "acp-core, acp-studio" }),
    );
  });

  it("consentRequiredMessage: self consented and only dependencies remain — the same list form", () => {
    expect(consentRequiredMessage("acp-studio", ["acp-core"])).toBe(
      tmsg("plugin.consent.requiredChain", { id: "acp-studio", pending: "acp-core" }),
    );
  });

  it("consentValid: valid only when both version and permissions match", () => {
    const m = rt("x", ["ui", "commands"]).manifest;
    expect(consentValid(consent("0.1.0", ["ui", "commands"]), m)).toBe(true);
    expect(consentValid(consent("0.1.0", ["commands", "ui"]), m)).toBe(true); // order does not matter
    expect(consentValid(consent("0.2.0", ["ui", "commands"]), m)).toBe(false); // version mismatch
    expect(consentValid(consent("0.1.0", ["ui"]), m)).toBe(false); // permission mismatch
    expect(consentValid(undefined, m)).toBe(false);
  });
});
