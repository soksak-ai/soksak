// @vitest-environment jsdom
// The boot cache is one installation's, and is never adopted by another.
//
// The cache is a copy of the authority — `app.data` on this home's store — kept
// so the first frame is not empty. A copy with no original here is not a faster
// answer: it is a different installation's data.
//
// Measured 2026-08-16. `SOKSAK_IDENTIFIER` and `HOME` give one binary two
// isolated homes, and the store under each is its own SQLite file. The web view's
// localStorage is not: the origin is the same, so both homes read one cache. A
// second home booted with an empty authority, fell through to that cache, and
// wrote another installation's window ledger into its own store — its `windows`
// key came back byte-identical to the first home's, naming three windows that
// home had never opened.
//
// The fall-through was there to carry a cache written by an older build into
// `app.data` once. AGENTS 4-3 has no migrations, and this one was the way in.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeCoreStore, onBootCacheDiscarded } from "./coreStore";

const LEDGER = { slots: [{ label: "win-3ztbjd", roots: ["/elsewhere"] }] };
const EMPTY = { slots: [] as unknown[] };

function storeWith(remote: unknown) {
  const invoke = vi.fn(async (command: string) => {
    if (command === "data_kv_get") return remote;
    return null;
  });
  return {
    invoke,
    store: makeCoreStore<typeof EMPTY>({
      key: "windows",
      lsKey: "soksak.windows",
      fallback: EMPTY,
      invoke: invoke as never,
      onDataChange: () => () => {},
      localStorage: sharedOrigin,
    }),
  };
}

// The one origin two homes share. A real Storage is not needed: what is under
// test is whether an empty authority reads it at all.
const cache = new Map<string, string>();

beforeEach(() => {
  // Discards are queued until a sink is registered, so an earlier test's report
  // would arrive in a later one's list. Draining here leaves each test reading
  // only what it caused.
  onBootCacheDiscarded(() => {});
  cache.clear();
  // The cache another installation left behind on this origin.
  cache.set("soksak.windows", JSON.stringify(LEDGER));
});

// The store takes its cache as a dependency, so the origin two homes share is
// handed in rather than read off a global.
const sharedOrigin = {
  getItem: (key: string) => cache.get(key) ?? null,
  setItem: (key: string, value: string) => void cache.set(key, value),
  removeItem: (key: string) => void cache.delete(key),
};

describe("an authority that holds nothing", () => {
  it("answers the fallback rather than the cache", async () => {
    const { store } = storeWith(null);
    await expect(store.hydrate()).resolves.toEqual(EMPTY);
  });

  it("writes nothing into its own store", async () => {
    const { invoke, store } = storeWith(null);
    await store.hydrate();
    const written = invoke.mock.calls.filter(([command]) => command === "data_kv_set");
    expect(written, "an empty authority adopted a cache it did not write").toEqual([]);
  });
});

// The cache still does its job where there is an original. This is the case it
// exists for: the authority has the value, and the cache spares the first frame
// from waiting on it.
it("keeps serving the cache where the authority has the value", async () => {
  const { store } = storeWith(LEDGER);
  await expect(store.hydrate()).resolves.toEqual(LEDGER);
  expect(store.loadSync()).toEqual(LEDGER);
});

// A cache with content the authority does not have is a contradiction, and is
// reported rather than quietly resolved.
//
// The cache is a copy of the authority. A copy standing where there is no
// original means one of two things, and both are defects: this home's store lost
// the value, or the cache was written by another installation on the same origin.
// Answering the fallback and saying nothing hides them equally.
//
// The channel already exists — onBootCacheDiscarded, which boot stamps as a boot
// fact readable from outside with `sok activity_recent`. Substituting the
// fallback silently would make "there was nothing" and "there is something that
// cannot be here" one answer, and those are fixed in different places.
it("reports the cache it refused, and clears it", async () => {
  const reported: Array<[string, string]> = [];
  onBootCacheDiscarded((lsKey, why) => reported.push([lsKey, why]));
  const { store } = storeWith(null);
  await expect(store.hydrate()).resolves.toEqual(EMPTY);

  expect(reported).toEqual([["soksak.windows", "no-authority"]]);
  // Cleared, so the next boot on this home is a first run rather than the same
  // contradiction reported again for ever.
  expect(cache.get("soksak.windows")).toBeUndefined();
});

// A first run has no contradiction to report. The cache is empty because nothing
// has been written yet, and a report there would be noise on every fresh install.
it("says nothing when there is no cache either", async () => {
  const reported: Array<[string, string]> = [];
  onBootCacheDiscarded((lsKey, why) => reported.push([lsKey, why]));
  cache.clear();

  const { store } = storeWith(null);
  await expect(store.hydrate()).resolves.toEqual(EMPTY);
  expect(reported).toEqual([]);
});
