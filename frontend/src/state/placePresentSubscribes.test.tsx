// @vitest-environment jsdom
// A place appears when what settles it changes, and not one change later.
//
// Whether a place stands is `open && a set stands there`. The second half is read from the section
// store, and the reader used a hand-built version number — `sets.length + Object.keys(byPlugin)`.
// Standing a set at the window's left edge changes neither: it writes `left`, and the count it was
// counted by stayed the same.
//
// Measured 2026-08-19 on a running window: the left edge was open with a set standing in it and
// drew nothing at width 0, and a person who toggled the place off and on got it. What the toggle
// did was force the recompute the store change should have caused.
//
// So there is no counter. The reader subscribes to the store and its question is the whole of what
// it reads — a count kept in step with a state by hand is a count that goes out of step.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSectionSets, usePlacePresent, type SectionPlace } from "./sectionSets";

// React refuses to treat act() as a test boundary without it, and prints that on every render.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ open, place }: { open: boolean; place: SectionPlace }) {
  return <div data-testid="probe">{String(usePlacePresent(open, place, null))}</div>;
}

describe("the left edge as a reader sees it", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    useSectionSets.setState({
      sets: [{ id: "set-a", title: "one", sections: ["plugin.view"] }],
      byPlugin: {},
      left: null,
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const draw = (open: boolean) =>
    act(() => {
      root.render(<Probe open={open} place="left" />);
    });

  const reading = () => host.querySelector('[data-testid="probe"]')?.textContent;

  it("stands the moment the set is chosen, with nothing else changing", () => {
    draw(true);
    expect(reading()).toBe("false");

    act(() => {
      useSectionSets.getState().standLeft("set-a");
    });
    expect(reading()).toBe("true");
  });

  it("goes when the set is taken away, with nothing else changing", () => {
    act(() => {
      useSectionSets.getState().standLeft("set-a");
    });
    draw(true);
    expect(reading()).toBe("true");

    act(() => {
      useSectionSets.getState().standLeft(null);
    });
    expect(reading()).toBe("false");
  });

  it("draws nothing while the place is closed, whatever stands in it", () => {
    act(() => {
      useSectionSets.getState().standLeft("set-a");
    });
    draw(false);
    expect(reading()).toBe("false");
  });
});
