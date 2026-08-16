import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke,
  currentWindow: vi.fn(),
  windowByLabel: vi.fn(),
}));
vi.mock("../lib/webviewLabels", () => ({
  browserLabelPrefix: (label: string) => ["b", label, ""].join("-"),
  currentWindowLabel: () => "main",
}));
vi.mock("../state/windowBoot", () => ({ forgetWindowSlot: vi.fn() }));

import { registerWindowCatalog } from "./catalogWindow";
import { execute, unregister } from "./registry";

beforeEach(() => {
  invoke.mockReset();
  registerWindowCatalog();
});

afterEach(() => unregister("window.occlusion"));

// The count is the answer rather than a success flag: a window holds the
// application's own view and one per native surface, and reaching the first
// alone leaves every browser pane throttled while the caller reads a clean
// result.
//
// Measured 2026-08-16: this went to plugin:webview-capture|set_occlusion, a
// command of the preceding implementation's plugin that this host never served,
// so every call answered INTERNAL and the throttle stayed on.
it("reports how many native webviews the occlusion setting was applied to", async () => {
  invoke.mockResolvedValue({ occlusion: false, webviews: 4 });
  const result = await execute("window.occlusion", { enabled: false }, {});
  expect(result).toMatchObject({ ok: true, data: { occlusion: false, webviews: 4 } });
  expect(invoke).toHaveBeenCalledWith("window_occlusion", { enabled: false });
});
