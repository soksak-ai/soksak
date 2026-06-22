// paneToView(M5) — paneId → 그 pane 을 가진 터미널 뷰의 {projectId, viewId}. 순수함수.
import { describe, expect, it } from "vitest";
import { paneToView, type ProjectTab, type View } from "./sessions";

const term = (viewId: string, paneId: string): View => ({
  id: viewId,
  kind: "terminal",
  title: "T",
  layout: { type: "leaf", value: paneId },
  focusedPaneId: paneId,
});

const tab = (id: string, views: View[]): ProjectTab => ({
  id,
  title: id,
  sidebarOpen: false,
  rightOpen: false,
  rightView: null,
  leftLayout: { type: "leaf", value: { viewKeys: [], activeViewKey: "" } },
  root: "/r",
  contents: [
    {
      id: "c1",
      title: "1",
      layout: {
        type: "leaf",
        value: { id: "g1", views, activeViewId: views[0]?.id ?? "" },
      },
      activeGroupId: "g1",
    },
  ],
  activeContentId: "c1",
});

describe("paneToView", () => {
  it("leaf pane 을 가진 터미널 뷰를 찾는다", () => {
    const tabs = [tab("t1", [term("v1", "p1")])];
    expect(paneToView(tabs, "p1")).toEqual({ projectId: "t1", viewId: "v1" });
  });

  it("split 안의 pane 도 찾는다", () => {
    const split: View = {
      id: "v2",
      kind: "terminal",
      title: "T",
      layout: {
        type: "split",
        id: "ps1",
        dir: "row",
        sizes: [0.5, 0.5],
        children: [
          { type: "leaf", value: "pa" },
          { type: "leaf", value: "pb" },
        ],
      },
      focusedPaneId: "pa",
    };
    const tabs = [tab("t1", [split])];
    expect(paneToView(tabs, "pb")).toEqual({ projectId: "t1", viewId: "v2" });
  });

  it("없는 pane 은 null", () => {
    const tabs = [tab("t1", [term("v1", "p1")])];
    expect(paneToView(tabs, "nope")).toBeNull();
  });
});
