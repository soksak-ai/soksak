import { describe, it, expect } from "vitest";
import { serializeProject, deserializeProject } from "./workspaceSnapshot";
import { leavesOf, type SplitTree } from "./splitTree";
import type { ProjectTab, GroupNode, View } from "./sessions";

// 직렬화 라운드트립 — 두 트리(GroupNode·PaneNode) serializeSplitTree 동일 경로. id 보존,
// split id 만 재생성, live status 제외. 구조·순서·sizes·active·view 파라미터·autorun 보존이 불변식.

let sid = 0;
const newSplitId = () => `S${++sid}`;

const leafOf = (n: GroupNode, i: number) => {
  const s = n as Extract<GroupNode, { type: "split" }>;
  const c = s.children[i] as Extract<GroupNode, { type: "leaf" }>;
  return c.value;
};

const project: ProjectTab = {
  id: "t1",
  title: "proj",
  root: "/repo",
  shell: "/bin/zsh",
  sidebarOpen: true,
  rightOpen: false,
  rightView: null,
  leftTab: "files",
  activeContentId: "c1",
  contents: [
    {
      id: "c1",
      title: "build",
      activeGroupId: "g2",
      layout: {
        type: "split",
        id: "gs1",
        dir: "row",
        sizes: [0.6, 0.4],
        children: [
          {
            type: "leaf",
            value: {
              id: "g1",
              activeViewId: "v1",
              views: [
                {
                  id: "v1",
                  kind: "terminal",
                  title: "T",
                  focusedPaneId: "p2",
                  autorun: { paneId: "p1", command: "claude" },
                  layout: {
                    type: "split",
                    id: "ps1",
                    dir: "col",
                    sizes: [0.7, 0.3],
                    children: [
                      { type: "leaf", value: "p1" },
                      { type: "leaf", value: "p2" },
                    ],
                  },
                },
              ],
            },
          },
          {
            type: "leaf",
            value: {
              id: "g2",
              activeViewId: "v3",
              views: [
                { id: "v2", kind: "file", title: "a.ts", path: "/repo/a.ts", mode: "code" },
                { id: "v3", kind: "browser", title: "B", url: "https://x" },
                { id: "v4", kind: "plugin", title: "ERD", pluginId: "soksak-plugin-erd", view: "studio" },
              ],
            },
          },
        ],
      },
    },
  ],
};

describe("workspaceSnapshot 라운드트립", () => {
  it("구조·sizes·active·view 파라미터·터미널 autorun 보존, split id 만 재생성", () => {
    sid = 0;
    const snap = serializeProject(project);
    // split id 는 직렬화에 담기지 않는다(복원 시 재생성).
    expect(JSON.stringify(snap)).not.toContain("gs1");
    expect(JSON.stringify(snap)).not.toContain("ps1");

    const back = deserializeProject(snap, newSplitId);
    expect(back.root).toBe("/repo");
    expect(back.title).toBe("proj");
    expect(back.shell).toBe("/bin/zsh");
    expect(back.sidebarOpen).toBe(true);
    expect(back.activeContentId).toBe("c1");

    const c = back.contents[0];
    expect(c.id).toBe("c1");
    expect(c.title).toBe("build");
    expect(c.activeGroupId).toBe("g2");

    const gl = c.layout as Extract<GroupNode, { type: "split" }>;
    expect(gl.dir).toBe("row");
    expect(gl.sizes).toEqual([0.6, 0.4]);
    expect(gl.id).not.toBe("gs1"); // split id 재생성됨

    const g1 = leafOf(c.layout, 0);
    expect(g1.id).toBe("g1");
    expect(g1.activeViewId).toBe("v1");
    const term = g1.views[0] as Extract<View, { kind: "terminal" }>;
    expect(term.kind).toBe("terminal");
    expect(term.focusedPaneId).toBe("p2");
    // A6: 복원된 터미널 autorun 은 pasteOnly 로 마킹된다(자동 실행 X, 프롬프트 paste).
    expect(term.autorun).toEqual({ paneId: "p1", command: "claude", pasteOnly: true });
    const ps = term.layout as Extract<SplitTree<string>, { type: "split" }>;
    expect(ps.sizes).toEqual([0.7, 0.3]);
    expect(leavesOf(term.layout)).toEqual(["p1", "p2"]);

    const g2 = leafOf(c.layout, 1);
    expect(g2.views.map((v) => v.kind)).toEqual(["file", "browser", "plugin"]);
    const file = g2.views[0] as Extract<View, { kind: "file" }>;
    expect(file.path).toBe("/repo/a.ts");
    expect(file.mode).toBe("code");
    const plug = g2.views[2] as Extract<View, { kind: "plugin" }>;
    expect(plug.pluginId).toBe("soksak-plugin-erd");
    expect(plug.view).toBe("studio");
  });

  it("live status 는 직렬화에서 제외", () => {
    sid = 0;
    const p2: ProjectTab = {
      ...project,
      contents: [
        {
          id: "c1",
          title: "1",
          activeGroupId: "g1",
          layout: {
            type: "leaf",
            value: {
              id: "g1",
              activeViewId: "v1",
              views: [
                {
                  id: "v1",
                  kind: "terminal",
                  title: "T",
                  focusedPaneId: "p1",
                  status: { code: "busy", message: "재생 중" },
                  layout: { type: "leaf", value: "p1" },
                },
              ],
            },
          },
        },
      ],
    };
    const snap = serializeProject(p2);
    expect(JSON.stringify(snap)).not.toContain("busy");
    const back = deserializeProject(snap, newSplitId);
    const g = (back.contents[0].layout as Extract<GroupNode, { type: "leaf" }>).value;
    expect(g.views[0].status).toBeUndefined();
  });
});
