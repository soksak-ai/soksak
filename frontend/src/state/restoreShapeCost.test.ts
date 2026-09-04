import { describe, expect, it } from "vitest";
import { restoreWindow } from "./windowPersistence";
import type { WindowSnapshot } from "./windowPersistence";
import { SECTION_PLACES } from "./sectionSets";
import { DEFAULT_RAIL_PLACEMENT } from "../lib/railPlacement";

// A stored field of another shape costs that field, not the window (RESTORE R1).
//
// The workspace held one arrangement for the left and a single active view for the right until
// 2026-08-17, when both regions became one `sidebarLayouts` (A2a). The stored snapshots on disk were
// written by the build before that. Measured: the application came up and every command answered
// `TARGET_NOT_FOUND: No such workspace` — the panes, the tabs, the roots, all of it gone because one
// presentation field was shaped differently.
//
// The arrangement of a region is presentation. Losing it costs the arrangement.
const STORED_BEFORE = {
  version: 1,
  activeId: "wsp-a1b2c3",
  workspaces: [
    {
      id: "wsp-a1b2c3",
      title: "w",
      root: "/tmp/w",
      regionOpen: { left: false, rail: true, right: false },
      // The shape of that day: one region's layout, and the other region's single active view.
      // `leftRailPlacement` is that day's name for where the rail stands — `left` meant the rail
      // then, and the field is `railPlacement` now.
      leftRailPlacement: { mode: "pin", station: 60 },
      rightView: null,
      leftLayout: { t: "l", v: { viewKeys: [], activeViewKey: "" } },
      activeContentId: "spc-a1b2c3",
      contents: [
        {
          id: "spc-a1b2c3",
          title: "s",
          activeGroupId: "pan-a1b2c3",
          groups: [{ id: "pan-a1b2c3", views: [], activeViewId: "" }],
          plane: { xs: [0, 1], ys: [0, 1], cards: [{ id: "pan-a1b2c3", c0: 0, c1: 1, r0: 0, r1: 1 }] },
        },
      ],
    },
  ],
} as unknown as WindowSnapshot;

describe("restoring a window written by an older build", () => {
  it("keeps the workspace and its spaces when a region's arrangement is shaped differently", () => {
    const { workspaces, activeId } = restoreWindow(STORED_BEFORE);

    expect(workspaces).toHaveLength(1);
    expect(activeId).toBe("wsp-a1b2c3");
    expect(workspaces[0]?.root).toBe("/tmp/w");
    expect(workspaces[0]?.spaces).toHaveLength(1);
  });

  it("costs a renamed field and says so, rather than restoring a station nobody set", () => {
    // `leftRailPlacement` became `railPlacement` on 2026-08-18 when `left` stopped meaning the rail.
    // Read under the old name, a stored pin would put the rail at a station whose name meant the
    // window's left edge by then. It is not migrated (L11c) — the rail comes back where it stands
    // by default, and everything else in the window survives.
    const { workspaces } = restoreWindow(STORED_BEFORE);
    expect(workspaces[0]?.railPlacement).toEqual(DEFAULT_RAIL_PLACEMENT);
    expect(workspaces[0]?.spaces).toHaveLength(1);
  });

  it("costs the arrangement itself, and answers an empty one per place", () => {
    // One per place a sidebar can stand, read from the places themselves. Writing the three names
    // here would pass the day a fourth place is added and nothing restored it.
    const { workspaces } = restoreWindow(STORED_BEFORE);
    const layouts = workspaces[0]?.sidebarLayouts;

    expect(Object.keys(layouts ?? {}).sort()).toEqual([...SECTION_PLACES].sort());
    for (const place of SECTION_PLACES) expect(layouts?.[place], place).toBeDefined();
  });
});
