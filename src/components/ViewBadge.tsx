// 사이드바 탭 배지(읽지않음 표시) — viewRegistry.badges[key] 를 독립 구독(version 무관 → 뷰
// remount 없이 배지만 갱신). number=카운트(99+ 상한), "dot"=점, null/0=숨김.

import { useViewRegistry } from "../plugins/viewRegistry";

export function ViewBadge({ viewKey }: { viewKey: string }) {
  const badge = useViewRegistry((s) => s.badges[viewKey]);
  if (badge == null) return null;
  if (badge === "dot") return <span className="plugin-badge plugin-badge-dot" />;
  if (badge <= 0) return null;
  return (
    <span className="plugin-badge plugin-badge-count">
      {badge > 99 ? "99+" : badge}
    </span>
  );
}
