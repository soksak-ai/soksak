import { describe, it, expect, beforeEach } from "vitest";
import { useSessions } from "./sessions";
import { splitLeaf, leavesOf } from "./splitTree";

// 회귀: reload 후 빈 탭(빈 그룹)이 남은 content 에 split 으로 뷰를 추가하고 그 뷰를 닫으면,
// removeView 가 views.length===0 인 그룹을 무차별 제거해 닫는 뷰의 그룹 + 원래 빈 그룹이 함께
// 사라져 tree=null 이 된다. closeView 가 그 경로를 `if(!tree) return s` 로 흘려보내면 r 이 초기값
// noProject 로 남아 "프로젝트 없음" 이라는 거짓 에러를 낸다(실제론 프로젝트가 멀쩡함).
beforeEach(() => {
  useSessions.setState({ tabs: [], activeId: "" });
});

describe("closeView — split 한쪽이 빈 탭", () => {
  it("빈 그룹과 split 된 뷰를 닫으면 빈 탭으로 유지(거짓 '프로젝트 없음' 금지)", () => {
    // bootstrap: t1, content = splitLeaf(빈 그룹) — 빈 탭(순수 스켈레톤)
    useSessions.getState().bootstrapFirstProject("/test/root");
    const base = useSessions.getState().tabs.find((x) => x.id === "t1")!;
    const content = base.contents[0];
    const emptyGroup = leavesOf(content.layout)[0]; // { views:[], activeViewId:"" }

    // content.layout 을 split(빈 그룹, 뷰 1개 그룹) 으로 직접 구성(실앱의 split 결과와 동형).
    const view = {
      id: "v99",
      kind: "plugin" as const,
      title: "T",
      pluginId: "p",
      view: "content",
    };
    const viewGroup = { id: "g99", views: [view], activeViewId: "v99" };
    const layout = {
      type: "split" as const,
      id: "s1",
      dir: "row" as const,
      sizes: [0.5, 0.5],
      children: [splitLeaf(emptyGroup), splitLeaf(viewGroup)],
    };
    useSessions.setState({
      tabs: [
        { ...base, contents: [{ ...content, layout, activeGroupId: "g99" }] },
      ],
    });

    // 새 뷰를 닫으면 content 가 통째로 비어 tree=null — 빈 탭으로 유지돼야(프로젝트는 멀쩡).
    const r = useSessions.getState().closeView("t1", "v99");
    expect(r.ok).toBe(true);

    // 프로젝트·컨텐츠는 살아있다(빈 탭 = 정당한 스켈레톤 상태).
    const after = useSessions.getState().tabs.find((x) => x.id === "t1");
    expect(after).toBeTruthy();
    expect(after!.contents.length).toBe(1);
  });
});
