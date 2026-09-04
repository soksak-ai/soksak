import { SplitPane } from "split-pane";
import type { CardInit, Side, SplitPaneState } from "split-pane";

export interface SidebarGroup {
  viewKeys: string[];
  activeViewKey: string;
}

export type SidebarLayout = Omit<SplitPaneState, "cards"> & {
  cards: Array<Omit<CardInit, "data"> & { data: SidebarGroup }>;
};

const group = (viewKeys: string[]): SidebarGroup => ({ viewKeys, activeViewKey: viewKeys[0] ?? "" });
const gridOf = (layout: SidebarLayout): SplitPane => new SplitPane(layout, { width: 100, height: 100, gap: 0, minSize: 0 });
const stateOf = (grid: SplitPane): SidebarLayout => {
  const state = grid.toJSON();
  return { ...state, cards: state.cards.map((card) => ({ ...card, data: card.data as SidebarGroup })) };
};

export function initialSidebarLayout(registeredKeys: string[]): SidebarLayout {
  return { xs: [0, 1], ys: [0, 1], cards: [{ id: "sidebar-group", c0: 0, c1: 1, r0: 0, r1: 1, data: group(registeredKeys) }] };
}

export function sidebarViewKeys(layout: SidebarLayout): string[] { return layout.cards.flatMap((card) => card.data.viewKeys); }
export function activeKeysOf(layout: SidebarLayout): string[] { return layout.cards.map((card) => card.data.activeViewKey).filter(Boolean); }

export function reconcileSidebarLayout(layout: SidebarLayout, registeredKeys: string[]): SidebarLayout {
  const registered = new Set(registeredKeys);
  const cards = layout.cards.map((card) => {
    const viewKeys = card.data.viewKeys.filter((key) => registered.has(key));
    return { ...card, data: { viewKeys, activeViewKey: viewKeys.includes(card.data.activeViewKey) ? card.data.activeViewKey : (viewKeys[0] ?? "") } };
  }).filter((card) => card.data.viewKeys.length > 0);
  const present = new Set(cards.flatMap((card) => card.data.viewKeys));
  const fresh = registeredKeys.filter((key) => !present.has(key));
  if (fresh.length > 0) {
    const target = cards[0] ?? { id: "sidebar-group", c0: 0, c1: 1, r0: 0, r1: 1, data: group([]) };
    if (cards.length === 0) cards.push(target);
    target.data = { viewKeys: [...target.data.viewKeys, ...fresh], activeViewKey: target.data.activeViewKey || fresh[0] || "" };
  }
  return cards.length > 0 ? { ...layout, cards } : initialSidebarLayout(registeredKeys);
}

export type SidebarDrop =
  | { type: "into"; targetKey: string }
  | { type: "split"; targetKey: string; dir: "row" | "col"; before: boolean };

function groupOf(layout: SidebarLayout, viewKey: string) { return layout.cards.find((card) => card.data.viewKeys.includes(viewKey)); }

export function moveSidebarView(layout: SidebarLayout, viewKey: string, drop: SidebarDrop): SidebarLayout {
  const source = groupOf(layout, viewKey);
  if (!source) return layout;
  if (drop.type === "split" && source.data.viewKeys.length === 1 && source.data.viewKeys.includes(drop.targetKey)) return layout;
  const cards = layout.cards.map((card) => card.data.viewKeys.includes(viewKey)
    ? { ...card, data: { ...card.data, viewKeys: card.data.viewKeys.filter((key) => key !== viewKey), activeViewKey: card.data.activeViewKey === viewKey ? (card.data.viewKeys.find((key) => key !== viewKey) ?? "") : card.data.activeViewKey } }
    : card).filter((card) => card.data.viewKeys.length > 0);
  if (drop.type === "into") return { ...layout, cards: cards.map((card) => card.data.viewKeys.includes(drop.targetKey) ? { ...card, data: { viewKeys: [...card.data.viewKeys, viewKey], activeViewKey: viewKey } } : card) };
  const next: SidebarLayout = { ...layout, cards };
  const target = groupOf(next, drop.targetKey);
  if (!target) return layout;
  const side: Side = drop.dir === "row" ? (drop.before ? "left" : "right") : (drop.before ? "top" : "bottom");
  const grid = gridOf(next);
  if (!grid.splitToward(target.id, side, { id: `${source.id}-${viewKey}`, data: group([viewKey]) })) return layout;
  return stateOf(grid);
}

export function hasSidebarView(layout: SidebarLayout, viewKey: string): boolean { return sidebarViewKeys(layout).includes(viewKey); }
export const hasSidebarSplit = (layout: SidebarLayout, id: string): boolean => layout.cards.some((card) => card.id === id);
