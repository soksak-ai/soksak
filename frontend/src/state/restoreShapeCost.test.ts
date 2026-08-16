import { describe, expect, it } from "vitest";
import { restoreWindow } from "./windowPersistence";
import type { WindowSnapshot } from "./windowPersistence";

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
      root: "<local-evidence>/w",
      sidebarOpen: true,
      rightOpen: false,
      // The shape of that day: one region's layout, and the other region's single active view.
      rightView: null,
      leftLayout: { t: "l", v: { viewKeys: [], activeViewKey: "" } },
      activeContentId: "spc-a1b2c3",
      contents: [
        {
          id: "spc-a1b2c3",
          title: "s",
          activeGroupId: "pan-a1b2c3",
          layout: {
            t: "l",
            v: { id: "pan-a1b2c3", views: [], activeViewId: "" },
          },
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
    expect(workspaces[0]?.root).toBe("<local-evidence>/w");
    expect(workspaces[0]?.spaces).toHaveLength(1);
  });

  it("costs the arrangement itself, and answers an empty one per region", () => {
    const { workspaces } = restoreWindow(STORED_BEFORE);
    const layouts = workspaces[0]?.sidebarLayouts;

    expect(Object.keys(layouts ?? {})).toEqual(["left", "right"]);
    expect(layouts?.left).toBeDefined();
    expect(layouts?.right).toBeDefined();
  });
});
