// @vitest-environment jsdom
// One generic door for a surface kind's own verbs.
//
// The typed wrappers cover the web view's verbs. A second surface kind — a terminal pane a render
// sidecar paints — answers verbs of its own, and the adapter already forwards without reading.
// deliver exposes that forwarding: the message holds a surface and a verb, the compositor checks
// ownership, and the kind's backend reads it. The adapter still names no plugin and no kind.
import { beforeEach, describe, expect, it, vi } from "vitest";

const delivered: Array<{ id: string; message: Record<string, unknown> }> = [];
let refuse: Error | null = null;
const { settled, declared } = vi.hoisted(() => ({
  settled: vi.fn(async () => undefined),
  declared: vi.fn(async () => undefined),
}));
vi.mock("../../../bindings/github.com/min-median-max/wails-service-native-compositor/service", () => ({
  Commit: vi.fn(async (snapshot: { sequence: number }) => ({ sequence: snapshot.sequence, accepted: true, surfaces: [] })),
  Deliver: vi.fn(async (id: string, message: Record<string, unknown>) => {
    if (refuse) throw refuse;
    delivered.push({ id, message });
    return { answered: message.verb };
  }),
}));
vi.mock("../../../bindings/github.com/min-median-max/wails-service-native-compositor/models", () => ({
  Snapshot: { createFrom: (value: unknown) => value },
}));
vi.mock("./nativeSurfaces", () => ({
  nativeSurfacesSettled: settled,
  waitForNativeSurfaceDeclaration: declared,
}));

import { wailsContentViewHost } from "./contentViews";

const SURFACE = "terminal.win-q4m2xr.tab-2trqyu";

describe("delivering a kind's own verb", () => {
  beforeEach(() => {
    delivered.length = 0;
    refuse = null;
  });

  it("forwards the message verbatim and answers what the backend answered", async () => {
    const answer = await wailsContentViewHost.deliver(SURFACE, { verb: "read", lines: 3 });
    expect(declared).toHaveBeenCalledWith(SURFACE);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual([{ id: SURFACE, message: { verb: "read", lines: 3 } }]);
    expect(answer).toEqual({ answered: "read" });
  });

  it("hands a refusal back instead of swallowing it", async () => {
    refuse = new Error("terminal surface verb \"levitate\" is not served");
    await expect(wailsContentViewHost.deliver(SURFACE, { verb: "levitate" })).rejects.toThrow("levitate");
  });
});
