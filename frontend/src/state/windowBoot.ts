// Workspace persistence boot (A5) — called once by the main.tsx boot. Joins core-kv storage and the sessions store.
//  1) Restore: hydrate the "window/<label>" snapshot → restoreProjects + reseed when present, otherwise return false
//     (the caller falls back to bootstrapFirstProject).
//  2) Autosave: on every sessions change, save the snapshot debounced + upsert the manifest.
//  3) manifest: upsert this window's (label) slot under the "windows" key.
//
// coreStore absorbs the localStorage sync cache + app.data authority and broadcast, so this file is serialization and wiring only.

import { invoke, currentWindow, frameworkName } from "../framework";
import { safeListen } from "../lib/safeListen";
import { bootFactPayload } from "../lib/bootFact";
import {
  mayPersist,
  mayAdoptLateRead,
  snapshotRead,
  snapshotUnread,
  type SnapshotRead,
} from "./persistGuard";
import { noteDataChange } from "./dataChangeHealth";
import { currentWindowLabel } from "../lib/webviewLabels";
import { makeCoreStore } from "./coreStore";
import { validateProjectRoot, ensureDefaultProjectRoot } from "../lib/projectRoot";
import { claimRoots } from "./projectRegistry";
import { beginRestoreHydration } from "./hydration";
import { releaseWebviewGcHold } from "../lib/webviewGc";
import { reseedSessionsSnapshot } from "../plugins/hooks";
import { useProjection, type Pins } from "./projection";
import { listRecentProjects } from "./recentProjects";
import {
  useSessions,
  nextSplitIdGen,
  migrateSpaceTitle,
  type Project,
} from "./sessions";
import {
  snapshotWindow,
  restoreWindow,
  windowManifestEntry,
  upsertManifest,
  restorableSlots,
  forgetWindow,
  frameworkScopedKey,
  type WindowSnapshot,
  type WindowManifest,
} from "./windowPersistence";

// This window's frame (logical px) — for the manifest rect. On failure the rect is omitted (restore uses the OS default position).
async function currentFrame(): Promise<
  { x: number; y: number; w: number; h: number } | undefined
> {
  try {
    const win = currentWindow();
    const [pos, size, scale] = await Promise.all([
      win.outerPosition(),
      win.outerSize(),
      win.scaleFactor(),
    ]);
    return {
      x: Math.round(pos.x / scale),
      y: Math.round(pos.y / scale),
      w: Math.round(size.width / scale),
      h: Math.round(size.height / scale),
    };
  } catch {
    return undefined;
  }
}

// core ns data-change → the (key)=>void coreStore expects. The kv key is the payload id field.
function coreOnDataChange(cb: (key: string) => void): () => void {
  return safeListen<{ ns: string; id: string | null; op?: string }>("data-change", (e) => {
    // Count arrivals first — a notification for an ns this window does not use is still evidence the path is alive.
    // Filtering before counting makes "it never came" and "it came but was not mine" look the same (A22 notification axis).
    noteDataChange(e.payload.ns, e.payload.op ?? "");
    if (e.payload.ns === "core" && e.payload.id) cb(e.payload.id);
  });
}

// core kv storage dependencies (invoke/data-change/ls) — shared with other core persisted state such as viewLabels.
export const coreStoreDeps = {
  invoke: (cmd: string, args: Record<string, unknown>) => invoke(cmd, args),
  onDataChange: coreOnDataChange,
  localStorage: window.localStorage,
};

const EMPTY_WINDOW: WindowSnapshot = { activeId: "", projects: [] };
const EMPTY_MANIFEST: WindowManifest = { slots: [] };

function debounce<A extends unknown[]>(
  fn: (...a: A) => void,
  ms: number,
): (...a: A) => void {
  let h: ReturnType<typeof setTimeout> | null = null;
  return (...a: A) => {
    if (h) clearTimeout(h);
    h = setTimeout(() => fn(...a), ms);
  };
}

