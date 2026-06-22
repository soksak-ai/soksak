// 닫기 오케스트레이션(R6/§5) — 판정은 closeGuard 순수함수가, 모달 대기 상태는 이 store 가.
// closeView/closeContent 는 동기 CmdResult 라 그 안에서 비동기 확인창을 못 띄운다 → 이 store 가 중재.
//   x 클릭 → request*: 설정 warn 이고 blocking 이면 pending(확인창), 아니면 즉시 close. off 면 항상 즉시.
import { create } from "zustand";
import { allViews, useSessions, type ContentArea, type View } from "./sessions";
import { useSettings } from "./settings";
import { contentCloseReasons, viewCloseReason } from "./closeGuard";

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
  confirm: () => void; // 확인 → 닫고 pending 비움
  cancel: () => void; // 취소 → 닫지 않고 pending 비움
}

function findView(projectId: string, viewId: string): View | undefined {
  const t = useSessions.getState().tabs.find((x) => x.id === projectId);
  if (!t) return undefined;
  for (const c of t.contents)
    for (const v of allViews(c.layout)) if (v.id === viewId) return v;
  return undefined;
}

function findContent(
  projectId: string,
  contentId: string,
): ContentArea | undefined {
  const t = useSessions.getState().tabs.find((x) => x.id === projectId);
  return t?.contents.find((c) => c.id === contentId);
}

const isWarn = () => useSettings.getState().tabCloseConfirm === "warn";

export const useCloseConfirm = create<CloseConfirmState>((set, get) => ({
  pending: null,

  requestCloseView: (projectId, viewId) => {
    const view = findView(projectId, viewId);
    const reason = view ? viewCloseReason(view) : null;
    if (isWarn() && reason) {
      set({
        pending: { kind: "view", projectId, id: viewId, reasons: [reason] },
      });
    } else {
      useSessions.getState().closeView(projectId, viewId);
    }
  },

  requestCloseContent: (projectId, contentId) => {
    const content = findContent(projectId, contentId);
    const reasons = content ? contentCloseReasons(content) : [];
    if (isWarn() && reasons.length > 0) {
      set({ pending: { kind: "content", projectId, id: contentId, reasons } });
    } else {
      useSessions.getState().closeContent(projectId, contentId);
    }
  },

  confirm: () => {
    const p = get().pending;
    if (!p) return;
    if (p.kind === "view") useSessions.getState().closeView(p.projectId, p.id);
    else useSessions.getState().closeContent(p.projectId, p.id);
    set({ pending: null });
  },

  cancel: () => set({ pending: null }),
}));
