import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();
const activeSessionViewId = vi.fn();
const transferViewFocus = vi.fn();
const getState = vi.fn();
const allGroups = vi.fn();

vi.mock("../commands/registry", () => ({ execute }));
vi.mock("../plugins/viewFocus", () => ({ activeSessionViewId, transferViewFocus }));
vi.mock("../state/sessions", () => ({ allGroups, useSessions: { getState } }));

describe("pane activation focus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getState.mockReturnValue({
      activeId: "workspace-1",
      workspaces: [{
        id: "workspace-1",
        activeSpaceId: "space-1",
        spaces: [{ id: "space-1", activePaneId: "pane-1", layout: {} }],
      }],
    });
    allGroups.mockReturnValue([{ id: "pane-1", activeTabId: "tab-1" }]);
    activeSessionViewId.mockReturnValue("tab-1");
  });

  it("requests focus again when the active pane is clicked after focus was lost", async () => {
    const { activatePaneIntent } = await import("./viewActivation");

    expect(activatePaneIntent("pane-1")).toBe(true);
    expect(transferViewFocus).toHaveBeenCalledWith("tab-1", "tab-1", expect.any(Function));
    expect(execute).not.toHaveBeenCalled();
  });
});
