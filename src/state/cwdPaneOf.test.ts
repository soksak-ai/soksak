// cwdPaneOf — 파일트리가 따라갈 터미널 pane 을 generic 하게 고른다. 터미널 판정은 주입된
// hasPty(id) predicate 로만(플러그인 터미널 = view.id). pluginId·kind 하드코딩 없음.
import { describe, expect, it } from "vitest";
import { cwdPaneOf, type ProjectTab, type View } from "./sessions";

const plugin = (viewId: string, pluginId: string, view: string): View => ({
  id: viewId,
  kind: "plugin",
  title: "P",
  pluginId,
  view,
});

const file = (viewId: string, path: string): View => ({
  id: viewId,
  kind: "file",
  title: "F",
  path,
  mode: "code",
});

// 단일 그룹(g1)에 views, 활성 뷰 = activeViewId(기본 첫 뷰).
const tab = (views: View[], activeViewId?: string): ProjectTab => ({
  id: "t1",
  title: "t1",
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
        value: {
          id: "g1",
          views,
          activeViewId: activeViewId ?? views[0]?.id ?? "",
        },
      },
      activeGroupId: "g1",
    },
  ],
  activeContentId: "c1",
});

describe("cwdPaneOf", () => {
  // 플러그인 터미널: paneId = view.id. hasPty(view.id) 가 true 면 그 id 를 따라간다.
  it("플러그인 터미널(활성)을 view.id 로 따라간다 — pluginId 무관", () => {
    const t = tab([plugin("v9", "soksak-plugin-terminal-xterm", "content")]);
    const hasPty = (id: string) => id === "v9";
    expect(cwdPaneOf(t, hasPty)).toBe("v9");
  });

  // 활성 뷰가 터미널이면 그것을 우선(비활성 터미널보다).
  it("활성 뷰가 터미널이면 그 pane 우선", () => {
    const t = tab(
      [plugin("v1", "p", "content"), plugin("v2", "p", "content")],
      "v2",
    );
    const hasPty = (id: string) => id === "v1" || id === "v2";
    expect(cwdPaneOf(t, hasPty)).toBe("v2");
  });

  // 활성 뷰가 비터미널(파일)이면 그룹 안 아무 터미널 뷰로 폴백.
  it("활성 뷰가 비터미널이면 아무 터미널 뷰로 폴백", () => {
    const t = tab([file("v1", "/r/a.ts"), plugin("v2", "p", "content")], "v1");
    const hasPty = (id: string) => id === "v2";
    expect(cwdPaneOf(t, hasPty)).toBe("v2");
  });

  // PTY 관찰이 없는 플러그인 뷰(터미널 아님)는 무시 — generic 신호가 핵심.
  it("PTY 관찰 없는 뷰만 있으면 undefined", () => {
    const t = tab([file("v1", "/r/a.ts"), plugin("v2", "other", "panel")]);
    const hasPty = () => false;
    expect(cwdPaneOf(t, hasPty)).toBeUndefined();
  });
});
