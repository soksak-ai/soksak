import { describe, it, expect } from "vitest";
import {
  reseedIdCounters,
  newIds,
  type ProjectTab,
  type GroupNode,
} from "./sessions";

// reseedIdCounters — 복원된 트리의 보존 id 위로 카운터를 올린다(신규 생성 충돌 방지).
// newIds 는 테스트용 카운터 스냅샷(다음 생성 id 미리보기). 보존 최대치+1 이어야 한다.

const termGroup = (gid: string, vid: string, pid: string): GroupNode => ({
  type: "leaf",
  value: {
    id: gid,
    activeViewId: vid,
    views: [
      {
        id: vid,
        kind: "terminal",
        title: "T",
        focusedPaneId: pid,
        layout: { type: "leaf", value: pid },
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
    const tabs = [tab("t5", termGroup("g3", "v7", "p4"), "c9")];
    reseedIdCounters(tabs);
    const next = newIds();
    expect(next.project).toBe("t6");
    expect(next.view).toBe("v8");
    expect(next.pane).toBe("p5");
    expect(next.group).toBe("g4");
    expect(next.content).toBe("c10");
  });

  it("split id 도 스캔(그룹·pane 양쪽)", () => {
    const layout: GroupNode = {
      type: "split",
      id: "s12",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [
        termGroup("g1", "v1", "p1"),
        {
          type: "leaf",
          value: {
            id: "g2",
            activeViewId: "v2",
            views: [
              {
                id: "v2",
                kind: "terminal",
                title: "T",
                focusedPaneId: "p9",
                layout: {
                  type: "split",
                  id: "s20", // pane split id 가 더 큼
                  dir: "col",
                  sizes: [0.5, 0.5],
                  children: [
                    { type: "leaf", value: "p8" },
                    { type: "leaf", value: "p9" },
                  ],
                },
              },
            ],
          },
        },
      ],
    };
    reseedIdCounters([tab("t1", layout)]);
    expect(newIds().split).toBe("s21"); // max(12,20)+1
    expect(newIds().pane).toBe("p10"); // max(1,8,9)+1
  });

  it("여러 프로젝트 전역 최대치", () => {
    const tabs = [
      tab("t2", termGroup("g1", "v1", "p1")),
      tab("t9", termGroup("g5", "v3", "p2")),
    ];
    reseedIdCounters(tabs);
    expect(newIds().project).toBe("t10");
    expect(newIds().group).toBe("g6");
  });
});
