// **The owner of a surface delivers that surface's input.**
//
// Pointer input arrived only at the surfaces the core held (framework child webviews). A surface a
// plugin draws through an engine sidecar was not covered by the core's path and was rejected as
// "no webview" — measured 2026-08-08: of three browsers only one took gestures, and the other two
// got rejections that differed only in name.
//
// The core must not identify the engine. The plugin that created the surface identifies it, and
// the core's only job is to provide **the place to ask who the owner is**. With an owner, input
// goes there; without one, to the framework.
//
// The owner is not guessed from label syntax — splitting on a prefix delivers to someone else's
// surface the day that syntax changes. The owner answers "this label is mine" itself.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetSurfaceInputProvidersForTest,
  registerSurfaceInputProvider,
  surfaceInputLabelOfView,
  surfaceInputProvider,
} from "./surfaceInputProviders";

beforeEach(() => __resetSurfaceInputProvidersForTest());

const provider = (owns: (label: string) => boolean) => ({
  owns,
  sendInput: vi.fn(async () => {}),
  inputState: vi.fn(async () => ({ attached: true })),
});

describe("surface input owner", () => {
  it("answers none when there is no owner — the framework takes that place", () => {
    expect(surfaceInputProvider("browser.main.tab-4h7kq2")).toBeNull();
  });

  it("goes to the owner that claimed the label", () => {
    const p = provider((label) => label.startsWith("chromium-"));
    registerSurfaceInputProvider("soksak-plugin-browser-chromium", p);
    expect(surfaceInputProvider("chromium-tab-1")).toBe(p);
    expect(surfaceInputProvider("browser.main.tab-4h7kq2")).toBeNull();
  });

  it("reads a view label from its owner instead of reconstructing a plugin surface kind", () => {
    const p = {
      ...provider((label) => label === "terminal.win-a.tab-a-1"),
      labelOfView: (viewId: string) => viewId === "tab-a" ? "terminal.win-a.tab-a-1" : null,
    };
    registerSurfaceInputProvider("soksak-plugin-terminal-vision", p);
    expect(surfaceInputLabelOfView("tab-a")).toBe("terminal.win-a.tab-a-1");
    expect(surfaceInputLabelOfView("tab-b")).toBeNull();
  });

  // If two owners both claim the same surface, no value determines the delivery target.
  it("throws with both names when two owners claim one surface", () => {
    registerSurfaceInputProvider("plugin-a", provider(() => true));
    registerSurfaceInputProvider("plugin-b", provider(() => true));
    expect(() => surfaceInputProvider("x")).toThrow(/plugin-a.*plugin-b|plugin-b.*plugin-a/);
  });

  // Re-registering the same plugin replaces it — two copies would make the rule above conflict with itself.
  it("re-registering the same owner replaces it", () => {
    registerSurfaceInputProvider("plugin-a", provider(() => true));
    const second = provider(() => true);
    registerSurfaceInputProvider("plugin-a", second);
    expect(surfaceInputProvider("x")).toBe(second);
  });

  // When the view is gone the owner is gone too — leaving it keeps sending to a dead sidecar.
  it("after disposal there is no owner again", () => {
    const dispose = registerSurfaceInputProvider("plugin-a", provider(() => true));
    dispose();
    expect(surfaceInputProvider("x")).toBeNull();
  });

  // A throw inside the owner's check is not swallowed — swallowing leaks the delivery silently to the framework.
  it("a throw inside the owner's check comes out with that owner's name", () => {
    registerSurfaceInputProvider("plugin-a", {
      owns: () => { throw new Error("broken check"); },
      sendInput: vi.fn(),
      inputState: vi.fn(),
    });
    expect(() => surfaceInputProvider("x")).toThrow(/plugin-a/);
  });
});
