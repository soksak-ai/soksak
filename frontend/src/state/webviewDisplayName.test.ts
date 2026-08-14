// webviewDisplayName — shows a webview under a human name on user surfaces (recovery badge and so
// on). Label = manifest/content title rule (message protocol): the raw label
// (brw-<window>-<viewId>) is never exposed to the user as is. For a browser view of this window it
// is the tab display name (customLabel first, title as fallback); with no matching view it is the
// label itself (for a webview with no human name the identifier is the only fact).
//
// In jsdom currentWindowLabel() falls back to "", so this window's browser prefix is "brw--"
// (see webviewLabels.ts) — fixture labels use that prefix.
import { describe, expect, it } from "vitest";
import {
  viewDisplayTitle,
  webviewDisplayName,
  type Project,
  type Tab,
} from "./sessions";

const browser = (viewId: string, title: string, customLabel?: string): Tab => ({
  id: viewId,
  kind: "plugin",
  title,
  customLabel,
  pluginId: "soksak-plugin-browser-native",
  view: "content",
});

const tab = (id: string, tabs: Tab[]): Project => ({
  id,
  title: id,
  sidebarOpen: false,
  rightOpen: false,
  rightView: null,
  leftLayout: { type: "leaf", value: { viewKeys: [], activeViewKey: "" } },
  root: "/r",
  spaces: [
    {
      id: "c1",
      title: "1",
      layout: {
        type: "leaf",
        value: { id: "g1", tabs, activeTabId: tabs[0]?.id ?? "" },
      },
      activePaneId: "g1",
    },
  ],
  activeSpaceId: "c1",
});

describe("viewDisplayTitle", () => {
  it("customLabel, the user's intent, wins over title, the content's fact", () => {
    expect(viewDisplayTitle(browser("tab-aaaaaa", "Page"))).toBe("Page");
    expect(viewDisplayTitle(browser("v1", "Page"))).toBe("Page");
  });
});

describe("webviewDisplayName", () => {
  it("a browser label of this window resolves to the tab display name", () => {
    const tabs = [tab("t1", [browser("v3", "GitHub")])];
    expect(webviewDisplayName("b--v3", tabs)).toBe("GitHub");
  });

  it("uses customLabel when there is one", () => {
    const tabs = [tab("pjt-aaaaaa", [browser("tab-cccccc", "GitHub", "Work browser")])];
    expect(webviewDisplayName("brw--tab-cccccc", tabs)).toBe("Work browser");
  });

  it("with no matching view the label stays as it is", () => {
    const tabs = [tab("t1", [browser("v3", "GitHub")])];
    expect(webviewDisplayName("b--v9", tabs)).toBe("b--v9");
  });

  it("a label without the browser prefix stays as it is", () => {
    expect(webviewDisplayName("some-webview", [])).toBe("some-webview");
  });
});
