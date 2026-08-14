// @vitest-environment jsdom
// Rail common form (§12) — slot frame: host-owned header (feature icon, title, rail look toggle) plus
// body (plugin replaceable area). Rebinding is a move, not a creation — the arrival animation class is applied.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
});
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()), invoke: vi.fn(async () => undefined) }));
// The frame is under test — the body host is replaced by a stub; plugin mounting is irrelevant here.
vi.mock("./PluginViewHost", () => ({
  PluginViewHost: ({ viewKey }: { viewKey: string }) => (
    <div data-testid="body-host">{viewKey}</div>
  ),
}));

import { ProjectionSlots } from "./ProjectionSlots";
import { useProjection } from "../state/projection";
import { useSessions, type Project, type Tab } from "../state/sessions";
import { useSettings } from "../state/settings";
import { initialSidebarLayout } from "../state/sidebarLayout";
import { useViewRegistry, type PluginViewProvider } from "../plugins/viewRegistry";
import type { ContributedView } from "../plugins/spec";

const provider: PluginViewProvider = { mount: () => {} };

function decl(id: string, over: Partial<ContributedView> = {}): ContributedView {
  return {
    id,
    title: { ko: `${id}-ko`, en: `${id}-en` },
    icon: "🌲",
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
  } as unknown as Project;
}

function registerFn(plug: string, content: string, railView: string) {
  useViewRegistry.getState().register(
    plug,
    decl(content, {
      sidebar: {
        left: [{ ref: `self.${railView}`, instance: "shared" }],
        right: [],
        template: "stack",
      },
    }),
    provider,
  );
  useViewRegistry.getState().register(
    plug,
    decl(railView, { placements: ["rail"], defaultPlacement: "rail" }),
    provider,
  );
}

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  useViewRegistry.setState({ views: {}, version: 0, badges: {} });
  useProjection.setState({ byProject: {} });
  useSessions.setState({ projects: [], activeId: "" });
  useSettings.setState({ language: "ko" });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

const render = (commitProjection = true) =>
  act(() => {
    root.render(
      <ProjectionSlots
        projectId="p1"
        root="<local-evidence>/p1"
        paneId={null}
        side="left"
        commitProjection={commitProjection}
      />,
    );
  });

describe("rail slot common form (§12)", () => {
  it("a live slot renders as a host header (icon and title) plus a body — only the inside is the feature's", () => {
    registerFn("termplug", "term", "tree");
    useSessions.setState({ projects: [tab([pluginView("v1", "termplug", "term")], "v1")], activeId: "p1" });
    render();
    const header = host.querySelector<HTMLElement>(".projection-header");
    expect(header).not.toBeNull();
    expect(header!.textContent).toContain("tree-ko");
    expect(header!.textContent).toContain("🌲");
    const body = host.querySelector<HTMLElement>(".projection-card");
    expect(body).not.toBeNull();
    expect(body!.querySelector("[data-testid=body-host]")).not.toBeNull();
  });

  it("the toggle in the first left slot header switches railLook pane↔ground and persists it", () => {
    registerFn("termplug", "term", "tree");
    useSessions.setState({ projects: [tab([pluginView("v1", "termplug", "term")], "v1")], activeId: "p1" });
    render();
    expect(useSettings.getState().railLook).toBe("ground"); // the default = SIDEBAR-CHROME (the design canon)
    const toggle = host.querySelector<HTMLElement>('[data-node="projection/left/look"]');
    expect(toggle).not.toBeNull();
    act(() => toggle!.click());
    expect(useSettings.getState().railLook).toBe("pane");
    act(() => toggle!.click());
    expect(useSettings.getState().railLook).toBe("ground");
  });

  it("a handover changes only the slot display and adds no effect class to the rail shell (§12-④)", () => {
    registerFn("termplug", "term", "tree");
    registerFn("kanplug", "board", "nav");
    useSessions.setState({
      projects: [
        tab(
          [pluginView("v1", "termplug", "term"), pluginView("v2", "kanplug", "board")],
          "v1",
        ),
      ],
      activeId: "p1",
    });
    render();
    // Active view switch → resolution changes from termplug.tree to kanplug.nav (rebinding).
    act(() => {
      useSessions.setState((s) => ({
        projects: s.projects.map((t) => ({
          ...t,
          spaces: t.spaces.map((c) => ({
            ...c,
            layout: { ...c.layout, value: { ...(c.layout as { value: object }).value, activeTabId: "v2" } },
          })),
        })),
      }) as never);
    });
    const slots = host.querySelector<HTMLElement>(".projections")!;
    expect(slots.className).toBe("projections"); // the shell stays opaque — only the content slots hand over.
  });
});

describe("host header binding name (§12-①)", () => {
  it("the header shows the bound view's name — no separate 'connected' badge", () => {
    // Simplified relation display (user decision): the floating "connected · name" badge is removed, and
    // the name in the host header is the single place that shows the sidebar's bound view.
    registerFn("termplug", "term", "tree");
    useSessions.setState({
      projects: [tab([pluginView("v1", "termplug", "term")], "v1")],
      activeId: "p1",
    });
    render();
    const bound = host.querySelector<HTMLElement>(".projection-bound");
    expect(bound?.textContent).toBe("tab-aaaaaa"); // viewDisplayTitle(bound view)
  });
});

describe("handover (§12-④)", () => {
  it("the departing representation keeps the previous identity and the arriving one uses the current identity", () => {
    registerFn("termplug", "term", "tree");
    registerFn("kanplug", "board", "nav");
    useSessions.setState({
      projects: [
        tab(
          [pluginView("v1", "termplug", "term"), pluginView("v2", "kanplug", "board")],
          "v1",
        ),
      ],
      activeId: "p1",
    });
    render();
    render(false);
    act(() => {
      useSessions.setState((s) => ({
        projects: s.projects.map((t) => ({
          ...t,
          spaces: t.spaces.map((c) => ({
            ...c,
            layout: { ...c.layout, value: { ...(c.layout as { value: object }).value, activeTabId: "v2" } },
          })),
        })),
      }) as never);
    });
    const slotOf = (title: string) =>
      [...host.querySelectorAll<HTMLElement>(".projection")].find((el) =>
        el.querySelector(".projection-title")!.textContent === title,
      )!;
    // The departing representation keeps A until the pane hides it completely.
    expect(slotOf("nav-ko").style.display).toBe("none");
    expect(slotOf("tree-ko").style.display).not.toBe("none");
    // The arriving representation uses B from the start. It has no timer of its own.
    render(true);
    expect(slotOf("tree-ko").style.display).toBe("none");
    expect(slotOf("nav-ko").style.display).not.toBe("none");
    expect(slotOf("tree-ko").className).toBe("projection");
    expect(slotOf("nav-ko").className).toBe("projection");
  });
});
