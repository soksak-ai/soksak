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
        layout: {
          t: "s",
          id: "spl-stored",
          dir: "row",
          sizes: [1],
          children: [
            {
              t: "l",
              v: {
                id: "pan-aaaaaa",
                activeViewId: "tab-aaaaaa",
                views: [{ id: "tab-aaaaaa", kind: "plugin", title: "T", pluginId: "p", view: "content" }],
              },
            },
          ],
        },
      },
    ],
  } as never;
}

function restored() {
  let split = 0;
  return deserializeWorkspace(stored(), () => `spl-fresh${split++}`);
}

describe("what a restore carries across", () => {
  it("keeps the pane id, which is half a terminal session's key", () => {
    const workspace = restored();
    const space = workspace.spaces[0]!;
    const branch = space.layout as { type: "split"; children: unknown[] };
    const leaf = branch.children[0] as { type: "leaf"; value: { id: string; tabs: { id: string }[] } };

    expect(leaf.value.id).toBe("pan-aaaaaa");
    expect(leaf.value.tabs[0]!.id).toBe("tab-aaaaaa");
  });

  it("keeps the workspace and space ids, and every reference to them", () => {
    const workspace = restored();
    const space = workspace.spaces[0]!;

    expect(workspace.id).toBe("wsp-aaaaaa");
    expect(space.id).toBe("spc-aaaaaa");
    expect(workspace.activeSpaceId).toBe("spc-aaaaaa");
    expect(space.activePaneId).toBe("pan-aaaaaa");
    expect(space.railBindingTabId).toBe("tab-aaaaaa");
  });

});

// The split node is not an exception either.
//
// It was the one id this build minted again, on the ground that it "appears in
// no address, command or document". Measured 2026-08-16 on the running
// application: it appears in none of those — and it was not in the snapshot
// either, so it was not an exception to the rule so much as a value outside it.
//
// One rule is worth more than an exception nobody can act on. Every id this
// product issues survives a restart, so nothing has to know which kind it is
// holding before deciding whether the name it has will still be there.
it("keeps the split node id too, so the rule has no exception", () => {
  const first = restored().spaces[0]!.layout as { type: "split"; id: string };
  const second = restored().spaces[0]!.layout as { type: "split"; id: string };

  expect(first.id).toBe("spl-stored");
  // And twice, so this is the stored value rather than a generator that happens
  // to start at the same place.
  expect(second.id).toBe("spl-stored");
});