// Once per boot. true when restore succeeded (the caller skips bootstrap), false when there was none (the caller falls back).
export async function initWorkspacePersistence(
): Promise<boolean> {
  const label = currentWindowLabel();
  const winStore = makeCoreStore<WindowSnapshot>({
    key: `window/${label}`,
    lsKey: `soksak.window.${label}`,
    fallback: EMPTY_WINDOW,
    ...coreStoreDeps,
  });
  // Restore path observation surface — a blank or empty restore has no visible cause in snapshots or DOM (same reason
  // as boot.error). Publishes step facts (hydrate count, drop count, result) to the activity hub, readable over the socket alone.
  const bootFact = (step: string) =>
    void invoke("activity_publish", {
      kind: "boot.step",
      source: "boot",
      payload: bootFactPayload(step),
    }).catch(() => {});

  // 1) Restore
  let restored = false;
  // What was known before the restore. If something was known and none of it survived, saving is blocked — that empty
  // state is not user intent but the trace of a failed restore (persistGuard header).
  //
  // The read itself can fail (the store's owner is a separate process). That failure must be recorded as unread, not
  // as count 0 — written as 0 it equals "an originally empty window" and the guard opens.
  let snapshot: SnapshotRead = snapshotUnread();
  let restoredProjects = 0;
  try {
    const snap = await winStore.hydrate();
    snapshot = snapshotRead(snap.projects.length);
    bootFact(`restore:hydrated:${snap.projects.length}`);
    if (snap.projects.length > 0) {
      const { projects, activeId, projections } = restoreWindow(snap, nextSplitIdGen);
      // root existence check — an absent or invalid root demotes the tab to rootMissing instead of deleting it
      // (no unauthorized deletion). A banner reports it, and a returning path resolves it naturally on the next restore.
      await Promise.all(
        projects.map(async (t) => {
          try {
            await validateProjectRoot(t.root);
          } catch {
            t.rootMissing = true;
            console.warn(`[restore] project root missing — restored as a demoted tab: ${t.root}`);
          }
        }),
      );
      // P6 (globally single open): claim every root of this window's snapshot at once. Tabs whose root another
      // window already holds are dropped in this window (no duplicate window per project — graceful degradation).
      const denied = await claimRoots(projects.map((t) => t.root));
      bootFact(`restore:denied:${denied.size}`);
      const owned = projects
        .filter((t) => !denied.has(t.root))
        // Load-time migration — promotes an old purely numeric space title ("3") to the i18n space title (idempotent;
        // spreadsheet-style naming makes it explicit that it is a space). Titles the user changed are kept (numeric only).
        .map((t) => ({
          ...t,
          spaces: t.spaces.map((c) => ({ ...c, title: migrateSpaceTitle(c.title) })),
        }));
      for (const t of projects) {
        if (denied.has(t.root))
          console.warn(`[P6] restored tab dropped (held by another window): ${t.root}`);
      }
      const active = owned.some((t) => t.id === activeId)
        ? activeId
        : (owned[0]?.id ?? "");
      if (owned.length > 0) {
        // Rail pin restore (§4.5, R9) — seeding before the tracking sweep (guaranteed by the main boot order).
        for (const t of owned) {
          const seed = projections[t.id];
          if (seed) useProjection.getState().seedProject(t.id, seed);
        }
        useSessions.getState().restoreProjects(owned, active);
        // Restore is not creation (§5 replay != observation) — reseeds the diff baseline to now, so a restore delta is
        // never mistaken for project.created (which would auto-run plugin git.init and the like).
        reseedSessionsSnapshot();
        // B4 — restore hydration: defers body mount of invisible restored views (spreading concurrent PTY
        // spawn), and an idle chain fills them in lastActivity order. The outer shell appears all at once.
        beginRestoreHydration();
      }
      restoredProjects = useSessions.getState().projects.length;
      restored = restoredProjects > 0;
    }
    bootFact(`restore:done:${restored}`);
  } catch (e) {
    bootFact(`restore:error:${String(e).slice(0, 120)}`);
    console.error("workspace restore failed — falling back to the default boot:", e);
  }
  // Restore attempt finished (success, no snapshot, or failure alike) — the store is now this window's truth, so
  // release webviewGc's recovery reboot hold (webviewGc.ts gcGate header).
  releaseWebviewGcHold();

  // 2) Autosave — debounced per change (rapid consecutive changes save once). On pagehide (window close or just
  // before app exit) the remaining record is flushed immediately — this prevents losing the last change of an exit
  // inside the debounce window (<=400ms) (same pattern as coreSync.ts — B1 consistency: saving is flushed at exit).
  // Nothing is written when the snapshot could not be read at boot. Never writing is also a loss, so at the moment a
  // write is needed it reads once more — this clears if the owner (cored) came up late or came back.
  // It is not polling: it runs only on a user change, and once read it never runs again.
  const settleUnread = async (): Promise<void> => {
    if (snapshot.read) return;
    let late: WindowSnapshot;
    try {
      late = await winStore.hydrate();
    } catch (e) {
      bootFact(`persist:blocked:unread:${String(e).slice(0, 80)}`);
      return;
    }
    if (!mayAdoptLateRead(late.projects.length)) {
      // The late read came back non-empty — this window has never restored it (persistGuard header).
      bootFact(`persist:blocked:unrestored:${late.projects.length}`);
      return;
    }
    snapshot = snapshotRead(late.projects.length);
    bootFact("persist:unblocked:0");
  };

  const persistOnce = async (): Promise<void> => {
    await settleUnread();
    const { projects, activeId } = useSessions.getState();
    // The unknown must not overwrite the known — a window whose restore failed entirely, or that could not read the
    // snapshot, does not save. Without this guard, the user's workspace was erased on 2026-08-01 (measured).
    if (!mayPersist({ snapshot, restoredProjects, liveProjects: projects.length })) {
      return;
    }
    const projections: Record<string, { pins: Pins }> = {};
    for (const [pid, e] of Object.entries(useProjection.getState().byProject)) {
      projections[pid] = { pins: e.pins };
    }
    await persistNow(label, projects, activeId, projections, winStore);
  };
  const doPersist = () => void persistOnce();
  const persist = debounce(doPersist, 400);
  useSessions.subscribe(persist);
  // Pin and seen changes also trigger a save (§4.5) — coalesced by the same debounce.
  useProjection.subscribe(persist);
  window.addEventListener("pagehide", doPersist);
  // Window move/resize also triggers a save (B2 rect) — it is not a sessions change, so the subscription above misses it.
  // Native event based (zero polling), coalesced by the same debounce.
  void currentWindow().onMoved(persist);
  void currentWindow().onResized(persist);

  return restored;
}

