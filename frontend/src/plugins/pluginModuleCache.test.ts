import { describe, expect, it, vi } from "vitest";

import { createPluginModuleCache } from "./pluginModuleCache";

describe("plugin module cache", () => {
  it("reuses one module graph for an unchanged plugin bundle", async () => {
    const dispose = vi.fn();
    const load = vi.fn(async () => ({ module: { generation: 1 }, dispose }));
    const cache = createPluginModuleCache();

    const first = await cache.load("demo", "same source", load);
    const second = await cache.load("demo", "same source", load);

    expect(second).toBe(first);
    expect(load).toHaveBeenCalledOnce();
    expect(cache.stats()).toEqual({ open: 1, loaded: 1, reused: 1, replaced: 0, released: 0 });
    await cache.release("demo");
    expect(dispose).toHaveBeenCalledOnce();
    expect(cache.stats()).toEqual({ open: 0, loaded: 1, reused: 1, replaced: 0, released: 1 });
  });

  it("disposes a changed graph before loading its replacement", async () => {
    const order: string[] = [];
    let generation = 0;
    const load = vi.fn(async () => {
      generation += 1;
      const current = generation;
      order.push(`load:${current}`);
      return {
        module: { generation: current },
        dispose: () => { order.push(`dispose:${current}`); },
      };
    });
    const cache = createPluginModuleCache();

    await cache.load("demo", "one", load);
    const replacement = await cache.load("demo", "two", load);

    expect(replacement).toEqual({ generation: 2 });
    expect(order).toEqual(["load:1", "dispose:1", "load:2"]);
    expect(cache.stats()).toEqual({ open: 1, loaded: 2, reused: 0, replaced: 1, released: 0 });
  });

  it("releases modules outside the retained plugin set", async () => {
    const disposed: string[] = [];
    const cache = createPluginModuleCache();
    const load = async (source: string) => ({
      module: source,
      dispose: () => { disposed.push(source); },
    });
    await cache.load("one", "first", load);
    await cache.load("two", "second", load);

    await cache.retain(new Set(["two"]));

    expect(disposed).toEqual(["first"]);
    expect(cache.stats()).toEqual({ open: 1, loaded: 2, reused: 0, replaced: 0, released: 1 });
  });
});
