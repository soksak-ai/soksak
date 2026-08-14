// @vitest-environment jsdom
// Basis for the §12-④ revision — measured (focus trace): if activation starts the projected move on
// mousedown, the moving veil captures and kills the events of the gesture and the following click, and
// redelivery goes to the previous/first pane — "focus does not go where I clicked". The fix is order:
// confirm the click first (gesture complete), then move. Activation is always attributed to the slot that started the gesture.
import { describe, expect, it, vi } from "vitest";
import { armSlotActivation } from "./slotGesture";

describe("slot gesture attribution — move after the click is confirmed", () => {
  it("activates at gesture completion (mouseup), not at mousedown", () => {
    const activate = vi.fn();
    armSlotActivation(activate);
    expect(activate).not.toHaveBeenCalled();
    window.dispatchEvent(new MouseEvent("mouseup"));
    expect(activate).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new MouseEvent("mouseup")); // one-shot — unrelated to the next gesture
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("activates the starting slot even when mouseup lands on another element (straddle attribution)", () => {
    const activate = vi.fn();
    armSlotActivation(activate);
    const other = document.createElement("div");
    document.body.append(other);
    other.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(activate).toHaveBeenCalledTimes(1);
    other.remove();
  });

  it("completes through the fallback when mouseup is lost or arrives first (window-switch activation click)", () => {
    // Measured (focus trace): the macOS window-activation click can arrive tangled, in the order
    // mouseup(4449) then mousedown(4451) — waiting for mouseup alone misattributes the activation to the
    // next unrelated click ("works, then does not"). Completion is whichever comes first: mouseup, next mousedown, timer.
    vi.useFakeTimers();
    try {
      const activate = vi.fn();
      armSlotActivation(activate);
      vi.advanceTimersByTime(400);
      expect(activate).toHaveBeenCalledTimes(1);
      window.dispatchEvent(new MouseEvent("mouseup")); // late up — no second run
      expect(activate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the next mousedown ends the previous gesture — the pending activation runs first", () => {
    vi.useFakeTimers();
    try {
      const activate = vi.fn();
      armSlotActivation(activate);
      window.dispatchEvent(new MouseEvent("mousedown"));
      expect(activate).toHaveBeenCalledTimes(1);
      window.dispatchEvent(new MouseEvent("mouseup"));
      vi.advanceTimersByTime(400);
      expect(activate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
