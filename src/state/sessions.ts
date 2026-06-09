import { create } from "zustand";

// 탭 세션 상태. 각 탭은 독립 셸(PTY) 하나. 비활성 탭은 언마운트하지 않고 숨겨
// 세션을 유지한다(전환 시 셸이 살아있음).

export interface TabState {
  id: string;
  title: string;
}

interface SessionsStore {
  tabs: TabState[];
  activeId: string;
  addTab: () => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  renameTab: (id: string, title: string) => void;
}

let nextId = 2; // 첫 탭은 t1

export const useSessions = create<SessionsStore>((set) => ({
  tabs: [{ id: "t1", title: "1" }],
  activeId: "t1",

  addTab: () =>
    set((s) => {
      const id = `t${nextId++}`;
      return {
        tabs: [...s.tabs, { id, title: String(s.tabs.length + 1) }],
        activeId: id,
      };
    }),

  closeTab: (id) =>
    set((s) => {
      if (s.tabs.length <= 1) return s; // 마지막 탭은 닫지 않음
      const idx = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      let activeId = s.activeId;
      if (activeId === id) {
        // 닫힌 탭이 활성이면 인접 탭으로 이동.
        activeId = (tabs[idx] ?? tabs[idx - 1] ?? tabs[0]).id;
      }
      return { tabs, activeId };
    }),

  setActive: (id) => set({ activeId: id }),

  renameTab: (id, title) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)),
    })),
}));
