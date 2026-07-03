import { describe, it, expect } from "vitest";
import {
  setManifestFocused,
  snapshotWindow,
  restoreWindow,
  windowManifestEntry,
  upsertManifest,
  type WindowManifest,
} from "./workspacePersistence";
import type { ProjectTab, GroupNode } from "./sessions";

let sid = 0;
const newSplitId = () => `S${++sid}`;

const leafGroup = (gid: string, vid: string): GroupNode => ({
  type: "leaf",
  value: {
    id: gid,
    activeViewId: vid,
    views: [
      { id: vid, kind: "plugin", title: "B", pluginId: "soksak-plugin-browser-native", view: "content" },
    ],
  },
});

const proj = (id: string, root: string): ProjectTab => ({
  id,
  title: id,
  root,
  sidebarOpen: true,
  rightOpen: false,
  rightView: null,
  leftLayout: { type: "leaf", value: { viewKeys: [], activeViewKey: "" } },
  activeContentId: "c1",
  contents: [{ id: "c1", title: "1", activeGroupId: "g1", layout: leafGroup("g1", "v1") }],
});

describe("snapshot/restore 창 단위 라운드트립", () => {
  it("projects + activeId 보존", () => {
    sid = 0;
    const tabs = [proj("t1", "/a"), proj("t2", "/b")];
    const snap = snapshotWindow(tabs, "t2");
    const back = restoreWindow(snap, newSplitId);
    expect(back.activeId).toBe("t2");
    expect(back.tabs.map((t) => t.root)).toEqual(["/a", "/b"]);
    expect(back.tabs.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("activeId 가 복원본에 없으면 첫 프로젝트로 보정", () => {
    sid = 0;
    const snap = snapshotWindow([proj("t1", "/a")], "tZ");
    expect(restoreWindow(snap, newSplitId).activeId).toBe("t1");
  });

  it("빈 창은 빈 복원", () => {
    const snap = snapshotWindow([], "");
    const back = restoreWindow(snap, newSplitId);
    expect(back.tabs).toEqual([]);
    expect(back.activeId).toBe("");
  });
});

describe("windowManifestEntry", () => {
  it("label + roots + activeRoot", () => {
    const tabs = [proj("t1", "/a"), proj("t2", "/b")];
    expect(windowManifestEntry("main", tabs, "t2")).toEqual({
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

  it("같은 label slot 교체", () => {
    const r = upsertManifest(base, { label: "main", roots: ["/x"], activeRoot: "/x" });
    expect(r.slots).toEqual([{ label: "main", roots: ["/x"], activeRoot: "/x" }]);
  });

  it("새 label 추가", () => {
    const r = upsertManifest(base, { label: "win-1", roots: ["/y"], activeRoot: "/y" });
    expect(r.slots).toHaveLength(2);
    expect(r.slots.map((s) => s.label).sort()).toEqual(["main", "win-1"]);
  });

  it("빈 roots = slot 제거(창 닫힘)", () => {
    const r = upsertManifest(base, { label: "main", roots: [], activeRoot: null });
    expect(r.slots).toEqual([]);
  });
});

describe("manifest rect·focused (B2 멀티윈도우 복원)", () => {
  it("entry 에 rect 를 실으면 upsert 가 보존한다", () => {
    const m = upsertManifest(
      { slots: [] },
      { label: "win-1", roots: ["/a"], activeRoot: "/a", rect: { x: 10, y: 20, w: 800, h: 600 } },
    );
    expect(m.slots[0].rect).toEqual({ x: 10, y: 20, w: 800, h: 600 });
  });

  it("focusedLabel 은 manifest 최상위 — setManifestFocused 로 갱신·유지", () => {
    let m: WindowManifest = { slots: [] };
    m = upsertManifest(m, { label: "main", roots: ["/m"], activeRoot: "/m" });
    m = setManifestFocused(m, "main");
    expect(m.focusedLabel).toBe("main");
    // 다른 창 upsert 가 focusedLabel 을 지우지 않는다.
    m = upsertManifest(m, { label: "win-1", roots: ["/a"], activeRoot: "/a" });
    expect(m.focusedLabel).toBe("main");
    m = setManifestFocused(m, "win-1");
    expect(m.focusedLabel).toBe("win-1");
  });
});