async function persistNow(
  label: string,
  projects: Project[],
  activeId: string,
  projections: Record<string, { pins: Pins }>,
  winStore: ReturnType<typeof makeCoreStore<WindowSnapshot>>,
): Promise<void> {
  try {
    const snap = snapshotWindow(projects, activeId, projections);
    // Keeping the previous value is the store's job (kv_past — for every write, unconditionally).
    // This site once picked out only "losing writes" and kept a copy aside, but then ① a write the picking rule
    // misses has nowhere to roll back to and ② the same fact is stored twice, so updating one returns a wrong value.
    // Whatever this window does, whatever new bug appears, the store has a place to roll back to.
    await winStore.save(snap);
    // Window frame (B2) — respawn brings it back at the same place and size (dual-monitor layout kept).
    const entry = { ...windowManifestEntry(label, projects, activeId), rect: await currentFrame() };
    // The ledger is not read-modify-written. Two frameworks share one home, so writing the whole thing back makes
    // the later write erase the other's slot — it shows up as "after a restart that window does not open".
    // Merging is done by the side holding the store, inside one transaction (window_manifest_upsert).
    await invoke("window_manifest_upsert", { entry, focused: document.hasFocus() });
  } catch (e) {
    console.error("workspace save failed:", e);
  }
}

// Multi-window respawn (B2) — called once by the main window boot: brings the manifest's other slot windows back
// under the same labels (each window restores its own snapshot). Ghost slots with no snapshot (pre-B1 leftovers,
// manual deletion) are skipped and pruned from the manifest. Spawning steals focus in turn, so focusedLabel is
// focused once at the end to bring the window the user saw last to the front.
export async function respawnSavedWindows(): Promise<void> {
  if (currentWindowLabel() !== "main") return; // respawn has one owner, the main boot (idempotence guard)
  const manifestStore = makeCoreStore<WindowManifest>({
    key: "windows",
    lsKey: "soksak.windows",
    fallback: EMPTY_MANIFEST,
    ...coreStoreDeps,
  });
  // Observation surface of the restore path — the outcome "the window did not open" alone cannot separate an empty
  // ledger, an unread claim, and a missing snapshot. The three are different defects and are fixed in different places.
  const respawnFact = (step: string) =>
    void invoke("activity_publish", {
      kind: "boot.step",
      source: "boot",
      payload: bootFactPayload(step),
    }).catch(() => {});

  try {
    let manifest = await manifestStore.hydrate();
    let pruned = false;
    // Occupancy is a fact of every host, so it is queried from cored — counting this process alone reads a window
    // held by the other framework as "absent" and creates the same label again (restorableSlots header).
    // Without an answer nothing is revived: not opening recovers on the next boot, but a duplicated window stays.
    const live = await liveWindowLabels();
    const slots = restorableSlots(manifest, live);
    respawnFact(
      `respawn:slots:${manifest.slots.length}:live:${live === null ? "unknown" : live.size}:restorable:${slots.length}`,
    );
    for (const slot of slots) {
      const snapStore = makeCoreStore<WindowSnapshot>({
        key: `window/${slot.label}`,
        lsKey: `soksak.window.${slot.label}`,
        fallback: EMPTY_WINDOW,
        ...coreStoreDeps,
      });
      // Absent and empty are separated. Both used to be "0 projects", which pruned windows whose snapshot was not
      // yet written or was erased — those windows never open again (back when there was nowhere to roll back, that
      // was outright loss). The only thing pruned is a window the user emptied.
      const { found, value: snap } = await snapStore.read();
      if (!found) {
        // No snapshot — nothing to revive, so it is not opened. The ledger is left untouched, though:
        // not opening recovers on the next boot, but a pruned slot does not come back.
        respawnFact(`respawn:no-snapshot:${slot.label}`);
        console.warn(`[restore] no snapshot — not opened, ledger entry kept: ${slot.label}`);
        continue;
      }
      if (snap.projects.length === 0) {
        manifest = upsertManifest(manifest, { ...slot, roots: [] }); // slot removal
        pruned = true;
        respawnFact(`respawn:ghost:${slot.label}`);
        console.warn(`[restore] pruned an empty window slot (emptied by the user): ${slot.label}`);
        continue;
      }
      // Window label invariant (NAMING 4b) — a runtime window is w-<uuid> only. Any other label is outside capability,
      // so spawning it produces a deaf window (every command TIMEOUT). Refuse the spawn and leave the data alone
      // — old-generation data is corrected by a one-shot migration (scripts/migrations/20260704-window-label-uuid.sh).
      if (!slot.label.startsWith("w-")) {
        console.error(
          `[restore] refused to spawn an old-generation label slot: ${slot.label} — ` +
            `run scripts/migrations/20260704-window-label-uuid.sh (NAMING 4b)`,
        );
        continue;
      }
      await invoke("window_create", {
        label: slot.label,
        rect: slot.rect ?? null,
        // Background restore — focus is not taken. Opening the orchestrator keeps focus on the orchestrator, and
        // restored workspace windows come back behind it (no arbitrary focus moves, natural behavior).
        focus: false,
      })
        .then(() => respawnFact(`respawn:spawned:${slot.label}`))
        .catch((e) => {
          respawnFact(`respawn:failed:${slot.label}:${String(e).slice(0, 80)}`);
          console.error(`window respawn failed (${slot.label}):`, e);
        });
    }
    if (pruned) await manifestStore.save(manifest);
    // Restore does not move focus — the logic that forced a jump to the previously focused window is removed. The
    // window active at boot (the orchestrator etc.) stays active. The user calls a window with the focus icon in the window list.
    // First run (0 workspace slots to respawn + 0 recent projects) — opens one default project workspace window.
    // When the user closed every window (recents present), that is respected and nothing is opened.
    const hasSlots = manifest.slots.some((s) => s.label !== "main");
    if (!hasSlots) {
      const recents = await listRecentProjects().catch(() => []);
      if (recents.length === 0) {
        try {
          const root = await ensureDefaultProjectRoot("project1");
          await invoke("window_create", { init: `root=${encodeURIComponent(root)}` });
        } catch (e) {
          console.error("first-run default workspace creation failed:", e);
        }
      }
    }
  } catch (e) {
    respawnFact(`respawn:error:${String(e).slice(0, 100)}`);
    console.error("multi-window respawn failed:", e);
  }
}

