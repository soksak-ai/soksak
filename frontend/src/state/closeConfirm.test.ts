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
import { registerMountedViewFocus } from "../plugins/viewFocus";

useSessions.getState().bootstrapFirstWorkspace("/tmp/soksak-closeconfirm");
// The workspace identifier is issued (state/ids.ts), so it is read here rather
// than written down. A literal is a shape the product does not produce, and code
// that reads a prefix is then never run against it (NAMING N4).
const WORKSPACE = useSessions.getState().activeId;
const pristineTabs = JSON.parse(JSON.stringify(useSessions.getState().workspaces));
const pristineActive = useSessions.getState().activeId;

let seq = 0;
// Creates a new plugin view (unique name — avoids dedupe) plus an optional status → returns viewId.
function mkView(status?: { code: string; message?: string }): string {
  const r = useSessions.getState().openPluginView(WORKSPACE, "p", `v${seq++}`, "T");
  if (!r.ok) throw new Error("openPluginView failed");
  if (status) useSessions.getState().setViewStatus(WORKSPACE, r.viewId, status);
  return r.viewId;
}

function viewExists(viewId: string): boolean {
  for (const t of useSessions.getState().workspaces)
    for (const c of t.spaces)
      for (const v of allViews(c.layout)) if (v.id === viewId) return true;
  return false;
}

beforeEach(() => {
  useSessions.setState({
    workspaces: JSON.parse(JSON.stringify(pristineTabs)),
    activeId: pristineActive,
  });
  useSettings.getState().setTabCloseConfirm("warn");
  useCloseConfirm.setState({ pending: null });
});

describe("requestCloseView — branching on the setting and the status", () => {
  it("warn + blocking — sets pending and does not close", () => {
    const vid = mkView({ code: "busy", message: "a job is running" });
    useCloseConfirm.getState().requestCloseView(WORKSPACE, vid);
    expect(useCloseConfirm.getState().pending).toMatchObject({
      kind: "view",
      id: vid,
      reasons: ["a job is running"],
    });
    expect(viewExists(vid)).toBe(true);
  });

  it("not blocking — closes with no pending", async () => {
    const vid = mkView(); // no status
    useCloseConfirm.getState().requestCloseView(WORKSPACE, vid);
    expect(useCloseConfirm.getState().pending).toBeNull();
    await vi.waitFor(() => expect(viewExists(vid)).toBe(false));
  });

  it("off — closes even when blocking", async () => {
    useSettings.getState().setTabCloseConfirm("off");
    const vid = mkView({ code: "busy", message: "a job is running" });
    useCloseConfirm.getState().requestCloseView(WORKSPACE, vid);
    expect(useCloseConfirm.getState().pending).toBeNull();
    await vi.waitFor(() => expect(viewExists(vid)).toBe(false));
  });

  it("keeps a mounted view until its provider has closed", async () => {
    useSettings.getState().setTabCloseConfirm("off");
    const vid = mkView();
    let release!: () => void;
    const closing = new Promise<void>((resolve) => { release = resolve; });
    const closeView = vi.fn(async () => closing);
    const unregister = registerMountedViewFocus(
      vid,
      document.createElement("div"),
      { closeView } as never,
      () => ({ viewId: vid }) as never,
    );
    try {
      useCloseConfirm.getState().requestCloseView(WORKSPACE, vid);
      await Promise.resolve();
      expect(closeView).toHaveBeenCalledOnce();
      expect(viewExists(vid)).toBe(true);
      release();
      await vi.waitFor(() => expect(viewExists(vid)).toBe(false));
    } finally {
      unregister();
    }
  });
});

describe("confirm / cancel", () => {
  it("confirm — closes and clears pending", async () => {
    const vid = mkView({ code: "busy", message: "a job is running" });
    useCloseConfirm.getState().requestCloseView(WORKSPACE, vid);
    useCloseConfirm.getState().confirm();
    expect(useCloseConfirm.getState().pending).toBeNull();
    await vi.waitFor(() => expect(viewExists(vid)).toBe(false));
  });

  it("cancel — keeps the view and clears pending", () => {
    const vid = mkView({ code: "busy", message: "a job is running" });
    useCloseConfirm.getState().requestCloseView(WORKSPACE, vid);
    useCloseConfirm.getState().cancel();
    expect(useCloseConfirm.getState().pending).toBeNull();
    expect(viewExists(vid)).toBe(true);
  });
});
