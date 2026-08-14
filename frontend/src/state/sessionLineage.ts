// [Stage ⑤] AI session lineage tracking — claude does not record /clear and /resume branches in a file (measured), so the terminal
// While claude runs, watch that cwd session directory to observe the transition. notify fs-change
// Event driven — the OS wakes it only on a file change (0 periodic queries, not polling). The transition decision (against the previous snapshot
// the session just written) is performed as the single truth by the core ai_session_active (SessionTracker); this only wires it.

import { moduleState } from "../lib/moduleState";
import { invoke } from "../framework";
import { safeListen } from "../lib/safeListen";

const LINEAGE_NS = "core";
const LINEAGE_COLL = "ai_session_lineage";

type Tracked = { viewIds: Set<string>; lastSession: string | null; cwd: string };
// Tracking per session directory (multiple terminals with the same cwd share a dir — with no PID it cannot be narrowed further). viewId→dir reverse index.
const byDir = moduleState(
  "state/sessionLineage#byDir",
  () => new Map<string, Tracked>(),
);
const viewToDir = moduleState(
  "state/sessionLineage#viewToDir",
  () => new Map<string, string>(),
);
// Distinct things stand apart — put them in one bag and it is a bag, not state.
/** Handle for releasing the file watch. */
const watcher = moduleState("state/sessionLineage#watcher", () => ({
  fsUnlisten: null as (() => void) | null,
}));

/** Whether it is a collection definition — the watch and the lifetime differ. */
const schema = moduleState("state/sessionLineage#schema", () => ({
  defined: false,
}));

async function ensureDefined(): Promise<void> {
  if (schema.defined) return;
  schema.defined = true;
  await invoke("data_define", { ns: LINEAGE_NS, coll: LINEAGE_COLL, indexes: ["viewId"], fts: [] }).catch(() => {});
}

function ensureFsListener(): void {
  if (watcher.fsUnlisten) return;
  // notify fs-change (the parent directory of the changed entry) — confirmed only when it is one of the session directories being watched.
  watcher.fsUnlisten = safeListen<string>("fs-change", (e) => {
    if (byDir.has(e.payload)) void refresh(e.payload);
  });
}

// On an fs-change event — fix the dir's active session in the core (compare against the previous snapshot), and record a transition when it differs from the previous one.
async function refresh(dir: string): Promise<void> {
  const t = byDir.get(dir);
  if (!t) return;
  let active: string | null;
  try {
    active = await invoke<string | null>("ai_session_active", { dir });
  } catch {
    return;
  }
  if (!active || active === t.lastSession) return;
  const from = t.lastSession;
  t.lastSession = active;
  // (viewId, from→to, kind, time) transition record — used to reconstruct 'where it branched and how it flowed' after a restore.
  for (const viewId of t.viewIds) {
    await invoke("data_put", {
      ns: LINEAGE_NS,
      coll: LINEAGE_COLL,
      scope: t.cwd,
      id: null,
      doc: { viewId, fromSession: from, toSession: active, kind: "claude", time: Date.now() },
    }).catch(() => {});
  }
}

// claude run start (command.started) — arm the watch on the cwd session directory.
export async function startSessionTrack(viewId: string, cwd: string): Promise<void> {
  if (!cwd) return;
  let dir: string;
  try {
    dir = await invoke<string>("ai_session_dir", { cwd });
  } catch {
    return;
  }
  let t = byDir.get(dir);
  if (!t) {
    t = { viewIds: new Set(), lastSession: null, cwd };
    byDir.set(dir, t);
    await invoke("watch_dir", { path: dir }).catch(() => {});
  }
  t.viewIds.add(viewId);
  viewToDir.set(viewId, dir);
  ensureFsListener();
  await ensureDefined();
  // Confirmed once right after start — the moment claude writes the first session file (right after the event, not polling).
  await refresh(dir);
}

// claude exit (command.finished) — disarm the watch. Unwatch when no other viewId uses the same dir.
export async function stopSessionTrack(viewId: string): Promise<void> {
  const dir = viewToDir.get(viewId);
  if (!dir) return;
  viewToDir.delete(viewId);
  const t = byDir.get(dir);
  if (!t) return;
  t.viewIds.delete(viewId);
  if (t.viewIds.size === 0) {
    byDir.delete(dir);
    await invoke("ai_session_untrack", { dir }).catch(() => {});
    await invoke("unwatch_dir", { path: dir }).catch(() => {});
  }
}

// Whether this viewId is currently tracking a claude session (the block agentKind decision — no re-detect at turn.ended).
export function isTracking(viewId: string): boolean {
  return viewToDir.has(viewId);
}

// The current session of this viewId (the watch-tracked value) — the sessionId turn.ended puts on the block (replaces find polling).
export function currentSessionOf(viewId: string): string | null {
  const dir = viewToDir.get(viewId);
  return dir ? byDir.get(dir)?.lastSession ?? null : null;
}
