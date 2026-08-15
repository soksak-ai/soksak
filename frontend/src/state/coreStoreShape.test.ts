import { describe, expect, it } from "vitest";

import { makeCoreStore } from "./coreStore";

function storage(entries: Record<string, string>) {
  return {
    getItem: (key: string) => entries[key] ?? null,
    setItem: (key: string, value: string) => { entries[key] = value; },
  };
}

const deps = {
  invoke: async () => null,
  onDataChange: () => () => {},
};

describe("core store cache", () => {
  it("returns the cached value when its shape matches the fallback", () => {
    const store = makeCoreStore<string[]>({
      ...deps,
      localStorage: storage({ "soksak.recent": `["/a"]` }),
      key: "recent",
      lsKey: "soksak.recent",
      fallback: [],
    });

    expect(store.loadSync()).toEqual(["/a"]);
  });

  it("falls back when the cache holds the wrong shape", () => {
    // The cache lives on the webview origin, not in our store, so another build
    // sharing that origin can leave a value of a different shape behind.
    // Measured 2026-08-15: `soksak.recentProjects` held `{}` where an array was
    // expected, and the first render died on `recentAll.filter is not a
    // function` — the shape was never checked, only the parse.
    const store = makeCoreStore<string[]>({
      ...deps,
      localStorage: storage({ "soksak.recent": `{}` }),
      key: "recent",
      lsKey: "soksak.recent",
      fallback: [],
    });

    expect(store.loadSync()).toEqual([]);
  });

  it("falls back when an object fallback meets a cached array", () => {
    const store = makeCoreStore<Record<string, number>>({
      ...deps,
      localStorage: storage({ "soksak.counts": `[1,2]` }),
      key: "counts",
      lsKey: "soksak.counts",
      fallback: {},
    });

    expect(store.loadSync()).toEqual({});
  });

  it("falls back on unparseable cache", () => {
    const store = makeCoreStore<string[]>({
      ...deps,
      localStorage: storage({ "soksak.recent": `not json` }),
      key: "recent",
      lsKey: "soksak.recent",
      fallback: [],
    });

    expect(store.loadSync()).toEqual([]);
  });

  it("keeps a primitive cache whose type matches", () => {
    const store = makeCoreStore<number>({
      ...deps,
      localStorage: storage({ "soksak.zoom": `1.5` }),
      key: "zoom",
      lsKey: "soksak.zoom",
      fallback: 1,
    });

    expect(store.loadSync()).toBe(1.5);
  });

  it("an object missing the fallback's own keys is not that shape", () => {
    // "It is an object" is not a shape. A window manifest is {slots: []}, and a
    // bare {} passes an is-it-an-object check while `.slots` is undefined —
    // which reaches the consumer as `e.slots.filter is not a function`.
    //
    // Measured 2026-08-15, all three from one boot of this build:
    //   respawn:error  undefined is not an object (evaluating 'e.slots.filter')
    //   restore:error  undefined is not an object (evaluating 'e.projects.length')
    //   renderer.error undefined is not an object (evaluating 't.map')
    const store = makeCoreStore<{ slots: string[] }>({
      ...deps,
      localStorage: storage({ "soksak.windows": `{}` }),
      key: "windows",
      lsKey: "soksak.windows",
      fallback: { slots: [] },
    });

    expect(store.loadSync()).toEqual({ slots: [] });
  });

  it("a key present with the wrong kind is not that shape", () => {
    // The key exists and holds the wrong thing, which is worse than missing:
    // the consumer reaches it and calls a method that is not there.
    const store = makeCoreStore<{ slots: string[] }>({
      ...deps,
      localStorage: storage({ "soksak.windows": `{"slots":"nope"}` }),
      key: "windows",
      lsKey: "soksak.windows",
      fallback: { slots: [] },
    });

    expect(store.loadSync()).toEqual({ slots: [] });
  });

  it("extra keys are not a mismatch", () => {
    // A newer build that added a field must still be readable by this one.
    // Refusing here would discard the user's real state over a field nobody
    // asked about.
    const store = makeCoreStore<{ slots: string[] }>({
      ...deps,
      localStorage: storage({ "soksak.windows": `{"slots":["a"],"focused":"win-1"}` }),
      key: "windows",
      lsKey: "soksak.windows",
      fallback: { slots: [] },
    });

    expect(store.loadSync()).toEqual({ slots: ["a"], focused: "win-1" });
  });

  it("null in an optional slot is kept when the fallback declares null", () => {
    // A fallback of null declares "anything, including nothing" — the store
    // cannot know that shape and must not invent one.
    const store = makeCoreStore<{ x: number } | null>({
      ...deps,
      localStorage: storage({ "soksak.frame": `{"x":1}` }),
      key: "frame",
      lsKey: "soksak.frame",
      fallback: null,
    });

    expect(store.loadSync()).toEqual({ x: 1 });
  });
});
