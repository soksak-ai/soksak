// The tree answers each place a sidebar can stand in, by name.
//
// It answered `sidebarOpen`, one boolean, from the days when the window had one sidebar and `left`
// named the rail. The window has three places now — its own two edges and the rail between the
// panes — and whether either edge stands could not be asked from outside at all.
//
// Measured 2026-08-19: the left edge was open with a set standing in it, drawing nothing at width
// 0, and the only reading that named it was the DOM. A state a command cannot answer is a state
// that gets argued about from screenshots (C2: command, status, DOM — all three or the feature is
// unfinished).
//
// Read from the places themselves, so a fourth place is answered the day it exists rather than the
// day somebody remembers this file.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => mem.get(key) ?? null,
  setItem: (key: string, value: string) => void mem.set(key, value),
  removeItem: (key: string) => void mem.delete(key),
  clear: () => mem.clear(),
});
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: vi.fn(async () => undefined),
}));

import { registerCatalog } from "./catalog";
import { execute } from "./registry";
import { useSessions, type Workspace } from "../state/sessions";
import { initialSidebarLayout } from "../state/sidebarLayout";
import { SECTION_PLACES } from "../state/sectionSets";

function workspace(open: Record<string, boolean>): Workspace {
  return {
    id: "wsp-aaaaaa",
    title: "P",
    root: "<local-evidence>/w",
    regionOpen: open as Workspace["regionOpen"],
    railPlacement: { mode: "flow" },
    sidebarLayouts: {
      left: initialSidebarLayout([]),
      rail: initialSidebarLayout([]),
      right: initialSidebarLayout([]),
    },
    spaces: [
      {
        id: "spc-aaaaaa",
        title: "1",
        activePaneId: "pan-aaaaaa",
        layout: {
          type: "leaf",
          id: "lea-aaaaaa",
          value: {
            id: "pan-aaaaaa",
            activeTabId: "tab-aaaaaa",
            tabs: [
              {
                id: "tab-aaaaaa",
                kind: "plugin",
                title: "t",
                pluginId: "fixture",
                view: "content",
              },
            ],
          },
        },
      },
    ],
    activeSpaceId: "spc-aaaaaa",
  } as unknown as Workspace;
}

registerCatalog();

const treeWorkspace = async () => {
  const answer = (await execute("state.tree", {}, {})) as unknown as {
    data: { workspaces: Array<Record<string, unknown>> };
  };
  return answer.data.workspaces[0];
};

describe("state.tree — which places are open", () => {
  beforeEach(() => {
    useSessions.setState({
      workspaces: [workspace({ left: true, rail: false, right: true })],
      activeId: "wsp-aaaaaa",
    });
  });

  it("answers one entry per place, named", async () => {
    const w = await treeWorkspace();
    expect(w.regionOpen).toEqual({ left: true, rail: false, right: true });
  });

  it("covers every place there is, without naming them here", async () => {
    // The oracle for the entry above: written out, this file passes on the day a place is added and
    // the tree stops answering for it.
    const w = await treeWorkspace();
    expect(Object.keys(w.regionOpen as object).sort()).toEqual([...SECTION_PLACES].sort());
  });

  it("no longer answers the one boolean that meant the rail", async () => {
    // `sidebarOpen` was the rail under a name that now means the window's left edge. Kept beside
    // the new one, a caller reading it would be told about a place other than the one it named
    // (L11c — the old path is deleted, not carried).
    const w = await treeWorkspace();
    expect(w.sidebarOpen).toBeUndefined();
  });
});
