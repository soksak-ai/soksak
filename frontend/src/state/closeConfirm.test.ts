// Close orchestration (R6/§5) — request → pending (confirm) vs immediate close, confirm/cancel.
import { beforeEach, describe, expect, it, vi } from "vitest";

// settings reads localStorage at import time, so stub it first (as in pluginSettings.test).
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
});

import { useCloseConfirm } from "./closeConfirm";
import { allViews, useSessions } from "./sessions";
import { useSettings } from "./settings";

useSessions.getState().bootstrapFirstProject("<local-evidence>/soksak-closeconfirm");
const pristineTabs = JSON.parse(JSON.stringify(useSessions.getState().projects));
const pristineActive = useSessions.getState().activeId;

let seq = 0;
// Creates a new plugin view (unique name — avoids dedupe) plus an optional status → returns viewId.
function mkView(status?: { code: string; message?: string }): string {
  const r = useSessions.getState().openPluginView("t1", "p", `v${seq++}`, "T");
  if (!r.ok) throw new Error("openPluginView failed");
  if (status) useSessions.getState().setViewStatus("t1", r.viewId, status);
  return r.viewId;
}

function viewExists(viewId: string): boolean {
  for (const t of useSessions.getState().projects)
    for (const c of t.spaces)
      for (const v of allViews(c.layout)) if (v.id === viewId) return true;
  return false;
}

beforeEach(() => {
  useSessions.setState({
    projects: JSON.parse(JSON.stringify(pristineTabs)),
    activeId: pristineActive,
  });
  useSettings.getState().setTabCloseConfirm("warn");
  useCloseConfirm.setState({ pending: null });
});

describe("requestCloseView — branching on the setting and the status", () => {
  it("warn + blocking — sets pending and does not close", () => {
    const vid = mkView({ code: "busy", message: "a job is running" });
    useCloseConfirm.getState().requestCloseView("t1", vid);
    expect(useCloseConfirm.getState().pending).toMatchObject({
      kind: "view",
      id: vid,
      reasons: ["a job is running"],
    });
    expect(viewExists(vid)).toBe(true);
  });

  it("not blocking — closes immediately with no pending", () => {
    const vid = mkView(); // no status
    useCloseConfirm.getState().requestCloseView("t1", vid);
    expect(useCloseConfirm.getState().pending).toBeNull();
    expect(viewExists(vid)).toBe(false);
  });

  it("off — closes immediately even when blocking", () => {
    useSettings.getState().setTabCloseConfirm("off");
    const vid = mkView({ code: "busy", message: "a job is running" });
    useCloseConfirm.getState().requestCloseView("t1", vid);
    expect(useCloseConfirm.getState().pending).toBeNull();
    expect(viewExists(vid)).toBe(false);
  });
});

describe("confirm / cancel", () => {
  it("confirm — closes and clears pending", () => {
    const vid = mkView({ code: "busy", message: "a job is running" });
    useCloseConfirm.getState().requestCloseView("t1", vid);
    useCloseConfirm.getState().confirm();
    expect(useCloseConfirm.getState().pending).toBeNull();
    expect(viewExists(vid)).toBe(false);
  });

  it("cancel — keeps the view and clears pending", () => {
    const vid = mkView({ code: "busy", message: "a job is running" });
    useCloseConfirm.getState().requestCloseView("t1", vid);
    useCloseConfirm.getState().cancel();
    expect(useCloseConfirm.getState().pending).toBeNull();
    expect(viewExists(vid)).toBe(true);
  });
});
