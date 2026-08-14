// @vitest-environment jsdom
// Focus this window by label too — never through "this webview right now".
//
// The main renderer of a workspace window is the webview inside it, not the window (WebviewWindow). So a
// self-directed focus dies in the framework while grabbing the "current webview" — measured 2026-08-08:
// `window.focus` failed with `current webview is not a WebviewWindow`, and passing a label ended in the
// same place (a self label takes that path).
//
// Raising a window is **the window's operation**, and the label designates that window. The calling
// renderer must not matter. Without focus, the child webview of that window has `document.hasFocus()`
// false, and typing produces no characters.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => undefined),
}));
const win = vi.hoisted(() => ({ setFocus: vi.fn(async () => {}) }));

vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: (cmd: string, args?: Record<string, unknown>) => calls.invoke(cmd as never, args as never),
  currentWindow: () => win,
}));
vi.mock("../lib/webviewLabels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/webviewLabels")>()),
  currentWindowLabel: () => "w-1",
}));

import { registerCatalog } from "./catalog";
import { execute } from "./registry";

registerCatalog();

beforeEach(() => {
  calls.invoke.mockReset();
  win.setFocus.mockReset();
  calls.invoke.mockImplementation(async (cmd: string) => (cmd === "window_list" ? ["w-1", "w-2"] : undefined));
});

const named = (cmd: string) => calls.invoke.mock.calls.filter(([c]) => c === cmd);

describe("window.focus — this window is addressed by label too", () => {
  it("brings the app to the front and focuses this window by its label", async () => {
    const out = await execute("window.focus", { label: "w-1" }, {});
    expect(out.ok).toBe(true);
    expect(named("window_activate").length, "the app was not brought to the front").toBe(1);
    expect(named("window_focus")[0]?.[1]).toEqual({ label: "w-1" });
  });

  it("does not go through this web view — the workspace renderer is not a window", async () => {
    await execute("window.focus", {}, {});
    expect(win.setFocus, "a window operation ran against something that is not a window").not.toHaveBeenCalled();
  });

  it("does not bring the app to the front for another window", async () => {
    await execute("window.focus", { label: "w-2" }, {});
    expect(named("window_activate").length).toBe(0);
    expect(named("window_focus")[0]?.[1]).toEqual({ label: "w-2" });
  });

  it("refuses an absent window by name", async () => {
    const out = await execute("window.focus", { label: "w-none" }, {});
    expect(out.ok).toBe(false);
    expect(named("window_focus").length).toBe(0);
  });
});