/**
 * Window labels alive right now — across every host. null when unreadable.
 *
 * This process's own window list is not an answer: a window held by the other framework is invisible, and an
 * invisible window reads as "absent", so the same label is created twice. cored has every attached host and
 * answers, per label, how many hosts hold that label.
 *
 * A failure is not flattened into an empty set — an empty set means "nobody holds any", which revives everything.
 */
async function liveWindowLabels(): Promise<Set<string> | null> {
  try {
    const r = await invoke<{ windows?: { label?: string }[] }>("window_census");
    const rows = r?.windows;
    if (!Array.isArray(rows)) return null;
    return new Set(rows.map((w) => w?.label).filter((l): l is string => typeof l === "string"));
  } catch (e) {
    console.error("window census failed — skipping the restore:", e);
    return null;
  }
}

/**
 * Removes a window from the ledger — called by the `window.close` command.
 *
 * If close removes only the window and not the ledger entry, the next boot revives that window. Not called on the
 * exit path: exit also closes every window, but emptying the ledger then opens nothing on the next run.
 */
export async function forgetWindowSlot(label: string): Promise<void> {
  const manifestStore = makeCoreStore<WindowManifest>({
    key: "windows",
    lsKey: "soksak.windows",
    fallback: EMPTY_MANIFEST,
    ...coreStoreDeps,
  });
  try {
    const manifest = await manifestStore.hydrate();
    const next = forgetWindow(manifest, label);
    if (next !== manifest) await manifestStore.save(next);
  } catch (e) {
    console.error(`window slot pruning failed (${label}):`, e);
  }
}

