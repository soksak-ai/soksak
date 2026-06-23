import { describe, it, expect } from "vitest";
import { serializeProject, deserializeProject } from "./workspaceSnapshot";
import type { ProjectTab, GroupNode, View } from "./sessions";

// 직렬화 라운드트립 — GroupNode serializeSplitTree 경로. id 보존, split id 만 재생성,
// live status 제외. 구조·순서·sizes·active·view 파라미터 보존이 불변식. 터미널도 플러그인 뷰다.

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
  leftLayout: { type: "leaf", value: { viewKeys: [], activeViewKey: "" } },
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
                  kind: "plugin",
                  title: "T",
                  pluginId: "soksak-plugin-terminal",
                  view: "content",
                  command: "claude", // 자동 실행 명령(영속 제외 — 복원 시 재실행 안 함)
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
                { id: "v3", kind: "plugin", title: "B", pluginId: "soksak-plugin-browser", view: "content" },
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
  it("구조·sizes·active·view 파라미터 보존, split id 만 재생성, 터미널 command 미영속", () => {
    sid = 0;
    const snap = serializeProject(project);
    // split id 는 직렬화에 담기지 않는다(복원 시 재생성).
    expect(JSON.stringify(snap)).not.toContain("gs1");
    // command(자동 실행)는 영속하지 않는다(A6: 복원 터미널은 재실행 안 함).
    expect(JSON.stringify(snap)).not.toContain("claude");

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
    const term = g1.views[0] as Extract<View, { kind: "plugin" }>;
    expect(term.kind).toBe("plugin");
    expect(term.pluginId).toBe("soksak-plugin-terminal");
    expect(term.view).toBe("content");
    // 복원된 터미널은 command 를 갖지 않는다(자동 재실행 방지).
    expect(term.command).toBeUndefined();

    const g2 = leafOf(c.layout, 1);
    expect(g2.views.map((v) => v.kind)).toEqual(["file", "plugin", "plugin"]);
    const file = g2.views[0] as Extract<View, { kind: "file" }>;
    expect(file.path).toBe("/repo/a.ts");
    expect(file.mode).toBe("code");
    const webview = g2.views[1] as Extract<View, { kind: "plugin" }>;
    expect(webview.pluginId).toBe("soksak-plugin-browser");
    expect(webview.view).toBe("content");
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
                  kind: "plugin",
                  title: "T",
                  pluginId: "soksak-plugin-terminal",
                  view: "content",
                  status: { code: "busy", message: "재생 중" },
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
