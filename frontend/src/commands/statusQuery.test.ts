// status.query (R8 reply) integration — status reported to sessions comes back unchanged in the execute() reply.
import { beforeEach, describe, expect, it, vi } from "vitest";

// catalog may read settings (localStorage) at import time, so stub it first.
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
});

import { registerCatalog } from "./catalog";
import { execute } from "./registry";
import { useSessions } from "../state/sessions";

useSessions.getState().bootstrapFirstWorkspace("<local-evidence>/soksak-statusquery");
registerCatalog();
const pristineTabs = JSON.parse(JSON.stringify(useSessions.getState().workspaces));
const pristineActive = useSessions.getState().activeId;

let seq = 0;
function mkTab(status?: { code: string; message?: string }): string {
  const r = useSessions.getState().openPluginView("t1", "p", `v${seq++}`, "T");
  if (!r.ok) throw new Error("openPluginView failed");
  if (status) useSessions.getState().setViewStatus("t1", r.viewId, status);
  return r.viewId;
}

type StatusRes = { statuses: { tabId: string; code: string; message?: string }[] };

beforeEach(() => {
  useSessions.setState({
    workspaces: JSON.parse(JSON.stringify(pristineTabs)),
    activeId: pristineActive,
  });
});

describe("status.query — what was reported equals what is returned (R8)", () => {
  it("returns the reported status unchanged", async () => {
    const tid = mkTab({ code: "busy", message: "working" });
    const res = (await execute("status.query", {}, {})) as unknown as { data: StatusRes };
    expect(res.data.statuses).toContainEqual({
      tabId: tid,
      code: "busy",
      message: "working",
    });
  });

  it("returns an empty array when no tab reported a status", async () => {
    mkTab();
    const res = (await execute("status.query", {}, {})) as unknown as { data: StatusRes };
    expect(res.data.statuses).toEqual([]);
  });

  it("returns only the named tab for the tab parameter", async () => {
    const a = mkTab({ code: "busy", message: "A" });
    mkTab({ code: "dirty" });
    const res = (await execute(
      "status.query",
      { tab: a },
      {},
    )) as unknown as { data: StatusRes };
    expect(res.data.statuses).toHaveLength(1);
    expect(res.data.statuses[0].tabId).toBe(a);
  });
});