// Control plane (main) frame persistence — its own key, separate from the workspace manifest. main has no
// workspace snapshot (orchestrator only), so only the frame is kept. Move/resize saves are debounced.
//
// The key includes the framework (frameworkScopedKey) — shared, the two frameworks' control plane windows open
// stacked on the same spot. The old key (no framework) is read by the first boot and moved to its own key.
export async function initControlPlaneFrame(): Promise<void> {
  type Frame = { x: number; y: number; w: number; h: number } | null;
  const key = frameworkScopedKey("controlPlaneFrame", frameworkName);
  const store = makeCoreStore<Frame>({
    key,
    lsKey: `soksak.${key}`,
    fallback: null,
    ...coreStoreDeps,
  });
  const legacyStore = makeCoreStore<Frame>({
    key: "controlPlaneFrame",
    lsKey: "soksak.controlPlaneFrame",
    fallback: null,
    ...coreStoreDeps,
  });
  try {
    // Adopt the old key when this one is empty — this change alone does not reset the window position.
    const rect = (await store.hydrate()) ?? (await legacyStore.hydrate().catch(() => null));
    if (rect) {
      const win = currentWindow();
      await win.setPosition(rect.x, rect.y).catch(() => {});
      await win.setSize(rect.w, rect.h).catch(() => {});
    }
  } catch (e) {
    console.error("control plane frame restore failed:", e);
  }
  const persist = debounce(() => {
    void currentFrame().then((f) => f && store.save(f));
  }, 400);
  void currentWindow().onMoved(persist);
  void currentWindow().onResized(persist);
}
