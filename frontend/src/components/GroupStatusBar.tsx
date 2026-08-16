import { memo, useEffect, useState } from "react";
import type { Pane } from "../state/sessions";
import {
  statusBarItemsForTab,
  subscribeStatusBarItems,
  type StatusBarItem,
} from "../ui/statusBarItems";

// Status bar at the bottom of a split pane (group).
//
// It places what plugins registered for the active view and reads nothing. The core drew two of
// these itself until 2026-08-16 — a terminal's working directory, a file's path and mode — each
// behind a branch on the content kind, which is a rule about what content means (C6). The
// registry was already there; only these two went around it.

function Item({ item }: { item: StatusBarItem }) {
  const className = `pane-status-item${item.active ? " active" : ""}`;
  // A reading is not a button. Rendering one as a button that does nothing offers an action that is
  // not there, and a pointer that changes shape over it is the report of that offer.
  if (!item.onClick) {
    return (
      <span className={className} title={item.title}>
        {item.label}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={className}
      title={item.title}
      onClick={(e) => {
        e.stopPropagation();
        item.onClick?.();
      }}
    >
      {item.label}
    </button>
  );
}

// memo boundary (principle 2): no re-render on unrelated store writes that preserve group identity.
export const GroupStatusBar = memo(function GroupStatusBar({
  group,
}: {
  group: Pane;
}) {
  const activeId = group.activeTabId ?? "";
  const [items, setItems] = useState<StatusBarItem[]>(() =>
    statusBarItemsForTab(activeId),
  );
  useEffect(() => {
    const update = () => setItems(statusBarItemsForTab(activeId));
    update();
    return subscribeStatusBarItems(update);
  }, [activeId]);
  const left = items.filter((it) => it.side === "left");
  const right = items.filter((it) => it.side !== "left");
  return (
    <div className="pane-status">
      <span className="pane-status-left">
        {left.map((it) => (
          <Item key={it.id} item={it} />
        ))}
      </span>
      <span className="pane-status-right">
        {right.map((it) => (
          <Item key={it.id} item={it} />
        ))}
      </span>
    </div>
  );
});
