// @vitest-environment jsdom
// **An answer of "focused" is not an answer when focus did not happen.**
//
// Measured 2026-08-08: `window.focus` answered `{ focused: true }` but that window was not key
// (`windowIsKey: false` in `ui.input.state`). While another app is active, raising this app's window
// to the front does not make the OS transfer keyboard focus — the request succeeds and the result
// never follows.
//
// Every keyboard command is then rejected, and the caller has no way to tell why focus had no
// effect. Request and result are different facts, so the response must state both.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ invoke: vi.fn(async (_c: string, _a?: unknown): Promise<unknown> => undefined) }));
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: (cmd: string, args?: Record<string, unknown>) => calls.invoke(cmd, args),
  currentWindow: () => ({ setFocus: async () => {} }),
}));
vi.mock("../lib/webviewLabels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/webviewLabels")>()),
  currentWindowLabel: () => "win-1",
}));

import { registerCatalog } from "./catalog";
import { execute, getSpec } from "./registry";

registerCatalog();

beforeEach(() => {
  calls.invoke.mockReset();
  calls.invoke.mockImplementation(async (cmd: string) => (cmd === "window_list" ? ["win-1", "win-2"] : undefined));
});

describe("window.focus answers the outcome", () => {
  it("answers whether the window became key — request and result are different facts", async () => {
    calls.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "window_list") return ["win-1", "win-2"];
      if (cmd === "window_is_key") return true;
      return undefined;
    });
    const out = await execute("window.focus", { label: "win-1" }, {});
    expect(out.ok).toBe(true);
    expect((out.data as { key?: boolean }).key).toBe(true);
    expect(getSpec("window.focus")?.returns).toContain("key");
  });

  // Raising the window while another app is active brings no keyboard focus. The response must state
  // that fact, since the caller has no other source for it.
  it("when the window did not become key, answers that fact and what to do", async () => {
    calls.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "window_list") return ["win-1", "win-2"];
      if (cmd === "window_is_key") return false;
      return undefined;
    });
    const out = await execute("window.focus", { label: "win-1" }, {});
    expect((out.data as { key?: boolean }).key).toBe(false);
    expect(String(out.message)).toBe(tmsg("msg.window.focus.notKey"));
  });
});
