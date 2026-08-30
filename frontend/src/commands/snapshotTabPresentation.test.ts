// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  order: [] as string[],
  rejectPresentation: false,
  captureWindowPixels: vi.fn(async () => {
    seams.order.push("capture");
    return { png: "cG5n", note: { nativeComposed: false } };
  }),
  waitForTabPresentationCommit: vi.fn(async () => {
    seams.order.push("dom-commit");
    await Promise.resolve();
  }),
  waitLayoutSettled: vi.fn(async () => {
    seams.order.push("presentation-start");
    await Promise.resolve();
    if (seams.rejectPresentation) throw new Error("native presentation rejected");
    seams.order.push("presentation-settled");
    return { settled: true, syncPending: false };
  }),
}));

vi.mock("./windowCapture", () => ({ captureWindowPixels: seams.captureWindowPixels }));
vi.mock("./waitForDomCommit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./waitForDomCommit")>()),
  waitForTabPresentationCommit: seams.waitForTabPresentationCommit,
}));
vi.mock("./waitLayoutSettled", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./waitLayoutSettled")>()),
  waitLayoutSettled: seams.waitLayoutSettled,
}));

import { registerCatalog } from "./catalog";
import { execute } from "./registry";
import { initialSidebarLayout } from "../state/sidebarLayout";
import { useSessions, type Workspace } from "../state/sessions";
import { splitLeaf } from "../state/splitTree";

const currentTab = "tab-current";
const targetTab = "tab-target";
const workspaceId = "wsp-capture";

function workspace(): Workspace {
  return {
    id: workspaceId,
    title: "capture",
    root: "/tmp/capture",
    regionOpen: { left: false, rail: false, right: false },
    railPlacement: { mode: "pin", station: 50 },
    sidebarLayouts: {
      left: initialSidebarLayout([]),
      rail: initialSidebarLayout([]),
      right: initialSidebarLayout([]),
    },
    spaces: [{
      id: "spc-capture",
      title: "1",
      activePaneId: "pan-capture",
      layout: splitLeaf({
        id: "pan-capture",
        activeTabId: currentTab,
        tabs: [
          { id: currentTab, kind: "plugin", title: "current", pluginId: "fixture", view: "current" },
          { id: targetTab, kind: "plugin", title: "target", pluginId: "fixture", view: "target" },
        ],
      }),
    }],
    activeSpaceId: "spc-capture",
  };
}

function activeTab(): string {
  const state = useSessions.getState();
  const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId)!;
  const space = workspace.spaces.find((candidate) => candidate.id === workspace.activeSpaceId)!;
  return space.layout.type === "leaf" ? space.layout.value.activeTabId : "";
}

registerCatalog();

beforeEach(() => {
  seams.order.splice(0);
  seams.rejectPresentation = false;
  seams.captureWindowPixels.mockClear();
  seams.waitForTabPresentationCommit.mockClear();
  seams.waitLayoutSettled.mockClear();
  useSessions.setState({ workspaces: [workspace()], activeId: workspaceId });
  document.body.innerHTML = `
    <section data-workspace-plane="${workspaceId}" data-workspace-active="1">
      <div data-node="layout/tab/${targetTab}"></div>
    </section>
  `;
  const target = document.querySelector<HTMLElement>(`[data-node="layout/tab/${targetTab}"]`)!;
  target.getBoundingClientRect = () => ({
    x: 10, y: 20, left: 10, top: 20, right: 210, bottom: 120,
    width: 200, height: 100, toJSON: () => ({}),
  });
});

describe("window.snapshot inactive-tab presentation ownership", () => {
  it("captures only after the target DOM commit and native presentation settlement", async () => {
    const result = await execute("window.snapshot", { tab: targetTab, base64: true }, {});

    expect(result).toMatchObject({ ok: true, data: { tabId: targetTab } });
    expect(seams.order).toEqual([
      "dom-commit",
      "presentation-start",
      "presentation-settled",
      "capture",
    ]);
    expect(seams.waitForTabPresentationCommit).toHaveBeenCalledWith(targetTab);
    expect(seams.waitLayoutSettled).toHaveBeenCalledOnce();
    expect(activeTab()).toBe(currentTab);
  });

  it("restores the original tab when native presentation settlement fails", async () => {
    seams.rejectPresentation = true;

    const result = await execute("window.snapshot", { tab: targetTab, base64: true }, {});

    expect(result).toMatchObject({ ok: false });
    expect(seams.captureWindowPixels).not.toHaveBeenCalled();
    expect(activeTab()).toBe(currentTab);
  });
});
