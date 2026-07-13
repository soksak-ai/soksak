// webviewDisplayName — 사용자 표면(복구 배지 등)에 webview 를 사람 이름으로 표시한다.
// 라벨=매니페스트/콘텐츠 title 원칙(메시지 프로토콜): raw label(b-<창>-<viewId>)을 사용자에게
// 그대로 노출하지 않는다. 이 창의 브라우저 뷰면 탭 표시명(customLabel 우선, title 폴백),
// 대응 뷰가 없으면 label 그대로(사람 이름이 없는 webview 는 식별자가 유일한 사실).
//
// jsdom 에서는 currentWindowLabel() 이 "" 로 폴백하므로 이 창의 브라우저 접두사는 "b--" 다
// (webviewLabels.ts 참조) — 픽스처 label 은 그 접두사를 쓴다.
import { describe, expect, it } from "vitest";
import {
  viewDisplayTitle,
  webviewDisplayName,
  type ProjectTab,
  type View,
} from "./sessions";

const browser = (viewId: string, title: string, customLabel?: string): View => ({
  id: viewId,
  kind: "plugin",
  title,
  customLabel,
  pluginId: "soksak-plugin-browser-native",
  view: "content",
});

const tab = (id: string, views: View[]): ProjectTab => ({
  id,
  title: id,
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
        value: { id: "g1", views, activeViewId: views[0]?.id ?? "" },
      },
      activeGroupId: "g1",
    },
  ],
  activeContentId: "c1",
});

describe("viewDisplayTitle", () => {
  it("customLabel(사용자 의도)이 title(콘텐츠 사실)에 우선한다", () => {
    expect(viewDisplayTitle(browser("v1", "Page", "내 탭"))).toBe("내 탭");
    expect(viewDisplayTitle(browser("v1", "Page"))).toBe("Page");
  });
});

describe("webviewDisplayName", () => {
  it("이 창의 브라우저 label 은 탭 표시명으로 해소한다", () => {
    const tabs = [tab("t1", [browser("v3", "GitHub")])];
    expect(webviewDisplayName("b--v3", tabs)).toBe("GitHub");
  });

  it("customLabel 이 있으면 그것을 쓴다", () => {
    const tabs = [tab("t1", [browser("v3", "GitHub", "작업 브라우저")])];
    expect(webviewDisplayName("b--v3", tabs)).toBe("작업 브라우저");
  });

  it("대응 뷰가 없으면 label 그대로", () => {
    const tabs = [tab("t1", [browser("v3", "GitHub")])];
    expect(webviewDisplayName("b--v9", tabs)).toBe("b--v9");
  });

  it("브라우저 접두사가 아닌 label 은 그대로", () => {
    expect(webviewDisplayName("some-webview", [])).toBe("some-webview");
  });
});
