// ui.projection.* / ui.intent.open command contract (§4.2·R2·R4).
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
import { execute, getSpec } from "./registry";
import { useProjection } from "../state/projection";
import { useSessions, type Project, type Tab } from "../state/sessions";
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

function tab(tabs: Tab[], activeTabId: string): Project {
  return {
    id: "p1",
    title: "P",
    sidebarOpen: true,
    rightOpen: false,
    rightView: null,
    leftLayout: initialSidebarLayout([]),
    root: "<local-evidence>/p1",
    spaces: [
      {
        id: "c1",
        title: "1",
        layout: { type: "leaf", value: { id: "g1", tabs, activeTabId } },
        activePaneId: "g1",
      },
    ],
    activeSpaceId: "c1",
  };
}

beforeEach(() => {
  useViewRegistry.setState({ views: {}, version: 0, badges: {} });
  useProjection.setState({ byProject: {} });
  useSessions.setState({ projects: [], activeId: "" });
});

describe("ui.projection.state", () => {
  it("returns the binding, slots and pins of the active project", async () => {
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
    useSessions.setState({ projects: [tab([pluginView("v1", "termplug", "term")], "v1")], activeId: "p1" });

    const r = (await execute("ui.projection.state", {}, {})) as { ok: boolean; code: string; data: Record<string, unknown> };
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({
      projectId: "p1",
      binding: { viewId: "v1" },
    });
    const left = r.data.left as { slots: { resolvedRef: string; status: string }[] };
    expect(left.slots[0]).toMatchObject({ resolvedRef: "termplug.tree", status: "live" });
  });

  it("a project that does not exist → TARGET_NOT_FOUND", async () => {
    const r = (await execute("ui.projection.state", { project: "nope" }, {})) as { ok: boolean; code: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe("TARGET_NOT_FOUND");
  });
});

describe("ui.projection.pin / unpin — the left rail is projection only (no pin axis)", () => {
  it("a left pin is INVALID_PARAMS even for a resident view — the left rail projects a binding only", async () => {
    useViewRegistry.getState().register(
      "termplug",
      decl("tree", { placements: ["rail"], defaultPlacement: "rail", resident: true }),
      provider,
    );
    useSessions.setState({ projects: [tab([], "")], activeId: "p1" });
    const r = (await execute("ui.projection.pin", { ref: "termplug.tree" }, {})) as { ok: boolean; code: string; message: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID_PARAMS");
    expect(String(r.message)).toBe(tmsg("msg.ui.projection.pin.leftProjectionOnly"));
  });

  it("unpin stays for cleaning up a leftover pin (an old snapshot) and is idempotent", async () => {
    useSessions.setState({ projects: [tab([], "")], activeId: "p1" });
    useSessions.setState({ projects: [tab([], "")], activeId: "pjt-aaaaaa" });
    const r1 = (await execute("ui.projection.unpin", { ref: "gone.tree" }, {})) as { ok: boolean };
    expect(r1.ok).toBe(true);
    const st = (await execute("ui.projection.state", {}, {})) as { data: Record<string, unknown> };
    expect((st.data.pins as { left: string[] }).left).toEqual([]);
    const r2 = (await execute("ui.projection.unpin", { ref: "gone.tree" }, {})) as { ok: boolean };
    expect(r2.ok).toBe(true); // idempotent
  });
});

describe("ui.intent.open — R2 (placement in the binding context, idempotent reuse)", () => {
  it("refuses a relative path at the boundary — accepted silently it persists as a dead tab (measured RED)", async () => {
    // The contract is an absolute path (params.path: "Absolute file path"). A relative path that passes
    // persists that string in the tab, and restore wakes it as a dead "No such file or directory" tab
    // (measured 2026-07-26: a tab opened with "README.md" died after restart — found on the user's screen).
    useSessions.setState({ projects: [tab([], "")], activeId: "p1" });
    const r = (await execute("ui.intent.open", { path: "README.md" }, {})) as {
      ok: boolean;
      code?: string;
    };
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID_PARAMS");
  });

  it("opens a file as a tab in the binding group, and reuses the existing view for the same resource", async () => {
    useSessions.setState({ projects: [tab([], "")], activeId: "p1" });
    const r1 = (await execute("ui.intent.open", { path: "<local-evidence>/p1/a.md" }, {})) as { ok: boolean; data: Record<string, unknown> };
    expect(r1.ok).toBe(true);
    expect(r1.data.existing).toBe(false);
    const r2 = (await execute("ui.intent.open", { path: "<local-evidence>/p1/a.md" }, {})) as { ok: boolean; data: Record<string, unknown> };
    expect(r2.ok).toBe(true);
    expect(r2.data.existing).toBe(true);
    expect(r2.data.viewId).toBe(r1.data.viewId);
  });

  it("spec (getSpec) — path is declared as a required parameter", () => {
    const spec = getSpec("ui.intent.open")!;
    expect(spec.params.path?.required).toBe(true);
  });
});

describe("batch 1 command consistency — right pin refusal, alias pin, expanded state", () => {
  it('a side:"right" pin is INVALID_PARAMS until the right pin stack renderer exists', async () => {
    useViewRegistry.getState().register(
      "termplug",
      decl("tree", { placements: ["rail"], defaultPlacement: "rail" }),
      provider,
    );
    useSessions.setState({ projects: [tab([], "")], activeId: "p1" });
    const r = (await execute("ui.projection.pin", { ref: "termplug.tree", side: "right" }, {})) as { ok: boolean; code: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID_PARAMS");
  });


  it("state includes binding.groupId, contentId and focusHistory (§4.1)", async () => {
    useViewRegistry.getState().register("termplug", decl("term"), provider);
    useSessions.setState({ projects: [tab([pluginView("v1", "termplug", "term")], "v1")], activeId: "p1" });
    useProjection.getState().noteBinding("p1", "v1");
    const r = (await execute("ui.projection.state", {}, {})) as { data: Record<string, unknown> };
    expect(r.data.binding).toMatchObject({ viewId: "v1", groupId: "g1", contentId: "c1" });
    expect(r.data.focusHistory).toEqual(["v1"]);
  });
});

