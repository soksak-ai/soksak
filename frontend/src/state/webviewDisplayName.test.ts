// webviewDisplayName — shows a webview under a human name on user surfaces (recovery badge and so
// on). Label = manifest/content title rule (message protocol): the raw label
// (<kind>-<window>-<viewId>) is never exposed to the user as is. For a view of this window it
// is the tab display name (customLabel first, title as fallback); with no matching view it is the
// label itself (for a webview with no human name the identifier is the only fact).
//
// The window name is mocked rather than left to jsdom's "": an unresolved window name is not an
// answer, and a label read against it would match on a single dash — every label, or none.
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/webviewLabels", () => ({ currentWindowLabel: () => "win-a" }));
import {
  viewDisplayTitle,
  webviewDisplayName,
  type Workspace,
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

const tab = (id: string, tabs: Tab[]): Workspace => ({
  id,
  title: id,
  sidebarOpen: false,
  rightOpen: false,
  sidebarLayouts: { left: { type: "leaf", value: { viewKeys: [], activeViewKey: "" } }, right: { type: "leaf", value: { viewKeys: [], activeViewKey: "" } } },
  root: "/r",
  spaces: [
    {
      id: "spc-aaaaaa",
      title: "1",
      layout: {
        type: "leaf",
        value: { id: "pan-aaaaaa", tabs, activeTabId: tabs[0]?.id ?? "" },
      },
      activePaneId: "pan-aaaaaa",
    },
  ],
  activeSpaceId: "spc-aaaaaa",
});

describe("viewDisplayTitle", () => {
  it("customLabel, the user's intent, wins over title, the content's fact", () => {
    expect(viewDisplayTitle(browser("tab-aaaaaa", "Page", "My tab"))).toBe("My tab");
    expect(viewDisplayTitle(browser("tab-aaaaaa", "Page"))).toBe("Page");
  });
});

describe("webviewDisplayName", () => {
  it("a browser label of this window resolves to the tab display name", () => {
    const tabs = [tab("wsp-aaaaaa", [browser("tab-cccccc", "GitHub")])];
    expect(webviewDisplayName("browser.win-a.tab-cccccc", tabs)).toBe("GitHub");
  });

  it("uses customLabel when there is one", () => {
    const tabs = [tab("wsp-aaaaaa", [browser("tab-cccccc", "GitHub", "Work browser")])];
    expect(webviewDisplayName("browser.win-a.tab-cccccc", tabs)).toBe("Work browser");
  });

  it("with no matching view the label stays as it is", () => {
    const tabs = [tab("wsp-aaaaaa", [browser("tab-cccccc", "GitHub")])];
    expect(webviewDisplayName("browser.win-a.tab-iiiiii", tabs)).toBe("browser.win-a.tab-iiiiii");
  });

  it("a label naming another window stays as it is", () => {
    expect(webviewDisplayName("some-webview", [])).toBe("some-webview");
  });
});
