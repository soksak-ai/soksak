// If view.open returned ok, that view can accept commands.
//
// RED evidence (measured, 2026-07-26): sending navigate with that viewId right after view.open returned
// NO_VIEW from the plugin — the core reported it created, but it was unusable. State changes immediately
// while the plugin view mounts on the next render, and no signal covered the gap. When the reply runs ahead
// of the real thing, the caller waits by guessing (polling) or swallows the failure — e2e did both.
import { describe, expect, it, vi } from "vitest";
import { awaitViewMounted, registerMountedViewFocus } from "./viewFocus";
import type { PluginViewProvider, PluginViewContext } from "./viewRegistry";

const provider = { restores: "none" as const, mount: () => {} } as unknown as PluginViewProvider;
const ctx = () => ({}) as PluginViewContext;
const mount = (viewId: string) =>
  registerMountedViewFocus(viewId, document.createElement("div"), provider, ctx);

describe("the mount-ready signal", () => {
  it("an already-mounted view resolves true at once", async () => {
    const off = mount("v-ready-now");
    await expect(awaitViewMounted("v-ready-now", 50)).resolves.toBe(true);
    off();
  });

  it("a later mount wakes the wait at that point — the mount is the signal, not a poll", async () => {
    const p = awaitViewMounted("v-ready-later", 2000);
    const off = mount("v-ready-later");
    await expect(p).resolves.toBe(true);
    off();
  });

  it("a mount that never arrives resolves false — the wait does not hang", async () => {
    vi.useFakeTimers();
    const p = awaitViewMounted("v-never", 100);
    await vi.advanceTimersByTimeAsync(150);
    await expect(p).resolves.toBe(false);
    vi.useRealTimers();
  });

  it("another view mounting does not wake this wait", async () => {
    vi.useFakeTimers();
    const p = awaitViewMounted("v-mine", 100);
    const off = mount("v-other");
    await vi.advanceTimersByTimeAsync(150);
    await expect(p).resolves.toBe(false);
    off();
    vi.useRealTimers();
  });
});
