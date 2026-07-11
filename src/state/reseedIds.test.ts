import { describe, it, expect } from "vitest";
import {
  reseedIdCounters,
  newIds,
  type ProjectTab,
  type GroupNode,
} from "./sessions";

// reseedIdCounters — 복원된 트리의 보존 id 위로 카운터를 올린다(신규 생성 충돌 방지).
// newIds 는 테스트용 카운터 스냅샷(다음 생성 id 미리보기). 보존 최대치+1 이어야 한다.
// 코어 터미널 제거 후 pane(p*) 축은 없다 — 터미널도 플러그인 뷰(id=v*)다.

const termGroup = (gid: string, vid: string): GroupNode => ({
  type: "leaf",
  value: {
    id: gid,
    activeViewId: vid,
    views: [
      {
        id: vid,
        kind: "plugin",
        title: "T",
        pluginId: "soksak-plugin-terminal-xterm",
        view: "content",
      },
    ],
  },
});

const tab = (id: string, layout: GroupNode, contentId = "c1"): ProjectTab => ({
  id,
  title: id,
  root: "/r",
  sidebarOpen: false,
  rightOpen: false,
  rightView: null,
  leftLayout: { type: "leaf", value: { viewKeys: [], activeViewKey: "" } },
  activeContentId: contentId,
  contents: [{ id: contentId, title: "1", activeGroupId: "g1", layout }],
});

describe("reseedIdCounters", () => {
  it("보존 id 최대치+1 로 카운터 reseed (단순)", () => {
    const tabs = [tab("t5", termGroup("g3", "v7"), "c9")];
    reseedIdCounters(tabs);
    const next = newIds();
    expect(next.project).toBe("t6");
    expect(next.view).toBe("v8");
    expect(next.group).toBe("g4");
    expect(next.content).toBe("c10");
  });

  it("그룹 split id 도 스캔", () => {
    const layout: GroupNode = {
      type: "split",
      id: "s12",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [termGroup("g1", "v1"), termGroup("g2", "v2")],
    };
    reseedIdCounters([tab("t1", layout)]);
    expect(newIds().split).toBe("s13"); // 12+1
    expect(newIds().view).toBe("v3"); // max(1,2)+1
  });

  it("여러 프로젝트 전역 최대치", () => {
    const tabs = [
      tab("t2", termGroup("g1", "v1")),
      tab("t9", termGroup("g5", "v3")),
    ];
    reseedIdCounters(tabs);
    expect(newIds().project).toBe("t10");
    expect(newIds().group).toBe("g6");
  });
});
