// 플러그인 뷰 호스트 DOM 앵커 계약 — 코어가 발급한 식별자를 DOM 에서 역참조 가능하게 노출.
// 회귀 방지: 942ae86(내장 터미널 → 플러그인) 에서 data-pane-id 앵커가 누락돼 paneId 로 host 를
// 찾는 오버레이 플러그인(claude-gui)이 깨졌다. 이 계약을 못박아 재발을 차단한다.
import { describe, expect, it } from "vitest";
import { viewHostAnchors } from "./viewHostAnchors";

describe("viewHostAnchors — 콘텐츠 뷰 호스트 DOM 앵커 계약", () => {
  it("data-view-addr 는 모든 배치에서 노드 스캔 baseAddress 로 노출", () => {
    expect(viewHostAnchors("content/view/soksak-plugin-x.main", "v8")).toMatchObject({
      "data-view-addr": "content/view/soksak-plugin-x.main",
    });
  });

  it("콘텐츠 배치(viewId 有)는 paneId 역참조 앵커(data-pane-id)를 노출", () => {
    // command.started·statusBarItem 이 발급한 paneId(=콘텐츠 뷰 인스턴스 id)로 플러그인이
    // 이 host 를 querySelector('[data-pane-id="v8"]') 로 찾는다(대칭성).
    expect(viewHostAnchors("content/view/soksak-plugin-terminal-xterm.content", "v8")).toEqual({
      "data-view-addr": "content/view/soksak-plugin-terminal-xterm.content",
      "data-pane-id": "v8",
    });
  });

  it("사이드바 배치(viewId 없음)는 data-pane-id 를 노출 안 함 — 추종 paneId 와 혼동 방지", () => {
    // 사이드바 호스트의 paneId 는 '추종 대상 터미널'이지 자기 인스턴스 id 가 아니다. 앵커 부재.
    expect(viewHostAnchors("left/view/soksak-plugin-file-tree.tree", null)).toEqual({
      "data-view-addr": "left/view/soksak-plugin-file-tree.tree",
    });
  });
});
