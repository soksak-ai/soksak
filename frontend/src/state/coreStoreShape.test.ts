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
});
