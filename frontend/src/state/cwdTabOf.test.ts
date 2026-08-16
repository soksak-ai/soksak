// cwdTabOf picks, generically, the terminal tab the file tree follows. Terminal detection uses only the
// injected hasPty(id) predicate (plugin terminal = view.id). No hardcoded pluginId or kind.
import { describe, expect, it } from "vitest";
import { cwdTabOf, type Workspace, type Tab } from "./sessions";

const plugin = (viewId: string, pluginId: string, view: string): Tab => ({
  id: viewId,
  kind: "plugin",
  title: "P",
  pluginId,
  view,
});

const file = (viewId: string, path: string): Tab => ({
  id: viewId,
  kind: "plugin",
  title: path,
  pluginId: "plg-editor",
  view: "content",
});

// Tabs in a single group (g1); the active tab = activeTabId (defaults to the first tab).
const tab = (tabs: Tab[], activeTabId?: string): Workspace => ({
  id: "wsp-aaaaaa",
  title: "wsp-aaaaaa",
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
        value: {
          id: "pan-aaaaaa",
          tabs,
          activeTabId: activeTabId ?? tabs[0]?.id ?? "",
        },
      },
      activePaneId: "pan-aaaaaa",
    },
  ],
  activeSpaceId: "spc-aaaaaa",
});

describe("cwdTabOf", () => {
  // Plugin terminal: paneId = view.id. When hasPty(view.id) is true, follow that id.
  it("follows an active plugin terminal by view.id — pluginId does not matter", () => {
    const t = tab([plugin("tab-iiiiii", "soksak-plugin-terminal-xterm", "content")]);
    const hasPty = (id: string) => id === "tab-iiiiii";
    expect(cwdTabOf(t, hasPty)).toBe("tab-iiiiii");
  });

  // When the active view is a terminal, prefer it over an inactive terminal.
  it("prefers the pane of the active view when that view is a terminal", () => {
    const t = tab(
      [plugin("tab-aaaaaa", "p", "content"), plugin("tab-bbbbbb", "p", "content")],
      "tab-bbbbbb",
    );
    const hasPty = (id: string) => id === "tab-aaaaaa" || id === "tab-bbbbbb";
    expect(cwdTabOf(t, hasPty)).toBe("tab-bbbbbb");
  });

  // When the active view is not a terminal (a file), fall back to any terminal view in the group.
  it("falls back to any terminal view when the active view is not a terminal", () => {
    const t = tab([file("tab-aaaaaa", "/r/a.ts"), plugin("tab-bbbbbb", "p", "content")], "tab-aaaaaa");
    const hasPty = (id: string) => id === "tab-bbbbbb";
    expect(cwdTabOf(t, hasPty)).toBe("tab-bbbbbb");
  });

  // A plugin view with no PTY observation (not a terminal) is ignored — the generic signal is the point.
  it("answers undefined when only views without PTY observation are present", () => {
    const t = tab([file("tab-aaaaaa", "/r/a.ts"), plugin("tab-bbbbbb", "other", "panel")]);
    const hasPty = () => false;
    expect(cwdTabOf(t, hasPty)).toBeUndefined();
  });
});
