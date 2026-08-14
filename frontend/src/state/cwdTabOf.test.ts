// cwdTabOf picks, generically, the terminal tab the file tree follows. Terminal detection uses only the
// injected hasPty(id) predicate (plugin terminal = view.id). No hardcoded pluginId or kind.
import { describe, expect, it } from "vitest";
import { cwdTabOf, type Project, type Tab } from "./sessions";

const plugin = (viewId: string, pluginId: string, view: string): Tab => ({
  id: viewId,
  kind: "plugin",
  title: "P",
  pluginId,
  view,
});

const file = (viewId: string, path: string): Tab => ({
  id: viewId,
  kind: "file",
  title: "F",
  path,
  mode: "code",
});

// Tabs in a single group (g1); the active tab = activeTabId (defaults to the first tab).
const tab = (tabs: Tab[], activeTabId?: string): Project => ({
  id: "t1",
  title: "t1",
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
        value: {
          id: "g1",
          tabs,
          activeTabId: activeTabId ?? tabs[0]?.id ?? "",
        },
      },
      activePaneId: "g1",
    },
  ],
  activeSpaceId: "c1",
});

describe("cwdTabOf", () => {
  // Plugin terminal: paneId = view.id. When hasPty(view.id) is true, follow that id.
  it("follows an active plugin terminal by view.id — pluginId does not matter", () => {
    const t = tab([plugin("v9", "soksak-plugin-terminal-xterm", "content")]);
    const hasPty = (id: string) => id === "v9";
    expect(cwdTabOf(t, hasPty)).toBe("v9");
  });

  // When the active view is a terminal, prefer it over an inactive terminal.
  it("prefers the pane of the active view when that view is a terminal", () => {
    const t = tab(
      [plugin("v1", "p", "content"), plugin("v2", "p", "content")],
      "v2",
    );
    const hasPty = (id: string) => id === "v1" || id === "v2";
    expect(cwdTabOf(t, hasPty)).toBe("v2");
  });

  // When the active view is not a terminal (a file), fall back to any terminal view in the group.
  it("falls back to any terminal view when the active view is not a terminal", () => {
    const t = tab([file("v1", "/r/a.ts"), plugin("v2", "p", "content")], "v1");
    const hasPty = (id: string) => id === "v2";
    expect(cwdTabOf(t, hasPty)).toBe("v2");
  });

  // A plugin view with no PTY observation (not a terminal) is ignored — the generic signal is the point.
  it("answers undefined when only views without PTY observation are present", () => {
    const t = tab([file("v1", "/r/a.ts"), plugin("v2", "other", "panel")]);
    const hasPty = () => false;
    expect(cwdTabOf(t, hasPty)).toBeUndefined();
  });
});
