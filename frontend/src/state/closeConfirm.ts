// Close orchestration (R6/§5) — the closeGuard pure functions judge, this store holds the modal-pending state.
// closeView/closeContent return a synchronous CmdResult and cannot raise an async confirm dialog inside → this store mediates.
//   x click → request*: setting warn + blocking → pending (confirm dialog); otherwise close now. off always closes now.
import { moduleState } from "../lib/moduleState";
import { create } from "zustand";
import { allViews, useSessions, type Space, type Tab } from "./sessions";
import { useSettings } from "./settings";
import { contentCloseReasons, viewCloseReason } from "./closeGuard";
import { closeViewPermanently, endSessionsOnView } from "./permanentViewClose";

export interface ClosePending {
  kind: "view" | "content";
  projectId: string;
  id: string;
  reasons: string[];
}

interface CloseConfirmState {
  pending: ClosePending | null;
  requestCloseView: (projectId: string, viewId: string) => void;
  requestCloseContent: (projectId: string, contentId: string) => void;
  confirm: () => void; // confirm: close, then clear pending
  cancel: () => void; // cancel: do not close, clear pending
}

function findView(projectId: string, viewId: string): Tab | undefined {
  const t = useSessions.getState().workspaces.find((x) => x.id === projectId);
  if (!t) return undefined;
  for (const c of t.spaces)
    for (const v of allViews(c.layout)) if (v.id === viewId) return v;
  return undefined;
}

function findContent(
  projectId: string,
  contentId: string,
): Space | undefined {
  const t = useSessions.getState().workspaces.find((x) => x.id === projectId);
  return t?.spaces.find((c) => c.id === contentId);
}

const isWarn = () => useSettings.getState().tabCloseConfirm === "warn";

// Closing a space takes every view in it, so every view's sessions end.
//
// The views are named before the space is removed: afterwards there is nothing left to enumerate,
// and the core's index would still hold sessions on views that no longer exist. Each view goes
// through the same permanent close a single view does, so no path has its own idea of what closing
// means.
async function closeContentPermanently(projectId: string, contentId: string) {
  const content = findContent(projectId, contentId);
  const views = content ? allViews(content.layout) : [];
  for (const view of views) await endSessionsOnView(view.id);
  return useSessions.getState().closeContent(projectId, contentId);
}
const closeNow = (projectId: string, viewId: string) => {
  void closeViewPermanently(projectId, viewId).catch((error) => {
    useSessions.getState().setViewStatus(projectId, viewId, {
      code: "error",
      message: String(error),
    });
  });
};

// The store is outside the module boundary — if a hot swap replaces it, registrations, subscriptions, and screen
// state all become new, while the filling side treats them as already filled and never refills (empty forever).
export const useCloseConfirm = moduleState("state/closeConfirm#store", () =>
  create<CloseConfirmState>((set, get) => ({
  pending: null,

  requestCloseView: (projectId, viewId) => {
    const view = findView(projectId, viewId);
    const reason = view ? viewCloseReason(view) : null;
    if (isWarn() && reason) {
      set({
        pending: { kind: "view", projectId, id: viewId, reasons: [reason] },
      });
    } else {
      closeNow(projectId, viewId);
    }
  },

  requestCloseContent: (projectId, contentId) => {
    const content = findContent(projectId, contentId);
    const reasons = content ? contentCloseReasons(content) : [];
    if (isWarn() && reasons.length > 0) {
      set({ pending: { kind: "content", projectId, id: contentId, reasons } });
    } else {
      void closeContentPermanently(projectId, contentId);
    }
  },

  confirm: () => {
    const p = get().pending;
    if (!p) return;
    if (p.kind === "view") closeNow(p.projectId, p.id);
    else void closeContentPermanently(p.projectId, p.id);
    set({ pending: null });
  },

  cancel: () => set({ pending: null }),
})),
);
