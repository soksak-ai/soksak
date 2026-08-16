// Workspace persistence and restore wiring (A4/A5) — sessions store ↔ coreStore (app.data) ↔
// serialization.
//
// Key model (core ns):
//  - "window/<label>"  : one window's workspace snapshot (workspaces[] + activeId). Atomic per window.
//  - "windows"         : window-manifest (slot → {label, roots[], activeRoot}). Restart restore skeleton.
//
// [RULE] Layout is window-local (window label key). The same root opened in two windows uses two
// keys, so there is no collision — the workspace-unique guard blocks that above for now, but the key
// model already supports multiple windows (decision A).
// Live status/PTY/webview sessions are not serialized (windowSnapshot excludes them).

import {
  serializeWorkspace,
  deserializeWorkspace,
  type WorkspaceSnapshot,
} from "./windowSnapshot";
import type { Workspace } from "./sessions";
import type { Pins } from "./projection";

export type ProjectionSeed = { pins: Pins };

export interface WindowSnapshot {
  activeId: string;
  workspaces: WorkspaceSnapshot[];
}

export interface ManifestEntry {
  label: string;
  roots: string[];
  activeRoot: string | null;
  // Window frame (logical px) — restart respawn creates the window at the same position and size
  // (dual-monitor placement kept).
  rect?: { x: number; y: number; w: number; h: number };
}

export interface WindowManifest {
  slots: ManifestEntry[];
  // The last focused window — brought to the front after restart (without it main is always in
  // front, which is awkward).
  focusedLabel?: string;
}

// The window's current sessions state → a serialized snapshot (per window).
export function snapshotWindow(
  workspaces: Workspace[],
  activeId: string,
  projections?: Record<string, ProjectionSeed>,
): WindowSnapshot {
  return {
    activeId,
    workspaces: workspaces.map((p) => serializeWorkspace(p, projections?.[p.id])),
  };
}

// Snapshot → Workspace[] (split ids are regenerated through the injected newSplitId). The caller
// reseeds after restore.
export function restoreWindow(
  snap: WindowSnapshot,
  newSplitId: () => string,
): {
  workspaces: Workspace[];
  activeId: string;
  projections: Record<string, ProjectionSeed>;
} {
  const workspaces = snap.workspaces.map((p) => deserializeWorkspace(p, newSplitId));
  // Every id is minted again (RESTORE R3), so the stored active name matches nothing in the list.
  // The workspace that was active is found by position — the order is what the round trip
  // preserves — and its new id is the one everything downstream uses. Matching on the stored name
  // would fall through to the first workspace every time, and a person would find the wrong
  // workspace open with nothing reporting it.
  const wasActive = snap.workspaces.findIndex((p) => p.id === snap.activeId);
  const activeId = workspaces[wasActive >= 0 ? wasActive : 0]?.id ?? "";
  // The projection seed is keyed by the id its workspace now holds. Keyed by the stored one it
  // names a workspace that does not exist, and a pinned rail comes back unpinned with no fault
  // anywhere.
  const projections: Record<string, ProjectionSeed> = {};
  snap.workspaces.forEach((p, index) => {
    const restored = workspaces[index];
    if (p.projection && restored) projections[restored.id] = p.projection;
  });
  return { workspaces, activeId, projections };
}

// This window's manifest entry = label + the list of held roots + the active root.
export function windowManifestEntry(
  label: string,
  workspaces: Workspace[],
  activeId: string,
): ManifestEntry {
  return {
    label,
    roots: workspaces.map((t) => t.root),
    activeRoot: workspaces.find((t) => t.id === activeId)?.root ?? null,
  };
}

/** The ledger's slots, or a refusal naming what arrived instead.
 *
 * A ledger that is not one arrives here as a TypeError on `.filter`, which names which
 * property was missing and nothing about where the value came from. Measured 2026-08-15: every
 * boot of this build died on `e.slots.filter is not a function` and three separate readings of the
 * store could not tell which layer had produced the value.
 */
function slotsOf(manifest: WindowManifest, who: string): ManifestEntry[] {
  if (!manifest || !Array.isArray(manifest.slots)) {
    throw new Error(
      `${who}: the window ledger has no slots — received ${JSON.stringify(manifest)?.slice(0, 160)}`,
    );
  }
  return manifest.slots;
}

// Upserts this window's entry into the manifest (replaces the slot with the same label, appends
// when absent). Empty roots removes the slot.
export function upsertManifest(
  manifest: WindowManifest,
  entry: ManifestEntry,
): WindowManifest {
  const others = slotsOf(manifest, "upsertManifest").filter((s) => s.label !== entry.label);
  if (entry.roots.length === 0) return { ...manifest, slots: others };
  return { ...manifest, slots: [...others, entry] };
}

/**
 * Removes a closed window from the ledger — left there, the next boot respawns it.
 *
 * Different from app shutdown. Shutdown also closes every window, but the ledger must stay
 * (otherwise the next run opens nothing). So the call site of this function is not the shutdown
 * path, it is **the close command**.
 *
 * The last-focus record is removed with it. A focus pointing at a window that does not exist is
 * searched for and never found on the next boot.
 */
export function forgetWindow(manifest: WindowManifest, label: string): WindowManifest {
  const slots = slotsOf(manifest, "forgetWindow").filter((s) => s.label !== label);
  if (slots.length === manifest.slots.length && manifest.focusedLabel !== label) return manifest;
  const next: WindowManifest = { ...manifest, slots };
  if (next.focusedLabel === label) delete next.focusedLabel;
  return next;
}

/**
 * Puts the framework into the placement-axis key — for a **single value**.
 *
 * What is stored here is not a user asset but **the window's own position** (the main window's
 * position and size). Sharing it opens the control planes of two frameworks on top of each other.
 * A different axis from the ledger (`windows`) — the ledger is user intent, so splitting it is a
 * loss, while the window's own position must split for each to keep its place.
 *
 * When the axis cannot be read, the old key stands. Creating a new key under an unknown name piles
 * values where nothing reads them — that is neither saved nor unsaved.
 */
export function frameworkScopedKey(base: string, framework: string | null): string {
  return framework ? `${base}/${framework}` : base;
}

/**
 * Slots to respawn — windows in the ledger that **nothing currently holds**.
 *
 * The ledger is user intent ("this workspace must be open"). Writing the name of whoever opened it
 * makes that window the property of that framework, and a user who switches frameworks loses every
 * window. So the dividing axis is not ownership but **occupancy** — a runtime fact, so it is not
 * written into the ledger, and it clears itself when the process dies (the same model as store
 * ownership A22).
 *
 * `live` must be the labels held by **every host**. Counting only this process reads a window held
 * by the other one as absent and creates the same label again — that overlap leaves a window that
 * renders nothing (cored `window_census`).
 *
 * When occupancy cannot be read (`null`), nothing is respawned. Not opening is recovered on the
 * next boot, but an overlapping window stays — the two failures do not weigh the same.
 */
export function restorableSlots(
  manifest: WindowManifest,
  live: ReadonlySet<string> | null,
): ManifestEntry[] {
  if (!live) return [];
  return slotsOf(manifest, "restorableSlots").filter((s) => s.label !== "main" && !live.has(s.label));
}

// Records the last focused window — called on persist when this window has focus (a top-level
// field, independent of the slot upsert).
export function setManifestFocused(
  manifest: WindowManifest,
  label: string,
): WindowManifest {
  return { ...manifest, focusedLabel: label };
}
