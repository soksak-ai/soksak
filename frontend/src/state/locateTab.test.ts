// locateTab — tab id (the key the plugin passed to app.pty.spawn) → {projectId, viewId}. Pure function.
// The parameter name paneId is the old name on the plugin contract surface and stays for now (docs/NAMING.md migration table).
import { describe, expect, it } from "vitest";
import { locateTab, type Workspace, type Tab } from "./sessions";

// Plugin terminal view: PTY key = tab id (single key since the core terminal was removed).
const term = (viewId: string): Tab => ({
  id: viewId,
  kind: "plugin",
  title: "T",
  pluginId: "soksak-plugin-terminal-xterm",
  view: "content",
});

const tab = (id: string, tabs: Tab[]): Workspace => ({
  id,
  title: id,
  regionOpen: { left: false, right: false },
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

describe("locateTab", () => {
  it("finds that terminal tab by tab id", () => {
    const tabs = [tab("wsp-aaaaaa", [term("tab-aaaaaa")])];
    expect(locateTab(tabs, "tab-aaaaaa")).toEqual({ projectId: "wsp-aaaaaa", viewId: "tab-aaaaaa" });
  });

  it("finds the matching view.id among several views", () => {
    const tabs = [tab("wsp-aaaaaa", [term("tab-aaaaaa"), term("tab-bbbbbb")])];
    expect(locateTab(tabs, "tab-bbbbbb")).toEqual({ projectId: "wsp-aaaaaa", viewId: "tab-bbbbbb" });
  });

  it("a tab that is not there is null", () => {
    const tabs = [tab("wsp-aaaaaa", [term("tab-aaaaaa")])];
    expect(locateTab(tabs, "nope")).toBeNull();
  });
});
