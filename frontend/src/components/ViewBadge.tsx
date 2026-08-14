// Sidebar tab badge (unread marker) — subscribes to viewRegistry.badges[key] separately, with no
// dependency on version, so the badge updates without a view remount. number = count (capped at
// 99+), "dot" = dot, null/0 = hidden.

import { useViewRegistry } from "../plugins/viewRegistry";

export function ViewBadge({ viewKey }: { viewKey: string }) {
  const badge = useViewRegistry((s) => s.badges[viewKey]);
  if (badge == null) return null;
  if (badge === "dot") return <span className="tab-badge tab-badge-dot" />;
  if (badge <= 0) return null;
  return (
    <span className="tab-badge tab-badge-count">
      {badge > 99 ? "99+" : badge}
    </span>
  );
}
