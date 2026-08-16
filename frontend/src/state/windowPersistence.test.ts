import { describe, it, expect } from "vitest";
import {
  setManifestFocused,
  snapshotWindow,
  restoreWindow,
  windowManifestEntry,
  upsertManifest,
  type WindowManifest,
} from "./windowPersistence";
import type { Workspace, PaneNode } from "./sessions";

let sid = 0;
const newSplitId = () => `S${++sid}`;

const leafGroup = (gid: string, vid: string): PaneNode => ({
  type: "leaf",
  value: {
    id: gid,
    activeTabId: vid,
    tabs: [
      { id: vid, kind: "plugin", title: "B", pluginId: "soksak-plugin-browser-native", view: "content" },
    ],
  },
});

const proj = (id: string, root: string): Workspace => ({
  id,
  title: id,
  root,
  sidebarOpen: true,
  rightOpen: false,
  rightView: null,
  leftLayout: { type: "leaf", value: { viewKeys: [], activeViewKey: "" } },
  activeSpaceId: "spc-aaaaaa",
  spaces: [{ id: "spc-aaaaaa", title: "1", activePaneId: "pan-aaaaaa", layout: leafGroup("pan-aaaaaa", "tab-aaaaaa") }],
});

describe("snapshot/restore round trip per window", () => {
  it("workspaces and activeId are preserved", () => {
    sid = 0;
    const workspaces = [proj("wsp-aaaaaa", "/a"), proj("wsp-bbbbbb", "/b")];
    const snap = snapshotWindow(workspaces, "wsp-bbbbbb");
    const back = restoreWindow(snap, newSplitId);
    // The roots survive; the ids are minted again (RESTORE R3) and the active one follows the
    // workspace that was active rather than the name it had.
    expect(back.workspaces.map((t) => t.root)).toEqual(["/a", "/b"]);
    expect(back.workspaces.map((t) => t.id)).not.toEqual(["wsp-aaaaaa", "wsp-bbbbbb"]);
    for (const t of back.workspaces) expect(t.id).toMatch(/^wsp-[a-z2-7]{6}$/);
    expect(back.activeId).toBe(back.workspaces[1]!.id);
    expect(back.workspaces.find((t) => t.id === back.activeId)?.root).toBe("/b");
  });

  it("an activeId absent from the restored set falls back to the first workspace", () => {
    sid = 0;
    const snap = snapshotWindow([proj("wsp-aaaaaa", "/a")], "wsp-zzzzzz");
    const back = restoreWindow(snap, newSplitId);
    expect(back.activeId).toBe(back.workspaces[0]!.id);
  });

  it("an empty window restores empty", () => {
    const snap = snapshotWindow([], "");
    const back = restoreWindow(snap, newSplitId);
    expect(back.workspaces).toEqual([]);
    expect(back.activeId).toBe("");
  });
});

describe("windowManifestEntry", () => {
  it("label + roots + activeRoot", () => {
    const workspaces = [proj("wsp-aaaaaa", "/a"), proj("wsp-bbbbbb", "/b")];
    expect(windowManifestEntry("main", workspaces, "wsp-bbbbbb")).toEqual({
      label: "main",
      roots: ["/a", "/b"],
      activeRoot: "/b",
    });
  });
});

describe("upsertManifest", () => {
  const base: WindowManifest = {
    slots: [{ label: "main", roots: ["/a"], activeRoot: "/a" }],
  };

  it("a slot with the same label is replaced", () => {
    const r = upsertManifest(base, { label: "main", roots: ["/x"], activeRoot: "/x" });
    expect(r.slots).toEqual([{ label: "main", roots: ["/x"], activeRoot: "/x" }]);
  });

  it("a new label is appended", () => {
    const r = upsertManifest(base, { label: "win-1", roots: ["/y"], activeRoot: "/y" });
    expect(r.slots).toHaveLength(2);
    expect(r.slots.map((s) => s.label).sort()).toEqual(["main", "win-1"]);
  });

  it("empty roots remove the slot (window closed)", () => {
    const r = upsertManifest(base, { label: "main", roots: [], activeRoot: null });
    expect(r.slots).toEqual([]);
  });
});

describe("manifest rect and focused (B2 multi-window restore)", () => {
  it("upsert preserves a rect set on the entry", () => {
    const m = upsertManifest(
      { slots: [] },
      { label: "win-1", roots: ["/a"], activeRoot: "/a", rect: { x: 10, y: 20, w: 800, h: 600 } },
    );
    expect(m.slots[0].rect).toEqual({ x: 10, y: 20, w: 800, h: 600 });
  });

  it("focusedLabel is top level in the manifest — setManifestFocused updates and keeps it", () => {
    let m: WindowManifest = { slots: [] };
    m = upsertManifest(m, { label: "main", roots: ["/m"], activeRoot: "/m" });
    m = setManifestFocused(m, "main");
    expect(m.focusedLabel).toBe("main");
    // upsert of another window does not clear focusedLabel.
    m = upsertManifest(m, { label: "win-1", roots: ["/a"], activeRoot: "/a" });
    expect(m.focusedLabel).toBe("main");
    m = setManifestFocused(m, "win-1");
    expect(m.focusedLabel).toBe("win-1");
  });
});

// What follows the minting, and what would break silently if it did not.
//
// Every id is minted again on restore (RESTORE R3). Two values name a workspace
// by id and are read after the minting, so each is a way for a restore to come
// back subtly wrong with nothing reporting it:
//
//   the active workspace — matched on the stored name it falls through to the
//   first workspace every time, and a person finds the wrong one open;
//   the projection seed — keyed by the stored name it seeds a workspace that
//   does not exist, and a pinned rail comes back unpinned.
describe("the references that outlive the names", () => {
  it("opens the workspace that was active, not the first one", () => {
    sid = 0;
    const snap = snapshotWindow(
      [proj("wsp-aaaaaa", "/a"), proj("wsp-bbbbbb", "/b"), proj("wsp-cccccc", "/c")],
      "wsp-cccccc",
    );
    const back = restoreWindow(snap, newSplitId);
    expect(back.workspaces.find((t) => t.id === back.activeId)?.root).toBe("/c");
  });

  it("seeds the projection on the workspace that carried it", () => {
    sid = 0;
    const snap = snapshotWindow(
      [proj("wsp-aaaaaa", "/a"), proj("wsp-bbbbbb", "/b")],
      "wsp-aaaaaa",
    );
    // The seed as the store holds it: on the second workspace, under the name that workspace had.
    snap.workspaces[1]!.projection = { mode: "pin", station: 60 } as never;

    const back = restoreWindow(snap, newSplitId);
    const seeded = Object.keys(back.projections);
    expect(seeded).toHaveLength(1);
    // The seed names a workspace in the restored list, and it is the one that held it.
    expect(back.workspaces.find((t) => t.id === seeded[0])?.root).toBe("/b");
  });
});
