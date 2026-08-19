// @vitest-environment jsdom
// A preference write that fails is reported, not thrown and not swallowed.
//
// Measured 2026-08-19: `localStorage` was full, the sidebar resize wrote through a React state
// updater, `setItem` threw `QuotaExceededError` during the commit, and the window went blank. The
// other writer in this build caught the same error and said nothing, so a window that had stopped
// remembering anything looked exactly like one that was remembering.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetPreferenceStoreForTest,
  preferenceStoreContents,
  preferenceWriteFailures,
  writePreference,
} from "./preferenceStore";

/** A store that takes writes until it is told to stop. */
function store(full = false) {
  const kept = new Map<string, string>();
  return {
    kept,
    length: 0,
    key: (at: number) => [...kept.keys()][at] ?? null,
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (full) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      kept.set(k, v);
    },
    removeItem: (k: string) => void kept.delete(k),
    clear: () => kept.clear(),
  };
}

describe("writing a preference down", () => {
  beforeEach(() => {
    __resetPreferenceStoreForTest();
  });

  it("says it landed, and it did", () => {
    const s = store();
    vi.stubGlobal("localStorage", s);
    expect(writePreference("leftSidebarW", "300", 1)).toBe(true);
    expect(s.kept.get("leftSidebarW")).toBe("300");
    expect(preferenceWriteFailures()).toEqual([]);
  });

  it("does not throw when the store is full", () => {
    vi.stubGlobal("localStorage", store(true));
    expect(() => writePreference("leftSidebarW", "300", 7)).not.toThrow();
    expect(writePreference("leftSidebarW", "300", 7)).toBe(false);
  });

  it("keeps the failure with its key and its reason", () => {
    vi.stubGlobal("localStorage", store(true));
    writePreference("leftSidebarW", "300", 7);
    const [failure] = preferenceWriteFailures();
    expect(failure.key).toBe("leftSidebarW");
    expect(failure.reason).toContain("quota");
    expect(failure.atUnixMs).toBe(7);
  });

  it("forgets the failure once the same key is written again", () => {
    vi.stubGlobal("localStorage", store(true));
    writePreference("leftSidebarW", "300", 7);
    vi.stubGlobal("localStorage", store());
    writePreference("leftSidebarW", "300", 9);
    expect(preferenceWriteFailures()).toEqual([]);
  });
});

describe("what the window has written", () => {
  it("names every key in the store with its size, biggest first", () => {
    const s = store();
    s.kept.set("small", "ab");
    s.kept.set("big", "x".repeat(50));
    // A key this build never writes still spends the quota, so the reading is of the store rather
    // than of a list of our own keys.
    s.kept.set("left-by-an-older-build", "y".repeat(10));
    s.length = 3;
    vi.stubGlobal("localStorage", s);

    const contents = preferenceStoreContents();
    expect(contents.keys.map((k) => k.key)).toEqual([
      "big",
      "left-by-an-older-build",
      "small",
    ]);
    expect(contents.totalChars).toBe(62);
  });
});
