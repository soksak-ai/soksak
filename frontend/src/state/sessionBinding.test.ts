// Attaching a session to a view records which session that view holds; detaching removes the
// record and ends nothing. Closing a window, a workspace or a pane detaches what it held and closes
// none of it, so detaching is not a close and nothing but an explicit close ends a session.
import { beforeEach, describe, expect, it } from "vitest";

import { useSessions } from "./sessions";

useSessions.getState().bootstrapFirstWorkspace("/tmp/soksak-session-binding");
const WORKSPACE = useSessions.getState().activeId;

let seq = 0;
function openView(): string {
  const opened = useSessions.getState().openPluginView(WORKSPACE, "p", `v${seq++}`, "T");
  if (!opened.ok) throw new Error("openPluginView failed");
  return opened.viewId;
}

function viewOf(viewId: string) {
  for (const workspace of useSessions.getState().workspaces) {
    for (const space of workspace.spaces) {
      const found = allTabs(space.layout).find((tab) => tab.id === viewId);
      if (found) return found;
    }
  }
  return undefined;
}

function allTabs(node: unknown): { id: string; session?: { owner: string; id: string } }[] {
  const branch = node as { type: string; value?: { tabs: unknown[] }; children?: unknown[] };
  if (branch.type === "leaf") return (branch.value?.tabs ?? []) as never;
  return (branch.children ?? []).flatMap(allTabs);
}

describe("binding a session to a view", () => {
  let viewId = "";

  beforeEach(() => {
    viewId = openView();
  });

  it("records which session the view holds", () => {
    useSessions.getState().bindSession(null, viewId, { owner: "pty", id: "7" });

    expect(viewOf(viewId)?.session).toEqual({ owner: "pty", id: "7" });
  });

  it("removes the record on detach and leaves the view standing", () => {
    useSessions.getState().bindSession(null, viewId, { owner: "pty", id: "7" });
    useSessions.getState().bindSession(null, viewId, null);

    expect(viewOf(viewId)).toBeDefined();
    expect(viewOf(viewId)?.session).toBeUndefined();
  });

  it("replaces a binding rather than holding two", () => {
    useSessions.getState().bindSession(null, viewId, { owner: "pty", id: "7" });
    useSessions.getState().bindSession(null, viewId, { owner: "pty", id: "8" });

    expect(viewOf(viewId)?.session).toEqual({ owner: "pty", id: "8" });
  });

  it("changes nothing for a view that is not there", () => {
    const before = JSON.stringify(useSessions.getState().workspaces);
    useSessions.getState().bindSession(null, "tab-nowhere", { owner: "pty", id: "7" });

    expect(JSON.stringify(useSessions.getState().workspaces)).toBe(before);
  });
});
