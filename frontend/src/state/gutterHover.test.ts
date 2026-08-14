// gutter hover comes from a source that reports only "present" (MouseMoved from the native local
// monitor). So there was an enter edge and no leave edge — when the pointer exits the window the
// event stream stops, and a stopped stream is indistinguishable from "still parked there", so the
// highlight stays forever.
//
// Measured result (2026-07-26): the accent vertical line froze across the browser surfaces at the
// full height of the window body. ui.hit returned `pane-gutter` s1:0 at that spot, and
// rect(985.4, 82, 6, 997) matched the native highlight bar frame exactly — the DOM highlight and the
// native bar are two faces of the same frozen state.
//
// What is pinned here is state symmetry: set and clear come in pairs.
import { beforeEach, describe, expect, it } from "vitest";
import { useGutterHover } from "./gutterHover";

describe("gutterHover — every set has a matching clear", () => {
  beforeEach(() => useGutterHover.setState({ key: null }));

  it("turns on with a hover key and off with null", () => {
    useGutterHover.getState().set("s1:0");
    expect(useGutterHover.getState().key).toBe("s1:0");
    useGutterHover.getState().set(null);
    expect(useGutterHover.getState().key).toBeNull();
  });

  it("setting the same value keeps the same state object — no re-render per hover move", () => {
    useGutterHover.getState().set("s1:0");
    const before = useGutterHover.getState();
    useGutterHover.getState().set("s1:0");
    expect(useGutterHover.getState()).toBe(before);
  });

  it("clearing an already cleared state is harmless — the absence signal arrives on several paths", () => {
    // The core emits native-mouseleave from both window resignKey and app resignActive. Both can
    // arrive, so clearing must be idempotent.
    const before = useGutterHover.getState();
    useGutterHover.getState().set(null);
    expect(useGutterHover.getState()).toBe(before);
    expect(useGutterHover.getState().key).toBeNull();
  });
});
