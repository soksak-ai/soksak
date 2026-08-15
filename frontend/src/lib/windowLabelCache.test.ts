import { describe, it, expect, vi } from "vitest";

// The label resolves asynchronously during boot, but module top-level code runs before that. If the
// cache freezes "not yet" into a value, that window has no name forever, and that one name is the
// orchestrator/workspace branch.
//
// Measured 2026-08-15: the main window drew the workspace shell even after logging window-name:main.
// The cause was one call before resolution caching "", and every later call getting that "".
let label = "";
// Spread the real module and replace this one axis. A hand-written list would break this test for
// unrelated reasons whenever the contract gains an axis — mockSpreadsOriginal blocks that.
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  currentWindow: () => ({ label }) as never,
}));

describe("window label cache", () => {
  // One flow — the cache is outside the swap boundary (moduleState), so it survives a module reset.
  // That matches the real lifetime of a window, and this property is not changed for the test.
  it("does not freeze before resolution and does not re-query after it", async () => {
    const { currentWindowLabel } = await import("./webviewLabels");

    // Before boot — module top level queries it. The absence of an answer must not freeze into the answer.
    expect(currentWindowLabel()).toBe("");
    expect(currentWindowLabel()).toBe("");

    // Resolution complete.
    label = "main";
    expect(currentWindowLabel()).toBe("main");

    // A window does not change its name. Re-reading the framework every time adds a round trip at
    // every place that builds an address, and that round trip is on every render path needing the label.
    label = "somethingElse";
    expect(currentWindowLabel()).toBe("main");
  });
});
