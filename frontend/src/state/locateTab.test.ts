// locateTab — tab id (the key the plugin passed to app.pty.spawn) → {projectId, viewId}. Pure function.
// The parameter name paneId is the old name on the plugin contract surface and stays for now (docs/NAMING.md migration table).
import { describe, expect, it } from "vitest";
import { locateTab, type Project, type Tab } from "./sessions";

// Plugin terminal view: PTY key = tab id (single key since the core terminal was removed).
const term = (viewId: string): Tab => ({
  id: viewId,
  kind: "plugin",
  title: "T",
  pluginId: "soksak-plugin-terminal-xterm",
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

describe("locateTab", () => {
  it("finds that terminal tab by tab id", () => {
    const tabs = [tab("t1", [term("v1")])];
    expect(locateTab(tabs, "v1")).toEqual({ projectId: "t1", viewId: "v1" });
  });

  it("finds the matching view.id among several views", () => {
    const tabs = [tab("t1", [term("v1"), term("v2")])];
    expect(locateTab(tabs, "v2")).toEqual({ projectId: "t1", viewId: "v2" });
  });

  it("a tab that is not there is null", () => {
    const tabs = [tab("t1", [term("v1")])];
    expect(locateTab(tabs, "nope")).toBeNull();
  });
});
