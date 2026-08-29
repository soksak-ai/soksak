// @vitest-environment jsdom
// Wails owns native surfaces through one compositor inventory. The public content-view contract
// must enumerate that inventory instead of refusing the read used by surface diagnostics.
import { describe, expect, it, vi } from "vitest";

const latest = vi.hoisted(() => vi.fn());

vi.mock("../../../bindings/github.com/min-median-max/wails-service-native-compositor/service", () => ({
  Deliver: vi.fn(),
  Latest: latest,
}));

vi.mock("../../lib/webviewLabels", () => ({ currentWindowLabel: () => "win-test" }));

import { wailsContentViewHost } from "./contentViews";

describe("the Wails native surface inventory", () => {
  it("lists the ids from the current window's compositor receipt", async () => {
    latest.mockResolvedValue({
      surfaces: [
        { id: "webview.win-test.tab-browser" },
        { id: "terminal.win-test.tab-terminal-1" },
      ],
    });

    await expect(wailsContentViewHost.list()).resolves.toEqual([
      "webview.win-test.tab-browser",
      "terminal.win-test.tab-terminal-1",
    ]);
    expect(latest).toHaveBeenCalledWith("win-test");
  });

  it("answers surface existence from the same inventory", async () => {
    latest.mockResolvedValue({ surfaces: [{ id: "webview.win-test.tab-browser" }] });

    await expect(wailsContentViewHost.alive("webview.win-test.tab-browser")).resolves.toBe(true);
    await expect(wailsContentViewHost.alive("webview.win-test.tab-missing")).resolves.toBe(false);
  });
});
