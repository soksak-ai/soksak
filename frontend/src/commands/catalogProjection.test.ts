// ui.projection.* command contract (§4.2·R4).
import { beforeEach, describe, expect, it, vi } from "vitest";

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => mem.get(key) ?? null,
  setItem: (key: string, value: string) => void mem.set(key, value),
  removeItem: (key: string) => void mem.delete(key),
  clear: () => mem.clear(),
});
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()), invoke: vi.fn(async () => undefined) }));

import { registerProjectionCatalog } from "./catalogProjection";
import { tmsg } from "../i18n";
import { execute } from "./registry";
import { useProjection } from "../state/projection";
import { useSessions, type Workspace, type Tab } from "../state/sessions";
import { initialSidebarLayout } from "../state/sidebarLayout";
import { useViewRegistry, type PluginViewProvider } from "../plugins/viewRegistry";
import type { ContributedView } from "../plugins/spec";

registerProjectionCatalog();

const provider: PluginViewProvider = { mount: () => {} };

function decl(id: string, over: Partial<ContributedView> = {}): ContributedView {
  return {
    id,
    title: id,
    icon: "x",
    placements: ["content"],
    defaultPlacement: "content",
    transparent: false,
    nativeSurface: false,
    decoration: false,
    resident: false,
    ...over,
  };
}

function pluginView(id: string, pluginId: string, view: string): Tab {
  return { id, kind: "plugin", title: id, pluginId, view };
}

function tab(tabs: Tab[], activeTabId: string): Workspace {
  return {
    id: "wsp-aaaaaa",
    title: "P",
    sidebarOpen: true,
    rightOpen: false,
    rightView: null,
    leftLayout: initialSidebarLayout([]),
    root: "<local-evidence>/p1",
    spaces: [
      {
        id: "spc-aaaaaa",
        title: "1",
        layout: { type: "leaf", value: { id: "pan-aaaaaa", tabs, activeTabId } },
        activePaneId: "pan-aaaaaa",
      },
    ],
    activeSpaceId: "spc-aaaaaa",
  };
}

beforeEach(() => {
  useViewRegistry.setState({ views: {}, version: 0, badges: {} });
  useProjection.setState({ byWorkspace: {} });
  useSessions.setState({ workspaces: [], activeId: "" });
});

describe("ui.projection.state", () => {
  it("returns the binding, slots and pins of the active workspace", async () => {
    useViewRegistry.getState().register(
      "termplug",
      decl("term", {
        sidebar: {
          left: [{ ref: "self.tree", instance: "shared" }],
          right: [],
          template: "stack",
        },
      }),
      provider,
    );
    useViewRegistry.getState().register(
      "termplug",
      decl("tree", { placements: ["rail"], defaultPlacement: "rail" }),
      provider,
    );
    useSessions.setState({ workspaces: [tab([pluginView("tab-aaaaaa", "termplug", "term")], "tab-aaaaaa")], activeId: "wsp-aaaaaa" });

    const r = (await execute("ui.projection.state", {}, {})) as { ok: boolean; code: string; data: Record<string, unknown> };
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({
      projectId: "wsp-aaaaaa",
      binding: { viewId: "tab-aaaaaa" },
    });
    const left = r.data.left as { slots: { resolvedRef: string; status: string }[] };
    expect(left.slots[0]).toMatchObject({ resolvedRef: "termplug.tree", status: "live" });
  });

  it("a workspace that does not exist → TARGET_NOT_FOUND", async () => {
    const r = (await execute("ui.projection.state", { workspace: "nope" }, {})) as { ok: boolean; code: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe("TARGET_NOT_FOUND");
  });
});

describe("ui.projection.pin / unpin — the left rail is projection only (no pin axis)", () => {
  it("a left pin is INVALID_PARAMS even for a resident view — the left rail workspaces a binding only", async () => {
    useViewRegistry.getState().register(
      "termplug",
      decl("tree", { placements: ["rail"], defaultPlacement: "rail", resident: true }),
      provider,
    );
    useSessions.setState({ workspaces: [tab([], "")], activeId: "wsp-aaaaaa" });
    const r = (await execute("ui.projection.pin", { ref: "termplug.tree" }, {})) as { ok: boolean; code: string; message: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID_PARAMS");
    expect(String(r.message)).toBe(tmsg("msg.ui.projection.pin.leftProjectionOnly"));
  });

  it("unpin stays for cleaning up a leftover pin (an old snapshot) and is idempotent", async () => {
    useSessions.setState({ workspaces: [tab([], "")], activeId: "wsp-aaaaaa" });
    useProjection.getState().pin("wsp-aaaaaa", "left", "gone.tree"); // simulates a leftover old snapshot
    const r1 = (await execute("ui.projection.unpin", { ref: "gone.tree" }, {})) as { ok: boolean };
    expect(r1.ok).toBe(true);
    const st = (await execute("ui.projection.state", {}, {})) as { data: Record<string, unknown> };
    expect((st.data.pins as { left: string[] }).left).toEqual([]);
    const r2 = (await execute("ui.projection.unpin", { ref: "gone.tree" }, {})) as { ok: boolean };
    expect(r2.ok).toBe(true); // idempotent
  });
});


describe("batch 1 command consistency — right pin refusal, alias pin, expanded state", () => {
  it('a side:"right" pin is INVALID_PARAMS until the right pin stack renderer exists', async () => {
    useViewRegistry.getState().register(
      "termplug",
      decl("tree", { placements: ["rail"], defaultPlacement: "rail" }),
      provider,
    );
    useSessions.setState({ workspaces: [tab([], "")], activeId: "wsp-aaaaaa" });
    const r = (await execute("ui.projection.pin", { ref: "termplug.tree", side: "right" }, {})) as { ok: boolean; code: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID_PARAMS");
  });


  it("state includes binding.groupId, contentId and focusHistory (§4.1)", async () => {
    useViewRegistry.getState().register("termplug", decl("term"), provider);
    useSessions.setState({ workspaces: [tab([pluginView("tab-aaaaaa", "termplug", "term")], "tab-aaaaaa")], activeId: "wsp-aaaaaa" });
    useProjection.getState().noteBinding("wsp-aaaaaa", "tab-aaaaaa");
    const r = (await execute("ui.projection.state", {}, {})) as { data: Record<string, unknown> };
    expect(r.data.binding).toMatchObject({ viewId: "tab-aaaaaa", groupId: "pan-aaaaaa", contentId: "spc-aaaaaa" });
    expect(r.data.focusHistory).toEqual(["tab-aaaaaa"]);
  });
});

