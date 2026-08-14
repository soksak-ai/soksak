// Realm declaration axis — the same plugin bundle is evaluated in two realms, and the app surface is not the same.
//
// RED evidence (measured 2026-08-07 · buildId=c437078c, framework=tauri, platform=darwin):
// all 12 browser-chromium-offscreen cells blocked. sentinel status =
//   "plugin activation failed (soksak-plugin-browser-chromium-offscreen):
//    app.commands.register is not a function."
// The plugin body of a nativeSurface view activates once more inside the child renderer, and the app in that
// realm has only commands.execute. Three browser plugins probed this absence with typeof, each differently —
// two passed, one died on the spot. Probing is not the answer.
//
// Contract: a realm declares its own identity and the names callable in that realm. The declaration is derived
// from the actual app object, not written by hand — a hand-written list always misses one.
import { describe, expect, it } from "vitest";
import { declarePluginRealm, pluginRealmCapabilities } from "./realm";

describe("derives capability names from the app object", () => {
  it("lists every nested function as a dotted name", () => {
    const capabilities = pluginRealmCapabilities({
      windowLabel: () => "w-1",
      commands: { execute: async () => {} },
      data: { kv: { get: async () => null, set: async () => {} } },
    });

    expect(capabilities).toEqual([
      "commands.execute",
      "data.kv.get",
      "data.kv.set",
      "windowLabel",
    ]);
  });

  it("a non-function value is not a capability", () => {
    const capabilities = pluginRealmCapabilities({
      appVersion: "1.0.0",
      pluginId: "demo",
      capabilities: ["a", "b"],
      nothing: undefined,
      missing: null,
      commands: { execute: () => {} },
    });

    expect(capabilities).toEqual(["commands.execute"]);
  });

  it("never reads an accessor — enumeration must have no side effect", () => {
    const app: Record<string, unknown> = { commands: { execute: () => {} } };
    let reads = 0;
    Object.defineProperty(app, "trap", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("accessor was read");
      },
    });

    expect(pluginRealmCapabilities(app)).toEqual(["commands.execute"]);
    expect(reads).toBe(0);
  });
});

describe("a realm answers identity and capabilities by declaration", () => {
  it("the child renderer realm reports execute present and register absent", () => {
    const app = declarePluginRealm("view-renderer", {
      commands: { execute: async () => ({ ok: true }) },
      ui: { registerView: () => ({ dispose() {} }) },
    });

    expect(app.realm.id).toBe("view-renderer");
    expect(app.realm.supports("commands.execute")).toBe(true);
    expect(app.realm.supports("ui.registerView")).toBe(true);
    // This one line killed offscreen. The caller can now check before calling.
    expect(app.realm.supports("commands.register")).toBe(false);
  });

  it("check the exact name to call — a present namespace does not mean everything inside it is present", () => {
    const app = declarePluginRealm("view-renderer", {
      commands: { execute: async () => ({ ok: true }) },
    });

    expect(app.realm.supports("commands")).toBe(false);
    expect(app.realm.capabilities).toContain("commands.execute");
  });

  it("realm itself is not in the capability list — it is the answer, not a capability", () => {
    const app = declarePluginRealm("window", { commands: { execute: () => {} } });

    expect(app.realm.capabilities).toEqual(["commands.execute"]);
    expect(app.realm.supports("realm.supports")).toBe(false);
  });

  it("one app has one realm — a second declaration is refused", () => {
    const app = declarePluginRealm("window", { commands: { execute: () => {} } });

    expect(() => declarePluginRealm("view-renderer", app)).toThrow();
    expect(app.realm.id).toBe("window");
  });

  it("the declaration cannot be swapped — the capability list is frozen too", () => {
    const app = declarePluginRealm("window", { commands: { execute: () => {} } });

    expect(Object.isFrozen(app.realm)).toBe(true);
    expect(Object.isFrozen(app.realm.capabilities)).toBe(true);
  });
});
