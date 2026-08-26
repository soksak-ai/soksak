import { describe, expect, it, vi } from "vitest";
import {
  createPluginModuleFramePool,
  loadPluginModule,
  pluginModuleRealmStats,
  pluginModuleSource,
  type PluginModuleRealm,
} from "./pluginModuleRealm";

function realmFixture(evaluate: PluginModuleRealm["evaluate"] = async (code) => ({ code })) {
  const dispose = vi.fn();
  return { realm: { evaluate, dispose }, dispose };
}

describe("plugin module realm lifetime", () => {
  it("reuses a retired frame only after its document reset completes", async () => {
    const frames = [{ id: 1 }, { id: 2 }];
    let finishReset!: () => void;
    const reset = vi.fn(() => new Promise<void>((resolve) => { finishReset = resolve; }));
    const pool = createPluginModuleFramePool(() => frames.shift()!, reset);
    const first = pool.acquire();
    const retiring = pool.release(first);

    const second = pool.acquire();
    expect(second).toEqual({ id: 2 });
    finishReset();
    await retiring;
    expect(pool.acquire()).toBe(first);
    expect(pool.stats()).toEqual({ created: 2, idle: 0, retired: 1, reused: 1 });
  });

  it("reports disposal only after the realm document retires", async () => {
    let finishRetirement!: () => void;
    const retirement = new Promise<void>((resolve) => { finishRetirement = resolve; });
    const realm = {
      evaluate: async (code: string) => ({ code }),
      dispose: () => retirement,
    } as unknown as PluginModuleRealm;
    const before = pluginModuleRealmStats();
    const loaded = await loadPluginModule("export const n = 1", () => realm);
    let finished = false;
    const disposing = Promise.resolve(loaded.dispose()).then(() => { finished = true; });

    await Promise.resolve();
    expect(finished).toBe(false);
    expect(pluginModuleRealmStats().disposed).toBe(before.disposed);
    finishRetirement();
    await disposing;
    expect(pluginModuleRealmStats().disposed).toBe(before.disposed + 1);
  });

  it("binds browser globals to the visible parent document", () => {
    const source = pluginModuleSource("export const value = document.body");

    expect(source).toContain("const window = parent;");
    expect(source).toContain("const document = parent.document;");
    expect(source).toContain("const HTMLElement = parent.HTMLElement;");
    expect(source).toContain("const setTimeout = parent.setTimeout.bind(parent);");
  });

  it("owns one evaluated module until its loaded generation is disposed", async () => {
    const fixture = realmFixture();
    const create = vi.fn(() => fixture.realm);
    const loaded = await loadPluginModule("export const n = 1", create);

    expect(loaded.module).toEqual({ code: "export const n = 1" });
    expect(create).toHaveBeenCalledOnce();
    await loaded.dispose();
    await loaded.dispose();
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
    await one.dispose();
    await two.dispose();

    expect(create).toHaveBeenCalledTimes(2);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.dispose).toHaveBeenCalledOnce();
  });

  it("reports open, created, and disposed generations", async () => {
    const before = pluginModuleRealmStats();
    const fixture = realmFixture();
    const loaded = await loadPluginModule("observed", () => fixture.realm);

    expect(pluginModuleRealmStats()).toEqual({
      open: before.open + 1,
      created: before.created + 1,
      disposed: before.disposed,
      frames: before.frames,
    });
    await loaded.dispose();
    expect(pluginModuleRealmStats()).toEqual({
      open: before.open,
      created: before.created + 1,
      disposed: before.disposed + 1,
      frames: before.frames,
    });
  });
});
