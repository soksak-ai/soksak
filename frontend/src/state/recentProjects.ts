// Recent project list — data source for the rail and the control-plane project map. core kv
// "recentProjects" (makeCoreStore: app.data authority + localStorage cache + cross-window
// broadcast — every window shows the same list no matter which one opened the project).
// Recorded on explicit open success (addProjectClaimed) and on default boot — restore does not
// record (it only keeps what the list already had).

import { moduleState } from "../lib/moduleState";
import { useEffect, useState } from "react";
import { coreStoreDeps } from "./windowBoot";
import { makeCoreStore } from "./coreStore";

export interface RecentProject {
  root: string; // identity (P4) — normalized path
  alias: string; // display name (folder name when empty)
  lastOpenedAt: number; // epoch ms
}

export const RECENT_CAP = 20;

/** Pure upsert — updates the same root (dedup), sorts by last opened descending, drops the oldest past the cap. */
export function upsertRecent(
  list: RecentProject[],
  entry: RecentProject,
  cap: number = RECENT_CAP,
): RecentProject[] {
  const rest = list.filter((r) => r.root !== entry.root);
  rest.push(entry);
  rest.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  return rest.slice(0, cap);
}

type Store = ReturnType<typeof makeCoreStore<RecentProject[]>>;
// The injection point must cross the hot-swap boundary — when only this slot is empty, the side
// that filled it treats it as already filled and does not refill. What remains is "nobody
// answers", and that silence is not an error.
const storeSlot = moduleState("state/recentProjects#storeSlot.v", () => ({ v: null as Store | null }));
function recentStore(): Store {
  storeSlot.v ??= makeCoreStore<RecentProject[]>({
    key: "recentProjects",
    lsKey: "soksak.recentProjects",
    fallback: [],
    ...coreStoreDeps,
  });
  return storeSlot.v;
}

/** Records a successful open — a failure here does not block the open (the list is convenience data). */
export async function recordRecentProject(root: string, alias: string): Promise<void> {
  try {
    const s = recentStore();
    const cur = await s.hydrate();
    await s.save(
      upsertRecent(cur, {
        root,
        alias: alias || (root.split("/").filter(Boolean).pop() ?? root),
        lastOpenedAt: Date.now(),
      }),
    );
  } catch (e) {
    console.warn("recording the recent project failed:", e);
  }
}

/** Lookup for the rail and the project map. */
/**
 * Narrows a value to this list's contract.
 *
 * What the store returns is what the renderer iterates. Without a shape check where the type is
 * asserted, the mismatch blows up at the use site and the error points at the consumer instead of
 * the value — measured 2026-08-15: the persisted value was `{}` and the first render died with
 * `recentAll.filter is not a function`. An entry without root cannot be matched, opened, or
 * removed, so it is dropped too.
 */
export function asRecentProjects(value: unknown): RecentProject[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is RecentProject =>
      typeof entry === "object" && entry !== null && typeof (entry as RecentProject).root === "string",
  );
}

export async function listRecentProjects(): Promise<RecentProject[]> {
  try {
    return asRecentProjects(await recentStore().hydrate());
  } catch {
    return [];
  }
}

/** Removes an entry — for when root no longer exists (self-healing after a failed rail click). */
export async function removeRecentProject(root: string): Promise<void> {
  try {
    const s = recentStore();
    const cur = await s.hydrate();
    await s.save(cur.filter((r) => r.root !== root));
  } catch (e) {
    console.warn("removing the recent project failed:", e);
  }
}

/** Reactive recent list (shared by rail and picker) — data-change(recentProjects) + initial hydrate.
 *  The rail filters this down to entries not already open and uses them as open buttons for this window. */
export function useRecentProjects(): RecentProject[] {
  const [list, setList] = useState<RecentProject[]>([]);
  useEffect(() => {
    let disposed = false;
    const refresh = () =>
      void listRecentProjects().then((l) => {
        if (!disposed) setList(l);
      });
    refresh();
    const un = coreStoreDeps.onDataChange((key) => {
      if (key === "recentProjects") refresh();
    });
    return () => {
      disposed = true;
      un();
    };
  }, []);
  return list;
}
