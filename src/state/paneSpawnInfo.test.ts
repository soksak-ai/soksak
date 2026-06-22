// paneSpawnInfo(A6) — autorun pane 의 spawn 정보. 복원 터미널(pasteOnly)은 명령을 paste-only 로
// 전달한다(자동 실행 X). 신규 autorun(pasteOnly 없음)은 실행. 순수함수.
import { describe, expect, it } from "vitest";
import { paneSpawnInfo, type ProjectTab, type View } from "./sessions";

function tabWith(autorun?: {
  paneId: string;
  command: string;
  pasteOnly?: boolean;
}): ProjectTab {
  const view: View = {
    id: "v1",
    kind: "terminal",
    title: "T",
    focusedPaneId: "p1",
    layout: { type: "leaf", value: "p1" },
    ...(autorun ? { autorun } : {}),
  };
  return {
    id: "t1",
    title: "t1",
    root: "/repo",
    sidebarOpen: false,
    rightOpen: false,
    rightView: null,
    leftTab: "files",
    activeContentId: "c1",
    contents: [
      {
        id: "c1",
        title: "1",
        activeGroupId: "g1",
        layout: {
          type: "leaf",
          value: { id: "g1", activeViewId: "v1", views: [view] },
        },
      },
    ],
  };
}

describe("paneSpawnInfo A6 paste-only", () => {
  it("autorun 없는 pane: cwd/shell 만, command 없음", () => {
    const info = paneSpawnInfo([tabWith()], "p1");
    expect(info.cwd).toBe("/repo");
    expect(info.command).toBeUndefined();
    expect(info.pasteOnly).toBeUndefined();
  });

  it("신규 autorun(pasteOnly 없음): command 전달 + pasteOnly 없음(실행)", () => {
    const info = paneSpawnInfo([tabWith({ paneId: "p1", command: "claude" })], "p1");
    expect(info.command).toBe("claude");
    expect(info.pasteOnly).toBeUndefined();
  });

  it("복원 autorun(pasteOnly:true): command + pasteOnly 전달(붙여넣기만)", () => {
    const info = paneSpawnInfo(
      [tabWith({ paneId: "p1", command: "claude", pasteOnly: true })],
      "p1",
    );
    expect(info.command).toBe("claude");
    expect(info.pasteOnly).toBe(true);
  });

  it("autorun 대상이 아닌 다른 pane 은 command 없음", () => {
    const t = tabWith({ paneId: "p1", command: "claude", pasteOnly: true });
    // 같은 뷰에 다른 pane id 조회(분할 후 두번째 pane 같은 상황의 단순화) — autorun.paneId 와 불일치
    const info = paneSpawnInfo([t], "p1");
    expect(info.command).toBe("claude"); // p1 은 일치
    const none = paneSpawnInfo([t], "p999");
    expect(none.command).toBeUndefined(); // 없는 pane
  });
});
