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

// The definition of the engine model is itself a surface need — docs/SIDECARS.md §1 states it in that
// table: engine = "renders into pane surfaces (NSView)", in-process dylib.
//
// So making a plugin write `requiresNativeChildWebview: true` by hand again is a second copy. Two
// copies stay quiet until they diverge: measured 2026-07-31, one browser plugin consumed an engine
// sidecar while declaring no need at all, so it loaded as-is on Electron and the screen showed only
// "engine surface creation failed".
//
// Nothing depends on the author remembering. The need is derived from consumption — writing that it
// uses an engine is writing that it needs a surface.
describe("consuming the engine model is itself a surface need", () => {
  const engineManifest = {
    id: "demo",
    permissions: ["sidecar"],
    sidecars: [{ name: "browser-chromium", interface: { id: "soksak-spec-sidecar-browser", range: "0.0.1" } }],
  };

  it("engine sidecar consumption raises the need without a written declaration", async () => {
    const { enforceEngineNeeds } = await import("./engineNeeds");
    expect(() => enforceEngineNeeds(engineManifest as never, ELECTRON)).toThrow(
      /requiresEngineModules/,
    );
  });

  it("loads as-is where that device is present", async () => {
    const { enforceEngineNeeds } = await import("./engineNeeds");
    expect(() => enforceEngineNeeds(engineManifest as never, TAURI_MACOS)).not.toThrow();
  });

  it("the service model (process permission) needs no surface — it is headless", async () => {
    const { enforceEngineNeeds } = await import("./engineNeeds");
    const svc = { ...engineManifest, permissions: ["process"] };
    expect(() => enforceEngineNeeds(svc as never, ELECTRON)).not.toThrow();
  });

  // Measured 2026-07-31: reading a permission as evidence of use is too broad. One measured plugin
  // over-declared the `sidecar` permission while actually being a service model that uses only
  // app.process, and the rule caught it and dropped a headless plugin entirely on Electron.
  //
  // A permission is a door left open, not a footprint. The evidence of the service model is the
  // `service` declaration — the spec already reserves that slot with that meaning
  // (service: { sidecar, interface }).
  it("a declared service is not read as an engine even with the sidecar permission", async () => {
    const { enforceEngineNeeds } = await import("./engineNeeds");
    const both = {
      ...engineManifest,
      permissions: ["sidecar", "process"],
      service: { sidecar: "wf", interface: { id: "soksak-spec-service", range: "0.0.1" } },
    };
    expect(() => enforceEngineNeeds(both as never, ELECTRON)).not.toThrow();
  });
});
