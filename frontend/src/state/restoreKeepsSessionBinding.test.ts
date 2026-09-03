// A view's coordinate answers "is there a session here". The session id answers "which session".
// They are different questions, and a component that used one for the other loses sessions when the
// coordinate changes.
//
// Measured 2026-08-16: a terminal session looked up by `windowLabel + "|" + paneId` alone could not
// be reattached after a restore issued new pane ids, while the shell was still running and still
// holding its output. The daemon's own id was unaffected; nothing had recorded it.
//
// So the core records the id beside the coordinate. A lookup by coordinate that finds nothing falls
// to the recorded id, and a session whose coordinate changed is still addressable.
import { describe, expect, it } from "vitest";

import { deserializeWorkspace, serializeWorkspace } from "./windowSnapshot";

function storedWithSession(paneId: string) {
  return {
    id: "wsp-aaaaaa",
    title: "one",
    root: "/workspaces/one",
    regionOpen: { left: false, rail: true, right: false },
    sidebarLayouts: {
      left: { t: "l", v: { id: "grp-a", views: [], activeViewId: "" } },
      rail: { t: "l", v: { id: "grp-a", views: [], activeViewId: "" } },
      right: { t: "l", v: { id: "grp-a", views: [], activeViewId: "" } },
    },
    railPlacementNormalized: true,
    vlNormalized: true,
    activeContentId: "spc-aaaaaa",
    contents: [
      {
        id: "spc-aaaaaa",
        title: "1",
        activeGroupId: paneId,
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
                id: paneId,
                activeViewId: "tab-aaaaaa",
                views: [
                  {
                    id: "tab-aaaaaa",
                    kind: "plugin",
                    title: "T",
                    pluginId: "p",
                    view: "content",
                    session: { owner: "pty", id: "101552085244916" },
                  },
                ],
              },
            },
          ],
        },
      },
    ],
  } as never;
}

function viewOf(workspace: ReturnType<typeof deserializeWorkspace>) {
  const space = workspace.spaces[0]!;
  const branch = space.layout as { type: "split"; children: unknown[] };
  const leaf = branch.children[0] as {
    type: "leaf";
    value: { tabs: { session?: { owner: string; id: string } }[] };
  };
  return leaf.value.tabs[0]!;
}

describe("the session a view is bound to", () => {
  it("survives a restore", () => {
    const view = viewOf(deserializeWorkspace(storedWithSession("pan-aaaaaa")));

    expect(view.session).toEqual({ owner: "pty", id: "101552085244916" });
  });

  it("is the same binding under a different pane id", () => {
    const first = viewOf(deserializeWorkspace(storedWithSession("pan-aaaaaa")));
    const second = viewOf(deserializeWorkspace(storedWithSession("pan-zzzzzz")));

    expect(second.session).toEqual(first.session);
  });

  it("is written back out, so the next restore reads it too", () => {
    const workspace = deserializeWorkspace(storedWithSession("pan-aaaaaa"));
    const again = viewOf(deserializeWorkspace(serializeWorkspace(workspace) as never));

    expect(again.session).toEqual({ owner: "pty", id: "101552085244916" });
  });

  it("is absent on a view no session is bound to", () => {
    const stored = storedWithSession("pan-aaaaaa") as never as {
      contents: { layout: { children: { v: { views: { session?: unknown }[] } }[] } }[];
    };
    delete stored.contents[0]!.layout.children[0]!.v.views[0]!.session;

    expect(viewOf(deserializeWorkspace(stored as never)).session).toBeUndefined();
  });
});
