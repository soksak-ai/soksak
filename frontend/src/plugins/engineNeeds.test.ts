// An unmet need blocks loading — a declaration must be an answer.
//
// Measured 2026-07-31: the needs contract (engineNeeds.unmetNeeds) existed and both frameworks had
// filled in their own provision (engineProvision), but nothing compared the two. So a plugin that
// presumes a native child surface loaded as-is on a framework without one, and the screen showed only
// "engine surface creation failed" (captured on Electron).
//
// A contract written down and never read is the same as no contract. But it does not block silently:
// what was missing must stay on the record by name, or the next person investigates it again.
import { describe, expect, it } from "vitest";
import { unmetNeeds } from "./spec";

const ELECTRON = {
  chromium: true,
  nativeChildWebview: false,
  engineModules: false,
  supportsDocumentStart: false,
  supportsInputInjection: true,
};
const TAURI_MACOS = {
  chromium: true,
  nativeChildWebview: true,
  engineModules: true,
  supportsDocumentStart: true,
  supportsInputInjection: false,
};

describe("engine need comparison", () => {
  it("a surface that presumes a child webview reports an unmet need where that device is absent", () => {
    expect(unmetNeeds({ requiresNativeChildWebview: true }, ELECTRON)).toEqual([
      "requiresNativeChildWebview",
    ]);
    expect(unmetNeeds({ requiresNativeChildWebview: true }, TAURI_MACOS)).toEqual([]);
  });

  it("no need loads anywhere — the rule does not catch another surface", () => {
    expect(unmetNeeds({}, ELECTRON)).toEqual([]);
  });
});

describe("the load boundary actually applies that comparison", () => {
  it("activation refuses by name when a need is unmet", async () => {
    const { enforceEngineNeeds } = await import("./engineNeeds");
    expect(() =>
      enforceEngineNeeds(
        { id: "demo", requiresNativeChildWebview: true } as never,
        ELECTRON,
      ),
    ).toThrow(/requiresNativeChildWebview/);
  });

  it("passes where the need is met — a gate that always fails gets turned off", async () => {
    const { enforceEngineNeeds } = await import("./engineNeeds");
    expect(() =>
      enforceEngineNeeds(
        { id: "demo", requiresNativeChildWebview: true } as never,
        TAURI_MACOS,
      ),
    ).not.toThrow();
  });
});

// What a unit is made of is the unit's fact, not a label on its consumer.
//
// This block stated the reverse until 2026-08-20: consuming any sidecar under the `sidecar`
// permission raised a module-loading need. Its reason was measured and real — 2026-07-31, a browser
// plugin consumed a loaded engine while declaring no need, loaded as-is on Electron, and showed
// "engine surface creation failed" on a blank pane.
//
// The rule was still wrong, and SIDECARS.md S3 has the reason: no manifest states which shape a
// unit is.
// A release declares its artefacts — `process[]` spawned, `library[]` loaded — and one unit may
// ship both. Read from the consumer's permission list instead, the answer is the same for a unit
// that is spawned and a unit that is loaded, so every consumer of a spawned unit was refused for a
// requirement it does not have. Measured the same day: the terminal plugin, whose units are all
// spawned, could not be enabled at all.
//
// A sidecar.json declaring a library is refused by the installation resolver when this host cannot
// load one.
describe("a need is declared, never inferred from a permission", () => {
  const spawnedUnits = {
    id: "demo",
    permissions: ["sidecar"],
    sidecars: [{ name: "pty", interface: { id: "soksak-spec-sidecar-pty", version: "0.0.1" } }],
  };

  it("declaring units to spawn raises no loader need anywhere", async () => {
    const { enforceEngineNeeds } = await import("./engineNeeds");
    expect(() => enforceEngineNeeds(spawnedUnits as never, ELECTRON)).not.toThrow();
  });

  it("a written declaration is still honoured", async () => {
    const { enforceEngineNeeds } = await import("./engineNeeds");
    const written = { ...spawnedUnits, requiresEngineModules: true };
    expect(() => enforceEngineNeeds(written as never, ELECTRON)).toThrow(/requiresEngineModules/);
  });

  it("and loads where that device is present", async () => {
    const { enforceEngineNeeds } = await import("./engineNeeds");
    const written = { ...spawnedUnits, requiresEngineModules: true };
    expect(() => enforceEngineNeeds(written as never, TAURI_MACOS)).not.toThrow();
  });
});
