// A restore keeps the identifiers, because a live thing is keyed by one.
//
// A terminal session's key is `windowLabel + "|" + paneId`
// (soksak-plugin-terminal-xterm, command/session.go — paneKey). A pane that came
// back under a new id cannot reattach to the shell it had: the session is still
// running, still holding its scrollback and its working directory, and nothing
// addresses it any more.
//
// So an id is not a per-run handle. It is issued to be unique and it is kept, and
// keeping it is what lets state hang off it — the shell, and anything a plugin
// stores against a pane or a view.
//
// Measured 2026-08-16: a change that minted every id on restore passed the
// digest check — `state.fingerprint` holds no id, so it cannot see this — while
// breaking the reattach key. The digest is not the whole verdict.
//
// Every id, with no exception. The split node was the one this build minted
// again, on the ground that nothing references it — which left one kind of id
// whose name a restore changed, so a reader had to know which kind it held
// before it could tell whether the name would still be there.
import { describe, expect, it } from "vitest";

import { deserializeWorkspace } from "./windowSnapshot";

function stored() {
  return {
    id: "wsp-aaaaaa",
    title: "one",
    root: "/workspaces/one",
    regionOpen: { left: false, rail: true, right: false },
    railPlacement: { mode: "flow" },
    sidebarLayouts: { left: { t: "l", v: { id: "grp-a", views: [], activeViewId: "" } }, rail: { t: "l", v: { id: "grp-a", views: [], activeViewId: "" } }, right: { t: "l", v: { id: "grp-a", views: [], activeViewId: "" } } },
    activeContentId: "spc-aaaaaa",
    contents: [
      {
        id: "spc-aaaaaa",
        title: "1",
        activeGroupId: "pan-aaaaaa",
        groups: [
          {
            id: "pan-aaaaaa",
            activeViewId: "tab-aaaaaa",
            views: [{ id: "tab-aaaaaa", kind: "plugin", title: "T", pluginId: "p", view: "content" }],
          },
          { id: "pan-bbbbbb", activeViewId: "", views: [] },
        ],
        // a | rail | b: the rail's slot is stored with the plane, so it comes back where it stood.
        plane: {
          xs: [0, 0.5, 0.65, 1],
          ys: [0, 1],
          cards: [
            { id: "pan-aaaaaa", c0: 0, c1: 1, r0: 0, r1: 1 },
            { id: "rail", c0: 1, c1: 2, r0: 0, r1: 1, width: 180, fixed: true },
            { id: "pan-bbbbbb", c0: 2, c1: 3, r0: 0, r1: 1 },
          ],
          paidBy: { "pan-bbbbbb": { side: "lo", to: "pan-aaaaaa" }, rail: { side: "hi", to: "pan-bbbbbb" } },
        },
      },
    ],
  } as never;
}

function restored() {
  return deserializeWorkspace(stored());
}

describe("what a restore carries across", () => {
  it("keeps the pane id, which is half a terminal session's key", () => {
    const workspace = restored();
    const space = workspace.spaces[0]!;

    expect(space.panes[0]!.id).toBe("pan-aaaaaa");
    expect(space.panes[0]!.tabs[0]!.id).toBe("tab-aaaaaa");
    expect(space.layout.cards.map((card) => card.id)).toEqual(["pan-aaaaaa", "rail", "pan-bbbbbb"]);
  });

  it("keeps the workspace and space ids, and every reference to them", () => {
    const workspace = restored();
    const space = workspace.spaces[0]!;

    expect(workspace.id).toBe("wsp-aaaaaa");
    expect(space.id).toBe("spc-aaaaaa");
    expect(workspace.activeSpaceId).toBe("spc-aaaaaa");
    expect(space.activePaneId).toBe("pan-aaaaaa");
  });

});

// The plane is stored as the library states it, and it comes back as stated: the lines, every
// card's span, the rail's slot and width, and which slot each card took its room from.
it("keeps the plane as stored, the rail's slot included", () => {
  const first = restored().spaces[0]!.layout;
  const second = restored().spaces[0]!.layout;

  expect(first.xs).toEqual([0, 0.5, 0.65, 1]);
  expect(first.cards.find((card) => card.id === "rail")).toMatchObject({ c0: 1, c1: 2, width: 180, fixed: true });
  expect(first.paidBy).toEqual({ "pan-bbbbbb": { side: "lo", to: "pan-aaaaaa" }, rail: { side: "hi", to: "pan-bbbbbb" } });
  // And twice, so this is the stored value rather than something computed on the way in.
  expect(second).toEqual(first);
});
