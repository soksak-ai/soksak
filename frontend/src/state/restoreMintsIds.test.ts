// A restore mints every identifier again.
//
// docs/tech/RESTORE.md R3 — "Ids are minted again, and that is the contract."
// state.fingerprint, the one number a restore is judged by, holds no id at all
// (V1): a workspace is identified across a restart by its root, and a window
// name is issued fresh at every open.
//
// Only split ids were minted. Everything else was carried across verbatim, so
// `t1` — a counter with no prefix, from before the issuer existed — was the
// workspace id of three separate window snapshots at once, months after nothing
// could mint it (measured 2026-08-16 over the whole store). A store is where a
// retired shape outlives the code that made it, and this was the way in.
//
// Minting the workspace alone would be worse than minting none: a surface label
// pairs a window name with a view id, the window name is new every run, and a
// stale view id beside it makes one value with two lifetimes.
//
// Nothing here repairs a bad id. The fixtures below are well formed on purpose —
// R3 is not "a malformed id is replaced", it is that a stored id is not the name
// the restored thing takes.
import { describe, expect, it } from "vitest";

import { ID_PREFIX } from "./ids";
import { deserializeWorkspace } from "./windowSnapshot";

const N1 = /^[a-z]{3}-[a-z2-7]{6}$/;

/** A stored workspace, every id well formed and every reference pointing at one. */
function stored() {
  return {
    id: "wsp-aaaaaa",
    title: "one",
    root: "/workspaces/one",
    sidebarOpen: true,
    rightOpen: false,
    rightView: null,
    leftLayout: { t: "l", v: { id: "grp-a", views: [], activeViewId: "" } },
    railPlacementNormalized: true,
    vlNormalized: true,
    activeContentId: "spc-aaaaaa",
    contents: [
      {
        id: "spc-aaaaaa",
        title: "1",
        activeGroupId: "pan-aaaaaa",
        railBindingViewId: "tab-aaaaaa",
        maximizedViewId: "tab-aaaaaa",
        layout: {
          t: "l",
          v: {
            id: "pan-aaaaaa",
            activeViewId: "tab-aaaaaa",
            views: [{ id: "tab-aaaaaa", kind: "plugin", title: "T", pluginId: "p", view: "content" }],
          },
        },
      },
    ],
  } as never;
}

function restored() {
  let split = 0;
  return deserializeWorkspace(stored(), () => `spl-fixed${split++}`);
}

describe("every identifier the restore reads", () => {
  it("is minted again, and no stored one survives", () => {
    const workspace = restored();
    const space = workspace.spaces[0]!;
    const leaf = space.layout as { type: "leaf"; value: { id: string; tabs: { id: string }[] } };

    const carried = new Set(["wsp-aaaaaa", "spc-aaaaaa", "pan-aaaaaa", "tab-aaaaaa"]);
    for (const id of [workspace.id, space.id, leaf.value.id, leaf.value.tabs[0]!.id]) {
      expect(carried.has(id), `${id} is a stored id that survived`).toBe(false);
      expect(id).toMatch(N1);
    }
    expect(workspace.id.startsWith(ID_PREFIX.workspace)).toBe(true);
    expect(space.id.startsWith(ID_PREFIX.space)).toBe(true);
    expect(leaf.value.id.startsWith(ID_PREFIX.pane)).toBe(true);
    expect(leaf.value.tabs[0]!.id.startsWith(ID_PREFIX.tab)).toBe(true);
  });

  // Minting without rewriting the references is worse than not minting: the
  // active pane, the active tab, the rail binding and the maximized tab would
  // each name something that is gone, and the failure is a pane that renders
  // nothing rather than an error anywhere.
  it("points every reference at the id that was minted for it", () => {
    const workspace = restored();
    const space = workspace.spaces[0]!;
    const leaf = space.layout as { type: "leaf"; value: { id: string; activeTabId: string; tabs: { id: string }[] } };
    const tab = leaf.value.tabs[0]!;

    expect(workspace.activeSpaceId).toBe(space.id);
    expect(space.activePaneId).toBe(leaf.value.id);
    expect(leaf.value.activeTabId).toBe(tab.id);
    expect(space.railBindingTabId).toBe(tab.id);
    expect(space.maximizedTabId).toBe(tab.id);
  });

  it("keeps the root, which is the identity that survives a restart", () => {
    expect(restored().root).toBe("/workspaces/one");
  });

  it("mints again on a second restore, so no value survives two restarts", () => {
    expect(restored().id).not.toBe(restored().id);
  });
});
