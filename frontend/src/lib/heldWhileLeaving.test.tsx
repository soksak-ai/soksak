import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHeldWhileLeaving } from "./heldWhileLeaving";

// React refuses to treat act() as a test boundary without it, and prints that on every render.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A departing value is held for exactly the closing motion, and an arriving one is not delayed.
//
// The region's width travels with the panes and its content is decided by a render, so without the
// hold the strip is empty for the whole of the closing motion — measured 2026-08-17, 160 points for
// 160ms in the named three-pane window. Holding too much is the opposite defect: a set replaced by
// another would show the old one over the new one's space.

describe("what leaves, leaves with its space", () => {
  let host: HTMLDivElement;
  let root: Root;
  let seen: Array<string | null>;

  const Probe = ({ value, subject }: { value: string | null; subject?: string }) => {
    seen.push(useHeldWhileLeaving(value, 160, subject));
    return null;
  };

  const render = (value: string | null, subject?: string) =>
    act(() => {
      root.render(<Probe value={value} subject={subject} />);
    });

  beforeEach(() => {
    vi.useFakeTimers();
    seen = [];
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  const now = () => seen[seen.length - 1];

  it("shows what arrives on the render it arrives in", () => {
    render(null);
    expect(now()).toBeNull();
    render("set-a1b2c3");
    // A frame of nothing in front of an arrival is the same defect pointed the other way.
    expect(now()).toBe("set-a1b2c3");
  });

  it("holds what left until the motion has closed the space", () => {
    render("set-a1b2c3");
    render(null);
    expect(now()).toBe("set-a1b2c3");

    act(() => void vi.advanceTimersByTime(159));
    expect(now()).toBe("set-a1b2c3");

    act(() => void vi.advanceTimersByTime(2));
    expect(now()).toBeNull();
  });

  it("replaces at once, because a replacement closes no space", () => {
    render("set-a1b2c3");
    render("set-d4e5f6");
    expect(now()).toBe("set-d4e5f6");

    // The replaced one is gone for good — a hold that outlived its replacement would draw the old
    // set in the new one's place.
    act(() => void vi.advanceTimersByTime(200));
    expect(now()).toBe("set-d4e5f6");
  });

  it("answers nothing for a subject that has nothing, whatever the last subject held", () => {
    render("set-a1b2c3", "left");
    expect(now()).toBe("set-a1b2c3");

    // The same host asked about another region. Nothing departed — the question changed, and the
    // left region's set is not an answer about the right one.
    render(null, "right");
    expect(now()).toBeNull();
  });

  it("keeps what came back, when it came back inside the motion", () => {
    render("set-a1b2c3");
    render(null);
    act(() => void vi.advanceTimersByTime(80));
    render("set-a1b2c3");

    act(() => void vi.advanceTimersByTime(200));
    // The timer that was running for the departure must not take away the value that returned.
    expect(now()).toBe("set-a1b2c3");
  });
});
