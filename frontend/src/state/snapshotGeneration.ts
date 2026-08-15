// Size a snapshot holds — a human sees what is coming in before restoring.
//
// Keeping a place to roll back to is **the store's job** (kv_past — for every write, unconditionally).
// This file once picked only the "lossy writes" and kept a separate copy; a write that rule missed had no
// place to roll back to, and with the same fact in two places, updating one returned a wrong value. What
// remains is one job: counting the size.

/** What this function counts — it does not restate the snapshot shape (present means counted).
 *
 *  A loose upper bound: writing the real type here would make it a second declaration of the snapshot shape. */
export type WindowSnapshotLike = { workspaces?: readonly unknown[] } | null;
type SnapshotLike = WindowSnapshotLike;

/** Tab count in the layout tree — reads the **stored shape** (`{t:"l",v:{views}}` / `{t:"s",children}`).
 *
 *  It differs from the runtime shape (`type:"leaf"` and `tabs`). Counting the runtime shape without that
 *  distinction made this function always return 0, and the test was written on the runtime shape too, so it
 *  was GREEN — e2e caught it (measured 2026-08-01). A node of unknown shape passes through as 0. */
function tabsIn(node: unknown): number {
  if (!node || typeof node !== "object") return 0;
  const n = node as { t?: string; v?: { views?: unknown[] }; children?: unknown[] };
  if (n.t === "l") return Array.isArray(n.v?.views) ? n.v.views.length : 0;
  if (!Array.isArray(n.children)) return 0;
  return n.children.reduce<number>((sum, c) => sum + tabsIn(c), 0);
}

/** Size that snapshot holds — a human sees what is coming in before restoring. */
export function snapshotSize(s: SnapshotLike): { workspaces: number; spaces: number; tabs: number } {
  // In the stored shape a space is `contents` (not the runtime `spaces`).
  const workspaces = (s?.workspaces ?? []) as readonly { contents?: readonly { layout?: unknown }[] }[];
  let spaces = 0;
  let tabs = 0;
  for (const p of workspaces) {
    const list = p.contents ?? [];
    spaces += list.length;
    for (const sp of list) tabs += tabsIn(sp.layout);
  }
  return { workspaces: workspaces.length, spaces, tabs };
}
