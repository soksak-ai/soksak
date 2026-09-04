// Close guard — the blocking decision over view status (R2). Pure function, zero IO — single truth for close risk.
// Close orchestration (confirm dialog, closeView call) is done by the UI on top of this function (R6/§5).
import { allViews, type Tab, type Space } from "./sessions";

// Standard blocking vocabulary (R2) — only these codes trigger the close guard. Every other code is display only.
// A new blocking meaning requires extending this vocabulary through a core change (deliberate gate).
export const STATUS_BLOCKING = ["dirty", "busy", "running"] as const;

// The reason (message ?? code) when the view is close-risky now, otherwise null.
// null when code is outside the blocking set or status is unreported (safe to close immediately).
export function viewCloseReason(view: Tab): string | null {
  const s = view.status;
  if (!s) return null;
  if (!(STATUS_BLOCKING as readonly string[]).includes(s.code)) return null;
  return s.message ?? s.code;
}

// Reasons for every close-risky view inside a content (split grid). Empty array = no guard.
export function contentCloseReasons(content: Space): string[] {
  const out: string[] = [];
  for (const v of allViews(content)) {
    const r = viewCloseReason(v);
    if (r) out.push(r);
  }
  return out;
}
