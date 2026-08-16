// Plugin view host DOM anchor contract — exposes core-issued identifiers so they can be dereferenced from the DOM.
// Regression guard: 942ae86 (built-in terminal → plugin) dropped the anchor and broke the overlay plugin
// (claude-gui) that finds a host by that id. This contract is pinned to block a repeat.
//
// One value one name: data-tab-id (vocabulary standard — an instance is a tab). The old data-pane-id is removed after every consumer migrates (2026-07-27).
// Until then both are emitted. The anchor is a plugin contract surface, so keeping only one side in a rename
// release leaves a plugin that reads the old name unable to find the host. The removal condition is in the
// viewHostAnchors.ts header — the old-name assertion in this test is deleted at the same time (the two are
// two ends of one contract).
import { describe, expect, it } from "vitest";
import { viewHostAnchors } from "./viewHostAnchors";

describe("viewHostAnchors — content view host DOM anchor contract", () => {
  it("data-view-addr is exposed as the node-scan baseAddress in every placement", () => {
    expect(viewHostAnchors("center/view/soksak-plugin-x.main", "tab-aaaaaa")).toMatchObject({
      "data-view-addr": "center/view/soksak-plugin-x.main",
    });
  });

  it("a content placement (with a tab) exposes the tab dereference anchor (data-tab-id)", () => {
    // With the tab id issued by statusBarItem and command.started, a plugin finds this host through
    // querySelector('[data-tab-id="tab-aaaaaa"]') (symmetry).
    expect(
      viewHostAnchors("center/view/soksak-plugin-terminal-xterm.content", "tab-aaaaaa"),
    ).toEqual({
      "data-view-addr": "center/view/soksak-plugin-terminal-xterm.content",
      "data-tab-id": "tab-aaaaaa",
    });
  });

  it("a sidebar placement (no tab) exposes no anchor — it must not be confused with the followed target", () => {
    // The sidebar host tracks the 'followed terminal', not its own instance id. No anchor.
    expect(viewHostAnchors("left/view/soksak-plugin-file-tree.tree", null)).toEqual({
      "data-view-addr": "left/view/soksak-plugin-file-tree.tree",
    });
  });
});
