import { describe, expect, it } from "vitest";

import { EVENT_PERMISSIONS, PLUGIN_EVENTS, terminalSurfaceStatePayload } from "./hooks";

// The surface state event exists as a typed plugin event and only the surface
// owner may hear it — a pane's render progression is not a broadcast.
describe("terminal surface state event", () => {
  it("is a declared plugin event", () => {
    expect(PLUGIN_EVENTS).toContain("terminal-surface.state");
  });

  it("is gated on the surface permission", () => {
    expect(EVENT_PERMISSIONS["terminal-surface.state"]).toBe("surface");
  });

  it("requires the lifecycle generation with the frame sequence", () => {
    expect(terminalSurfaceStatePayload({ pane: "tab-a.1", sequence: 8, generation: 4 })).toEqual({
      pane: "tab-a.1", sequence: 8, generation: 4,
    });
    expect(terminalSurfaceStatePayload({ pane: "tab-a.1", sequence: 8 })).toBeNull();
  });
});
