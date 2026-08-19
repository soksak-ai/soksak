// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { WindowPointerActivationCoordinator, type NativePointerEdge } from "./windowPointerActivation";

const edge = (phase: "down" | "up"): NativePointerEdge => ({
  sequence: 7,
  phase,
  source: "system",
  x: 40,
  y: 60,
  atUnixMs: phase === "down" ? 1000 : 1015,
  window: "win-a",
});

describe("native pointer activation carrier", () => {
  it("applies the same activation once when WebKit consumes the whole DOM click", () => {
    const node = document.createElement("div");
    node.dataset.node = "layout/tab/tab-a";
    const activate = vi.fn(() => true);
    const coordinator = new WindowPointerActivationCoordinator(() => node, activate);

    coordinator.observeNative(edge("down"));
    coordinator.observeNative(edge("up"));

    expect(activate).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot()).toMatchObject({
      sequence: 7,
      phase: "up",
      targetNode: "layout/tab/tab-a",
      domDelivered: false,
      fallbackPending: false,
      fallbackApplied: true,
    });
  });

  it("does not replay a click the DOM already received", () => {
    const activate = vi.fn(() => true);
    const coordinator = new WindowPointerActivationCoordinator(() => document.body, activate);
    coordinator.observeNative(edge("down"));
    coordinator.observeDom({ phase: "down", x: 40, y: 60, atUnixMs: 1004 });
    coordinator.observeDom({ phase: "up", x: 40, y: 60, atUnixMs: 1018 });
    coordinator.observeNative(edge("up"));

    expect(activate).not.toHaveBeenCalled();
    expect(coordinator.snapshot()).toMatchObject({ domDelivered: true, fallbackApplied: false });
  });

  it("does not confuse an older click at the same coordinate with this gesture", () => {
    const activate = vi.fn(() => true);
    const coordinator = new WindowPointerActivationCoordinator(() => document.body, activate);
    coordinator.observeDom({ phase: "down", x: 40, y: 60, atUnixMs: 800 });
    coordinator.observeNative(edge("down"));
    coordinator.observeNative(edge("up"));
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("can hold activation until the native event has completed", () => {
    let scheduled: (() => void) | null = null;
    const activate = vi.fn(() => true);
    const coordinator = new WindowPointerActivationCoordinator(
      () => document.body,
      activate,
      (apply) => { scheduled = apply; },
    );
    coordinator.observeNative(edge("down"));
    coordinator.observeNative(edge("up"));
    expect(activate).not.toHaveBeenCalled();
    expect(coordinator.snapshot()).toMatchObject({ fallbackPending: true, fallbackApplied: false });
    (scheduled as (() => void) | null)?.();
    expect(activate).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot()).toMatchObject({ fallbackPending: false, fallbackApplied: true });
  });

  it("applies contract injection without waiting for a render frame", async () => {
    const activate = vi.fn(() => true);
    const schedule = vi.fn();
    const coordinator = new WindowPointerActivationCoordinator(() => document.body, activate, schedule);
    coordinator.observeNative({ ...edge("down"), source: "contract-injection" });
    coordinator.observeNative({ ...edge("up"), source: "contract-injection" });
    await Promise.resolve();
    expect(schedule).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledTimes(1);
  });
});
