import { create } from "zustand";

// 탭 세션 상태. 각 탭은 재귀적 PANE 레이아웃을 가진다. leaf 하나가 독립 셸(PTY)
// 하나에 대응한다. 비활성 탭은 언마운트하지 않고 숨겨 세션을 유지한다.

// 재귀 pane 트리. leaf = 터미널 하나, split = 자식들의 행/열 묶음.
export type PaneNode =
  | { type: "leaf"; id: string }
  | { type: "split"; dir: "row" | "col"; children: PaneNode[] };

export interface TabState {
  id: string;
  title: string;
  layout: PaneNode;
  focusedPaneId: string;
}

interface SessionsStore {
  tabs: TabState[];
  activeId: string;
  addTab: () => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  renameTab: (id: string, title: string) => void;
  splitPane: (tabId: string, paneId: string, dir: "row" | "col") => void;
  closePane: (tabId: string, paneId: string) => void;
  setFocusedPane: (tabId: string, paneId: string) => void;
}

let nextTabId = 2; // 첫 탭은 t1
let nextPaneId = 2; // 첫 pane 은 p1

const newPaneId = () => `p${nextPaneId++}`;

const leaf = (id: string): PaneNode => ({ type: "leaf", id });

// 트리에서 leaf id 를 모두 수집(포커스 복구·전체 마운트용·호스트 폐기 diff용).
export function collectLeafIds(node: PaneNode, acc: string[] = []): string[] {
  if (node.type === "leaf") {
    acc.push(node.id);
  } else {
    for (const c of node.children) collectLeafIds(c, acc);
  }
  return acc;
}

// leaf paneId 를 split{dir,[해당 leaf, 새 leaf]} 로 교체. 부모가 이미 같은 dir 인
// split 이면 그 자리에 새 leaf 를 이어 붙인다(중첩 회피, 선택적 최적화).
function splitInTree(
  node: PaneNode,
  paneId: string,
  dir: "row" | "col",
  newId: string,
): PaneNode {
  if (node.type === "leaf") {
    if (node.id !== paneId) return node;
    return { type: "split", dir, children: [leaf(paneId), leaf(newId)] };
  }
  // split: 같은 dir 이고 직속 자식 leaf 가 대상이면 그 옆에 새 leaf 삽입.
  if (node.dir === dir) {
    const idx = node.children.findIndex(
      (c) => c.type === "leaf" && c.id === paneId,
    );
    if (idx !== -1) {
      const children = [...node.children];
      children.splice(idx + 1, 0, leaf(newId));
      return { ...node, children };
    }
  }
  return {
    ...node,
    children: node.children.map((c) => splitInTree(c, paneId, dir, newId)),
  };
}

// leaf paneId 를 제거. 자식이 하나만 남는 split 은 그 자식으로 붕괴시킨다.
// 대상이 발견되지 않으면 원본을 그대로 반환. 루트가 leaf 자기 자신이면 null.
function removeInTree(node: PaneNode, paneId: string): PaneNode | null {
  if (node.type === "leaf") {
    return node.id === paneId ? null : node;
  }
  const children: PaneNode[] = [];
  for (const c of node.children) {
    const r = removeInTree(c, paneId);
    if (r !== null) children.push(r);
  }
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]; // 단일 자식 split 붕괴
  return { ...node, children };
}

export const useSessions = create<SessionsStore>((set) => ({
  tabs: [{ id: "t1", title: "1", layout: leaf("p1"), focusedPaneId: "p1" }],
  activeId: "t1",

  addTab: () =>
    set((s) => {
      const id = `t${nextTabId++}`;
      const paneId = newPaneId();
      return {
        tabs: [
          ...s.tabs,
          {
            id,
            title: String(s.tabs.length + 1),
            layout: leaf(paneId),
            focusedPaneId: paneId,
          },
        ],
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

  splitPane: (tabId, paneId, dir) =>
    set((s) => {
      const newId = newPaneId();
      return {
        tabs: s.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                layout: splitInTree(t.layout, paneId, dir, newId),
                focusedPaneId: newId,
              }
            : t,
        ),
      };
    }),

  closePane: (tabId, paneId) =>
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t;
        // 마지막 pane 은 닫지 않음(탭당 최소 1개 유지).
        if (collectLeafIds(t.layout).length <= 1) return t;
        const next = removeInTree(t.layout, paneId);
        if (next === null) return t; // 방어: 전부 제거되면 무시
        const remaining = collectLeafIds(next);
        const focusedPaneId = remaining.includes(t.focusedPaneId)
          ? t.focusedPaneId
          : remaining[0];
        return { ...t, layout: next, focusedPaneId };
      }),
    })),

  setFocusedPane: (tabId, paneId) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId ? { ...t, focusedPaneId: paneId } : t,
      ),
    })),
}));
