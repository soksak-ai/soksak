// @vitest-environment jsdom
// A commit that is never answered fails by name instead of locking the observer.
//
// The observer runs one commit at a time: `running` is true for the whole round trip and every
// change made while it is true only marks the inventory dirty. The round trip had no bound, so a
// backend that accepted a delivery and never replied left `running` true for the rest of the
// session — nothing else could ever be delivered, and the reading said `declared 22, committed 21,
// still dirty` with no error, forever.
//
// Measured 2026-08-19, three times in one suite: `ui.layout.wait-settled` failed with exactly those
// numbers, `running` true and `error` null, after 3,750ms.
//
// The bound does not cancel the backend — nothing here can. It names the failure, releases the
// observer for the next delivery, and lets a late receipt be refused by its sequence, which the
// observer already does.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/webviewLabels", () => ({ currentWindowLabel: () => "win-test" }));

let answer: (value: unknown) => void = () => {};
let calls = 0;
vi.mock("../../../bindings/github.com/soksak-ai/wails-service-native-compositor/service", () => ({
  Commit: vi.fn(() => { calls++; return new Promise((resolve) => { answer = resolve; }); }),
  Latest: vi.fn(async () => ({ surfaces: [] })),
}));
vi.mock("../../../bindings/github.com/soksak-ai/wails-service-native-compositor/models", () => ({
  Snapshot: { createFrom: (value: unknown) => value },
}));

import { commitNativeSurfaces, NATIVE_COMMIT_LIMIT_MS } from "./nativeSurfaces";

const snapshot = { window: "win-test", sequence: 4, surfaces: [] };

describe("a commit the backend never answers", () => {
  beforeEach(() => {
    vi.useRealTimers();
    calls = 0;
  });

  it("fails by name after the bound, naming the sequence nobody answered for", async () => {
    vi.useFakeTimers();
    const commit = commitNativeSurfaces(snapshot as never);
    const failure = expect(commit).rejects.toThrow(/sequence 4/);
    await vi.advanceTimersByTimeAsync(NATIVE_COMMIT_LIMIT_MS + 1);
    await failure;
  });

  it("answers the receipt when one arrives in time", async () => {
    const commit = commitNativeSurfaces(snapshot as never);
    answer({ sequence: 4, accepted: true, surfaces: [] });
    await expect(commit).resolves.toMatchObject({ sequence: 4, accepted: true });
  });

  it("has a bound shorter than the wait that reads it", async () => {
    // The barrier that reads this status gives up at its own deadline. A bound longer than that one
    // would never be reached, and the failure would carry the caller's words instead of these.
    expect(NATIVE_COMMIT_LIMIT_MS).toBeGreaterThan(0);
    expect(NATIVE_COMMIT_LIMIT_MS).toBeLessThan(3_750);
  });

  it("delivers interactive geometry without giving the bridge reply ownership of the next frame", async () => {
    const delivered = commitNativeSurfaces({ ...snapshot, interactive: true } as never);
    await expect(delivered).resolves.toMatchObject({ sequence: 4, accepted: true });
    expect(calls).toBe(1);
  });
});
