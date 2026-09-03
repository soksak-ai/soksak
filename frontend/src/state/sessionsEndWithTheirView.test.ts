// Every path that removes a view for good ends the sessions on it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
});

const invoked: Array<{ name: string; args: Record<string, unknown> }> = [];
// The owner's answer is set per test rather than spied on: permanentViewClose binds invoke at
// import, so replacing the property afterwards does not reach the reference it already holds.
let refusing = false;
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: async (name: string, args: Record<string, unknown>) => {
    invoked.push({ name, args });
    if (refusing) throw new Error("the owner refused");
    return {};
  },
}));

import { useCloseConfirm } from "./closeConfirm";
import { closeViewPermanently } from "./permanentViewClose";
import { allViews, useSessions } from "./sessions";
import { useSettings } from "./settings";

useSessions.getState().bootstrapFirstWorkspace("/tmp/soksak-session-view-close");
const WORKSPACE = useSessions.getState().activeId;

const closes = () => invoked.filter((call) => call.name === "session_close");

// A plugin view rather than a program view: this file is about what happens when a view is removed,
// and openPluginView produces one without a program registry behind it.
let seq = 0;
function makeView(): string {
  const opened = useSessions.getState().openPluginView(WORKSPACE, "an-owner", `v${seq++}`, "T");
  if (!opened.ok) throw new Error("openPluginView refused");
  return opened.viewId;
}

beforeEach(() => {
  invoked.length = 0;
  refusing = false;
  useSettings.setState({ tabCloseConfirm: "off" });
});

describe("a view leaving the layout for good", () => {
  it("names itself to the core so the sessions on it end", async () => {
    const viewId = makeView();

    await closeViewPermanently(WORKSPACE, viewId);

    // The view is named, never the session: which sessions are on it is the index's answer, and
    // the index is the core's. A caller that looked them up would be keeping a second copy.
    expect(closes()).toEqual([{ name: "session_close", args: { view: viewId } }]);
  });

  it("does so when a space closes, for every view the space held", async () => {
    // A second space, so closing the one under test is not refused as the last one.
    useSessions.getState().addContent(WORKSPACE);
    const workspace0 = useSessions.getState().workspaces.find((w) => w.id === WORKSPACE)!;
    useSessions.getState().setActiveContent(WORKSPACE, workspace0.spaces[0].id);
    makeView();
    makeView();

    const workspace = useSessions.getState().workspaces.find((w) => w.id === WORKSPACE);
    const contentId = workspace!.activeSpaceId;
    const content = workspace!.spaces.find((c) => c.id === contentId);
    const held = allViews(content!.layout).map((view) => view.id);
    expect(held.length).toBeGreaterThan(1);

    useCloseConfirm.getState().requestCloseContent(WORKSPACE, contentId);
    await vi.waitFor(() => expect(closes().length).toBe(held.length));

    expect(closes().map((call) => call.args.view).sort()).toEqual([...held].sort());
  });

  it("closes the view even when the owner refuses", async () => {
    const viewId = makeView();

    refusing = true;
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});

    await closeViewPermanently(WORKSPACE, viewId);

    // The refusal was reached, so this measures a refusal and not the absence of a call.
    expect(closes()).toEqual([{ name: "session_close", args: { view: viewId } }]);
    expect(reported).toHaveBeenCalled();
    reported.mockRestore();

    // Closing the view is the person's act. An owner that will not end its session does not get to
    // keep the view on screen — the refusal is reported, and the view goes.
    const workspace = useSessions.getState().workspaces.find((w) => w.id === WORKSPACE);
    const still = workspace!.spaces.flatMap((c) => allViews(c.layout)).some((v) => v.id === viewId);
    expect(still).toBe(false);
  });
});
