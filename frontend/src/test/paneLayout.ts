import type { CardInit, SplitPaneState } from "split-pane";

export type TestLayout<T> = Omit<SplitPaneState, "cards"> & {
  cards: Array<Omit<CardInit, "data"> & { data: T }>;
};

export function paneLayout<T extends { id?: string }>(value: T): TestLayout<T> {
  return {
    xs: [0, 1],
    ys: [0, 1],
    cards: [{ id: value.id ?? "card", c0: 0, c1: 1, r0: 0, r1: 1, data: value }],
  };
}

export function layoutValues<T>(layout: TestLayout<T>): T[] {
  return layout.cards.map((card) => card.data);
}
