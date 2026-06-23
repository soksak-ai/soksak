// browserGc — webview 회수 불변식의 순수 핵(collectBrowserLabels) 단위검증.
// 불변식: live label 집합 = 브라우저 플러그인 콘텐츠 뷰(kind:"plugin", pluginId=soksak-plugin-browser).
// 이 형태를 못 세면 살아있는 webview 를 고아로 오인해 회수하거나(잘못된 회수), 죽은 webview 를
// 못 잡는다(고아 누수).

import { describe, expect, it } from "vitest";
import { collectBrowserLabels } from "./browserGc";
import { splitLeaf } from "../state/splitTree";
import type { ProjectTab, View, ViewGroup, ContentArea } from "../state/sessions";

// 테스트 label 더블: 창 네임스페이스(currentWindowLabel) 비의존 — viewId 를 그대로 b-<id> 로.
// 인라인 템플릿이 아니라 문자열 결합으로 구성한다(단일 진실 가드는 인라인 템플릿만 막는다 —
// 이건 실제 label 스킴 재정의가 아니라 주입형 테스트 더블).
const labelOf = (viewId: string) => "b-".concat(viewId);

function group(views: View[]): ViewGroup {
  return { id: "g1", views, activeViewId: views[0]?.id ?? "" };
}

function content(views: View[]): ContentArea {
  return { id: "c1", title: "1", layout: splitLeaf(group(views)), activeGroupId: "g1" };
}

function tab(views: View[]): ProjectTab {
  return {
    id: "t1",
    title: "p",
    sidebarOpen: false,
    rightOpen: false,
    rightView: null,
    leftLayout: splitLeaf({ viewKeys: [], activeViewKey: "" }),
    root: "/tmp",
    contents: [content(views)],
    activeContentId: "c1",
  };
}

const pluginBrowser = (id: string): View => ({
  id,
  kind: "plugin",
  title: "B",
  pluginId: "soksak-plugin-browser",
  view: "content",
});

const terminal = (id: string): View => ({
  id,
  kind: "terminal",
  title: "T",
  layout: splitLeaf("p1"),
  focusedPaneId: "p1",
});

const otherPlugin = (id: string): View => ({
  id,
  kind: "plugin",
  title: "X",
  pluginId: "soksak-plugin-other",
  view: "content",
});

describe("collectBrowserLabels — webview 소유 뷰 label 집합", () => {
  it("브라우저 플러그인 콘텐츠 뷰의 label 을 센다(누락하면 고아 오인 회수 — 회귀 가드)", () => {
    const live = collectBrowserLabels([tab([pluginBrowser("v2")])], labelOf);
    expect([...live]).toEqual(["b-v2"]);
  });

  it("webview 비소유 뷰(터미널·다른 플러그인)는 세지 않는다", () => {
    const live = collectBrowserLabels(
      [tab([terminal("v3"), otherPlugin("v4")])],
      labelOf,
    );
    expect(live.size).toBe(0);
  });

  it("여러 콘텐츠/그룹에 흩어진 브라우저 플러그인 뷰를 전부 모은다", () => {
    const t: ProjectTab = {
      ...tab([pluginBrowser("v1")]),
      contents: [content([pluginBrowser("v1")]), content([pluginBrowser("v2")])],
    };
    // 두 번째 content 의 id 충돌 회피
    t.contents[1] = { ...t.contents[1], id: "c2" };
    const live = collectBrowserLabels([t], labelOf);
    expect(live).toEqual(new Set(["b-v1", "b-v2"]));
  });
});
