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


const leafGroup = (gid: string, vid: string): PaneNode => ({
  type: "leaf",
  value: {
    id: gid,
    activeTabId: vid,
    tabs: [
      { id: vid, kind: "plugin", title: "B", pluginId: "soksak-plugin-browser-fixture", view: "content" },
    ],
  },
});

let sid = 0;
const newSplitId = () => `spl-${sid++}`;
void newSplitId;

const proj = (id: string, root: string): Workspace => ({
  id,
  title: id,
  root,
  regionOpen: { left: false, rail: true, right: false },
  sidebarLayouts: { left: { type: "leaf", value: { viewKeys: [], activeViewKey: "" } }, rail: { type: "leaf", value: { viewKeys: [], activeViewKey: "" } }, right: { type: "leaf", value: { viewKeys: [], activeViewKey: "" } } },
  activeSpaceId: "spc-aaaaaa",
  spaces: [{ id: "spc-aaaaaa", title: "1", activePaneId: "pan-aaaaaa", layout: leafGroup("pan-aaaaaa", "tab-aaaaaa") }],
});

describe("snapshot/restore round trip per window", () => {
  it("workspaces and activeId are preserved", () => {
    sid = 0;
    const workspaces = [proj("wsp-aaaaaa", "/a"), proj("wsp-bbbbbb", "/b")];
    const snap = snapshotWindow(workspaces, "wsp-bbbbbb");
    const back = restoreWindow(snap);
    expect(back.activeId).toBe("wsp-bbbbbb");
    expect(back.workspaces.map((t) => t.root)).toEqual(["/a", "/b"]);
    expect(back.workspaces.map((t) => t.id)).toEqual(["wsp-aaaaaa", "wsp-bbbbbb"]);
  });

  it("an activeId absent from the restored set falls back to the first workspace", () => {
    sid = 0;
    const snap = snapshotWindow([proj("wsp-aaaaaa", "/a")], "tZ");
    expect(restoreWindow(snap).activeId).toBe("wsp-aaaaaa");
  });

  it("an empty window restores empty", () => {
    const snap = snapshotWindow([], "");
    const back = restoreWindow(snap);
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
