import { describe, expect, it, vi } from "vitest";
import { loadPluginModule, type PluginModuleRealm } from "./pluginModuleRealm";

function realmFixture(evaluate: PluginModuleRealm["evaluate"] = async (code) => ({ code })) {
  const dispose = vi.fn();
  return { realm: { evaluate, dispose }, dispose };
}

describe("plugin module realm lifetime", () => {
  it("owns one evaluated module until its loaded generation is disposed", async () => {
    const fixture = realmFixture();
    const create = vi.fn(() => fixture.realm);
    const loaded = await loadPluginModule("export const n = 1", create);

    expect(loaded.module).toEqual({ code: "export const n = 1" });
    expect(create).toHaveBeenCalledOnce();
    loaded.dispose();
    loaded.dispose();
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it("disposes a realm whose module evaluation fails", async () => {
    const fixture = realmFixture(async () => { throw new Error("broken module"); });

    await expect(loadPluginModule("broken", () => fixture.realm)).rejects.toThrow("broken module");
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it("creates a fresh disposable realm for the same source on every generation", async () => {
    const first = realmFixture();
    const second = realmFixture();
    const realms = [first.realm, second.realm];
    const create = vi.fn(() => realms.shift()!);

    const one = await loadPluginModule("same", create);
    const two = await loadPluginModule("same", create);
    one.dispose();
    two.dispose();

    expect(create).toHaveBeenCalledTimes(2);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.dispose).toHaveBeenCalledOnce();
  });
});
