// @vitest-environment jsdom
// A window that closed does not keep its boot cache forever.
//
// Each window writes its whole snapshot — workspaces, spaces, panes, tabs — under
// `soksak.window.<label>`, as the synchronous cache boot reads before the core answers. Nothing
// ever removed one. A label names one window and no other, so every window ever opened left an entry.
//
// Measured 2026-08-19 on the installation this build runs against: 3,442 cache entries for 2 live
// windows, 2,579,554 characters of the 2,580,350 in the store, against a quota of about 2.5 million.
// The authority held four window snapshots and fifteen keys in total — the leak was the cache alone.
// The store had been full long enough that `soksak.windows`, the manifest itself, was not in it: the
// cache had stopped taking writes and every boot read a store that could no longer be updated.
//
// The manifest is the authority for which windows exist. A cache entry for a label it does not name
// can never be read again, so it is only spending the quota.
import { describe, expect, it } from "vitest";
import { staleWindowCacheKeys, windowCacheKey } from "./windowCacheSweep";

const manifest = (...labels: string[]) => ({
  slots: labels.map((label) => ({ label, roots: ["<local-evidence>/w"], activeRoot: "<local-evidence>/w" })),
});

describe("which window caches are dead", () => {
  it("names the caches of labels the manifest does not hold", () => {
    const keys = [
      "soksak.window.win-alive",
      "soksak.window.win-gone",
      "soksak.window.win-also-gone",
    ];
    expect(staleWindowCacheKeys(keys, manifest("win-alive"))).toEqual([
      "soksak.window.win-gone",
      "soksak.window.win-also-gone",
    ]);
  });

  it("keeps a cache the manifest still holds", () => {
    // Removing one is losing that window: restore reads the slot from the manifest and the snapshot
    // from here, and a slot with no snapshot is a window that never opens again.
    expect(staleWindowCacheKeys(["soksak.window.win-alive"], manifest("win-alive"))).toEqual([]);
  });

  it("touches nothing that is not a window cache", () => {
    const keys = ["soksak.windows", "soksak.theme", "railW", "soksak.window.win-gone"];
    expect(staleWindowCacheKeys(keys, manifest())).toEqual(["soksak.window.win-gone"]);
  });

  it("names the key one window writes, the same way the sweep reads it", () => {
    // The write and the sweep name the key from one function. Spelled twice, a closed window's
    // cache survives the day one of the two is edited.
    expect(windowCacheKey("win-alive")).toBe("soksak.window.win-alive");
    expect(staleWindowCacheKeys([windowCacheKey("win-gone")], manifest())).toEqual([
      windowCacheKey("win-gone"),
    ]);
  });

  it("removes nothing when the manifest cannot be read", () => {
    // A manifest of the wrong shape is the state this file already refuses to guess at: read as
    // "no slots", it would sweep every window in the installation on one bad boot.
    expect(staleWindowCacheKeys(["soksak.window.win-alive"], null)).toEqual([]);
    expect(
      staleWindowCacheKeys(["soksak.window.win-alive"], { slots: "not a list" } as never),
    ).toEqual([]);
  });
});
