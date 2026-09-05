// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { WindowPointerActivationCoordinator, type NativePointerEdge } from "./windowPointerActivation";
import { useUi } from "../state/ui";

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

  it("does not complete activation when a drag position is received", () => {
    const activate = vi.fn(() => true);
    const coordinator = new WindowPointerActivationCoordinator(() => document.body, activate);
    coordinator.observeNative(edge("down"));
    coordinator.observeNative({ ...edge("down"), phase: "move", x: 80 });
    expect(coordinator.snapshot()).toMatchObject({ phase: "down", sequence: 7 });
    expect(activate).not.toHaveBeenCalled();
  });

  // A DOM overlay closes on a press outside it, and it hears presses through the document. A press
  // on a native surface is never delivered to the document: the program menu stayed open over a terminal
  // that had just been clicked (measured 2026-09-05). A press the document did not deliver is
  // stated to the ui state, where an overlay reads it as a press outside.
  it("states a press the document did not deliver, and not one it did", () => {
    const before = useUi.getState().nativePress;
    const coordinator = new WindowPointerActivationCoordinator(() => document.body, () => false);
    coordinator.observeNative(edge("down"));
    coordinator.observeNative(edge("up"));
    expect(useUi.getState().nativePress).toBe(before + 1);

    coordinator.observeDom({ phase: "down", x: 40, y: 60, atUnixMs: 2000 });
    coordinator.observeNative({ ...edge("down"), sequence: 8, atUnixMs: 2000 });
    coordinator.observeDom({ phase: "up", x: 40, y: 60, atUnixMs: 2015 });
    coordinator.observeNative({ ...edge("up"), sequence: 8, atUnixMs: 2015 });
    expect(useUi.getState().nativePress).toBe(before + 1);
  });
});
