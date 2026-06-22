// 닫기 오케스트레이션(R6/§5) — request → pending(확인) vs 즉시 close, confirm/cancel.
import { beforeEach, describe, expect, it, vi } from "vitest";

// settings 가 import 시 localStorage 를 읽으므로 stub 을 먼저(pluginSettings.test 선례).
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

useSessions.getState().bootstrapFirstProject("/tmp/soksak-closeconfirm");
const pristineTabs = JSON.parse(JSON.stringify(useSessions.getState().tabs));
const pristineActive = useSessions.getState().activeId;

let seq = 0;
// 새 plugin 뷰 생성(이름 유니크 — dedupe 회피) + 선택적 status 부여 → viewId 반환.
function mkView(status?: { code: string; message?: string }): string {
  const r = useSessions.getState().openPluginView("t1", "p", `v${seq++}`, "T");
  if (!r.ok) throw new Error("openPluginView 실패");
  if (status) useSessions.getState().setViewStatus("t1", r.viewId, status);
  return r.viewId;
}

function viewExists(viewId: string): boolean {
  for (const t of useSessions.getState().tabs)
    for (const c of t.contents)
      for (const v of allViews(c.layout)) if (v.id === viewId) return true;
  return false;
}

beforeEach(() => {
  useSessions.setState({
    tabs: JSON.parse(JSON.stringify(pristineTabs)),
    activeId: pristineActive,
  });
  useSettings.getState().setTabCloseConfirm("warn");
  useCloseConfirm.setState({ pending: null });
});

describe("requestCloseView — 설정·status 에 따른 분기", () => {
  it("warn + blocking → pending 세움(즉시 닫지 않음)", () => {
    const vid = mkView({ code: "busy", message: "작업 중" });
    useCloseConfirm.getState().requestCloseView("t1", vid);
    expect(useCloseConfirm.getState().pending).toMatchObject({
      kind: "view",
      id: vid,
      reasons: ["작업 중"],
    });
    expect(viewExists(vid)).toBe(true);
  });

  it("blocking 아니면 즉시 닫힘(pending 없음)", () => {
    const vid = mkView(); // status 없음
    useCloseConfirm.getState().requestCloseView("t1", vid);
    expect(useCloseConfirm.getState().pending).toBeNull();
    expect(viewExists(vid)).toBe(false);
  });

  it("off 면 blocking 이어도 즉시 닫힘", () => {
    useSettings.getState().setTabCloseConfirm("off");
    const vid = mkView({ code: "busy", message: "작업 중" });
    useCloseConfirm.getState().requestCloseView("t1", vid);
    expect(useCloseConfirm.getState().pending).toBeNull();
    expect(viewExists(vid)).toBe(false);
  });
});

describe("confirm / cancel", () => {
  it("confirm → 닫고 pending 비움", () => {
    const vid = mkView({ code: "busy", message: "작업 중" });
    useCloseConfirm.getState().requestCloseView("t1", vid);
    useCloseConfirm.getState().confirm();
    expect(useCloseConfirm.getState().pending).toBeNull();
    expect(viewExists(vid)).toBe(false);
  });

  it("cancel → 유지(안 닫음) + pending 비움", () => {
    const vid = mkView({ code: "busy", message: "작업 중" });
    useCloseConfirm.getState().requestCloseView("t1", vid);
    useCloseConfirm.getState().cancel();
    expect(useCloseConfirm.getState().pending).toBeNull();
    expect(viewExists(vid)).toBe(true);
  });
});
