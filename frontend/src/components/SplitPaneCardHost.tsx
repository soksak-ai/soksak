import { createPortal } from "react-dom";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { SplitPane, SplitPaneView, type Card, type CardInit, type Divider, type Rect, type SplitPaneState } from "split-pane";

export type SplitPaneCardLayout<T> = Omit<SplitPaneState, "cards"> & {
  cards: Array<Omit<CardInit, "data"> & { data: T }>;
};

type Props<T> = {
  layout: SplitPaneCardLayout<T>;
  className?: string;
  node?: string;
  children: (card: Card, rect: Rect, element: HTMLElement) => ReactNode;
  onLayoutChange?: (layout: SplitPaneCardLayout<T>) => void;
  dividerNodePrefix?: string;
  rectOverride?: (card: Card, rect: Rect, width: number, height: number) => Rect;
  cardVisible?: (card: Card) => boolean;
};

const toLibraryState = <T,>(layout: SplitPaneCardLayout<T>): SplitPaneState => layout;

const fromLibraryState = <T,>(state: SplitPaneState): SplitPaneCardLayout<T> => ({
  ...state,
  cards: state.cards as SplitPaneCardLayout<T>["cards"],
});

/** Core adapter. The library owns card placement and divider input. */
export function SplitPaneCardHost<T>({ layout, className, node, children, onLayoutChange, dividerNodePrefix = "layout/divider", rectOverride, cardVisible }: Props<T>) {
  const hostRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<SplitPane | null>(null);
  const viewRef = useRef<SplitPaneView | null>(null);
  const rectOverrideRef = useRef(rectOverride);
  const cardVisibleRef = useRef(cardVisible);
  rectOverrideRef.current = rectOverride;
  cardVisibleRef.current = cardVisible;
  const [, redraw] = useState(0);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const grid = new SplitPane(toLibraryState(layout), { width: host.clientWidth, height: host.clientHeight, gap: 0, minSize: 0 });
    const view = new SplitPaneView(host, grid, {
      classPrefix: "sp",
      createCard: () => {
        const element = document.createElement("div");
        element.className = "sp-card";
        return element;
      },
      updateCard: (element, card, rect) => {
        const effective = rectOverrideRef.current?.(card, rect, grid.width, grid.height) ?? rect;
        element.style.display = cardVisibleRef.current?.(card) === false ? "none" : "";
        element.dataset.pane = card.id;
        element.dataset.node = `layout/slot/${card.id}`;
        element.dataset.wvGeometryOwner = "";
        element.style.setProperty("--l", `${effective.x}px`);
        element.style.setProperty("--t", `${effective.y}px`);
        element.style.setProperty("--w", `${effective.w}px`);
        element.style.setProperty("--h", `${effective.h}px`);
      },
      updateDivider: (element, divider: Divider) => {
        element.dataset.node = `${dividerNodePrefix}/${divider.axis}/${divider.line}`;
        element.dataset.wvGeometryOwner = "";
      },
      onChange: (reason) => {
        if (reason === "drag" || reason === "center" || reason === "merge") onLayoutChange?.(fromLibraryState<T>(grid.toJSON()));
        redraw((value) => value + 1);
      },
    });
    gridRef.current = grid;
    viewRef.current = view;
    view.render();
    redraw((value) => value + 1);
    return () => {
      view.destroy();
      gridRef.current = null;
      viewRef.current = null;
    };
    // One view instance owns card element lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const grid = gridRef.current;
    const view = viewRef.current;
    if (!grid || !view) return;
    grid.replace(toLibraryState(layout));
    view.render();
    redraw((value) => value + 1);
  }, [layout]);

  const grid = gridRef.current;
  const view = viewRef.current;
  return (
    <div ref={hostRef} className={className} data-node={node} data-split-pane-host>
      {grid && view ? grid.cards.map((card) => {
        const element = view.element(card.id);
        const rect = grid.rect(card.id);
        const effective = rect && rectOverrideRef.current ? rectOverrideRef.current(card, rect, grid.width, grid.height) : rect;
        return element && effective ? createPortal(children(card, effective, element), element, card.id) : null;
      }) : null}
    </div>
  );
}
