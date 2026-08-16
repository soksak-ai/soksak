// @vitest-environment jsdom
// The four verbs a declaration cannot express.
//
// A pane declares the page it opens with, and a changed source rebuilds the surface. Going back,
// going forward, reloading and stopping all leave the declared url exactly as it was. A
// declaration-only browser is therefore missing four of its five verbs and the pane looks frozen.
//
// They travel as messages the compositor forwards to whichever backend owns the surface. The
// adapter names no plugin — the message holds a surface and a verb, and the kind's backend reads it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const delivered: Array<{ id: string; message: Record<string, unknown> }> = [];
let refuse: Error | null = null;
vi.mock("../../../bindings/github.com/soksak/wails-service-native-compositor/service", () => ({
  Commit: vi.fn(async (snapshot: { sequence: number }) => ({ sequence: snapshot.sequence, accepted: true, surfaces: [] })),
  Deliver: vi.fn(async (id: string, message: Record<string, unknown>) => {
    if (refuse) throw refuse;
    delivered.push({ id, message });
    return { id, verb: message.verb };
  }),
}));
vi.mock("../../../bindings/github.com/soksak/wails-service-native-compositor/models", () => ({
  Snapshot: { createFrom: (value: unknown) => value },
}));

import { wailsContentViewHost } from "./contentViews";

// The key into the applied native surface inventory is a label, not a name of this test's choosing:
// `<kind>-<window>-<viewId>` (lib/surfaceLabels.ts). The kind is the word of the plugin that
// declared the surface, the window name is the host's, and the view id is the issuer's
// (state/ids.ts). A shorter value exercises the inventory lookup on a string no issuer produces.
const SURFACE = "browser.win-q4m2xr.tab-2trqyu";

describe("driving a native surface", () => {
  beforeEach(() => {
    delivered.length = 0;
    refuse = null;
  });

  it("navigate carries the surface and the address", async () => {
    await wailsContentViewHost.navigate(SURFACE, "https://example.org");
    expect(delivered).toEqual([{ id: SURFACE, message: { verb: "navigate", url: "https://example.org" } }]);
  });

  it("history carries the step itself, not a direction", async () => {
    // The back-forward list takes whole steps, so a jump of three is one call. Collapsing the step
    // to a direction throws that away and turns the jump into a single step back.
    await wailsContentViewHost.history(SURFACE, -1);
    await wailsContentViewHost.history(SURFACE, 1);
    await wailsContentViewHost.history(SURFACE, -3);
    expect(delivered.map((d) => d.message)).toEqual([
      { verb: "history", delta: -1 },
      { verb: "history", delta: 1 },
      { verb: "history", delta: -3 },
    ]);
  });

  it("a step of zero is refused rather than sent as a verb nobody answers", async () => {
    await expect(wailsContentViewHost.history(SURFACE, 0)).rejects.toThrow();
    expect(delivered).toEqual([]);
  });

  it("reload and stop carry nothing else", async () => {
    await wailsContentViewHost.reload(SURFACE);
    await wailsContentViewHost.stop(SURFACE);
    expect(delivered.map((d) => d.message)).toEqual([{ verb: "reload" }, { verb: "stop" }]);
  });

  it("a refusal from the surface reaches the caller", async () => {
    // Swallowing it leaves a caller reporting a page as moved when the screen disagrees.
    refuse = new Error(`native surface ${SURFACE} is not in the applied inventory at sequence 4`);
    await expect(wailsContentViewHost.reload(SURFACE)).rejects.toThrow(/inventory/);
  });

  it("what this host still does not do is refused by name", async () => {
    // Naming the method is what separates "not built here" from "broken", and a caller that gets
    // one line with no name has nowhere to look.
    await expect(wailsContentViewHost.evalJs(SURFACE, "1")).rejects.toThrow(/evalJs/);
  });
});
