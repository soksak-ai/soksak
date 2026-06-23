// paneToView(M5) — paneId(=플러그인 터미널 view.id) → {projectId, viewId}. 순수함수.
import { describe, expect, it } from "vitest";
import { paneToView, type ProjectTab, type View } from "./sessions";

// 플러그인 터미널 뷰: paneId = view.id(코어 터미널 제거 후 단일 키).
const term = (viewId: string): View => ({
  id: viewId,
  kind: "plugin",
  title: "T",
  pluginId: "soksak-plugin-terminal",
  view: "content",
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
  it("paneId(=view.id) 로 그 터미널 뷰를 찾는다", () => {
    const tabs = [tab("t1", [term("v1")])];
    expect(paneToView(tabs, "v1")).toEqual({ projectId: "t1", viewId: "v1" });
  });

  it("여러 뷰 중 일치하는 view.id 를 찾는다", () => {
    const tabs = [tab("t1", [term("v1"), term("v2")])];
    expect(paneToView(tabs, "v2")).toEqual({ projectId: "t1", viewId: "v2" });
  });

  it("없는 pane 은 null", () => {
    const tabs = [tab("t1", [term("v1")])];
    expect(paneToView(tabs, "nope")).toBeNull();
  });
});
