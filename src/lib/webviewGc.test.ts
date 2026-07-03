// webviewGc — webview 회수 불변식의 순수 핵(collectWebviewLabels) 단위검증.
// 불변식: live label 집합 = "native surface 소유를 매니페스트로 선언한"(contributes.views[].
// nativeSurface=true) 플러그인 콘텐츠 뷰 집합. 소유는 하드코딩 id 가 아니라 선언(ownsSurface 술어)
// 에서 온다 — 코어가 특정 플러그인 이름을 알면 강결합(플러그인/코어 분리 원칙 위반).
// 이 형태를 못 세면 살아있는 webview 를 고아로 오인해 회수하거나(잘못된 회수), 죽은 webview 를
// 못 잡는다(고아 누수).

import { describe, expect, it } from "vitest";
import { collectWebviewLabels, type OwnsSurface } from "./webviewGc";
import { splitLeaf } from "../state/splitTree";
import type { ProjectTab, View, ViewGroup, ContentArea } from "../state/sessions";

// 테스트 label 더블: 창 네임스페이스(currentWindowLabel) 비의존 — viewId 를 그대로 b-<id> 로.
// 인라인 템플릿이 아니라 문자열 결합으로 구성한다(단일 진실 가드는 인라인 템플릿만 막는다 —
// 이건 실제 label 스킴 재정의가 아니라 주입형 테스트 더블).
const labelOf = (viewId: string) => "b-".concat(viewId);

// 선언 더블 — 매니페스트 contributes.views[].nativeSurface 의 형상 그대로:
// pluginId → (플러그인 내 view id → nativeSurface). 실런타임 술어는 usePlugins 매니페스트에서 파생.
const decls: Record<string, Record<string, boolean>> = {
  "soksak-plugin-browser-native": { content: true },
  // 프레임 스트리밍류 엔진: 뷰는 있으나 native child surface 를 만들지 않음(DOM canvas) — 비소유 선언.
  "soksak-plugin-browser-canvas": { content: false },
  "soksak-plugin-terminal": { content: false },
};
const ownsSurface: OwnsSurface = (pluginId, viewId) =>
  decls[pluginId]?.[viewId] === true;

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

const pluginView = (id: string, pluginId: string, view = "content"): View => ({
  id,
  kind: "plugin",
  title: "P",
  pluginId,
  view,
});

describe("collectWebviewLabels — 선언(nativeSurface) 기반 webview 소유 뷰 label 집합", () => {
  it("nativeSurface 선언 뷰의 label 을 센다(누락하면 고아 오인 회수 — 회귀 가드)", () => {
    const live = collectWebviewLabels(
      [tab([pluginView("v2", "soksak-plugin-browser-native")])],
      ownsSurface,
      labelOf,
    );
    expect([...live]).toEqual(["b-v2"]);
  });

  it("비소유 선언 뷰(터미널·미선언 플러그인)는 세지 않는다", () => {
    const live = collectWebviewLabels(
      [tab([pluginView("v3", "soksak-plugin-terminal"), pluginView("v4", "soksak-plugin-other")])],
      ownsSurface,
      labelOf,
    );
    expect(live.size).toBe(0);
  });

  it("소유·비소유 엔진 공존 시 선언된 쪽만 센다", () => {
    const live = collectWebviewLabels(
      [
        tab([
          pluginView("v1", "soksak-plugin-browser-native"),
          pluginView("v2", "soksak-plugin-browser-canvas"),
        ]),
      ],
      ownsSurface,
      labelOf,
    );
    expect(live).toEqual(new Set(["b-v1"]));
  });

  it("nativeSurface=false 선언 뷰는 세지 않는다(DOM canvas 류 — GC 대상 아님)", () => {
    const live = collectWebviewLabels(
      [tab([pluginView("v5", "soksak-plugin-browser-canvas")])],
      ownsSurface,
      labelOf,
    );
    expect(live.size).toBe(0);
  });

  it("같은 플러그인이라도 선언 안 된 view id 는 세지 않는다(뷰 단위 선언)", () => {
    const live = collectWebviewLabels(
      [tab([pluginView("v6", "soksak-plugin-browser-native", "settings")])],
      ownsSurface,
      labelOf,
    );
    expect(live.size).toBe(0);
  });

  it("여러 콘텐츠/그룹에 흩어진 소유 뷰를 전부 모은다", () => {
    const t: ProjectTab = {
      ...tab([pluginView("v1", "soksak-plugin-browser-native")]),
      contents: [
        content([pluginView("v1", "soksak-plugin-browser-native")]),
        content([pluginView("v2", "soksak-plugin-browser-native")]),
      ],
    };
    // 두 번째 content 의 id 충돌 회피
    t.contents[1] = { ...t.contents[1], id: "c2" };
    const live = collectWebviewLabels([t], ownsSurface, labelOf);
    expect(live).toEqual(new Set(["b-v1", "b-v2"]));
  });
});
