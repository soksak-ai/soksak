// @vitest-environment jsdom
// Measured (focus trace): a macOS window-activation click loses or reorders mouseup (6104ms
// mousedown → next up 2.7s later), so terminals keep buttons=1 and paint later physical motion
// as a drag selection (one click, a huge selection). The core input boundary detects the ghost
// hold and closes it by synthesizing mouseup.
import { afterEach, describe, expect, it, vi } from "vitest";
import { startPointerOrderRepair } from "./pointerOrderRepair";

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  document.body.replaceChildren();
});

describe("pointer order repair — closing a ghost hold", () => {
  it("a mousemove with buttons=0 after a mousedown synthesizes a mouseup on that target", () => {
    stop = startPointerOrderRepair();
    const el = document.createElement("div");
    document.body.append(el);
    const ups: number[] = [];
    el.addEventListener("mouseup", (e) => ups.push(e.clientX));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, buttons: 1 }));
    el.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, buttons: 0, clientX: 77 }),
    );
    expect(ups).toEqual([77]); // the ghost hold ends at once — drag selection cannot start
  });

  it("a normal drag (buttons=1 move) and a normal end (a real mouseup) are left alone", () => {
    stop = startPointerOrderRepair();
    const el = document.createElement("div");
    document.body.append(el);
    const synth = vi.fn();
    el.addEventListener("mouseup", synth);
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, buttons: 1 }));
    el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1 }));
    expect(synth).not.toHaveBeenCalled();
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, buttons: 0, clientX: 9 }),
    );
    expect(synth).toHaveBeenCalledTimes(1); // one real up only — nothing synthesized on top
  });
});
