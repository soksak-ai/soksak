// Sidebar projection core (plans/sidebar-projection-spec.md §4·R1~R7).
// Pane focus determines the rail position only. Space owns the projection content binding:
//   - Store: focusHistory (succession material) and pins.
//     Keyed per workspace (R7: scope = window × workspace).
//   - Resolution: resolveProjection, a pure derivation — sidebar declaration of the bound view
//     → rail slot.
// Wiring (the real deps: viewRegistry, contractResolve, plugins) is injected at the consumption
// point — this module never reads the registry directly (testable, zero tight coupling).

import { moduleState } from "../lib/moduleState";
import { create } from "zustand";
import type { ContributedSidebar, SidebarInstance, SidebarSlot } from "../plugins/spec";

export type SlotStatus = "live" | "degraded" | "satisfied-by-pin";

export interface ProjectionSlot {
  // Declaration form: "self:<owner>.<viewId>" | "contract:<contract id>" | "undeclared" (no declaration).
  source: string;
  resolvedRef: string | null; // "<pluginId>.<viewId>" — may be null when degraded
  instance: SidebarInstance;
  // Instance identity (A9): shared=(workspace|ref), per-view=(workspace|ref|viewId). degraded=null.
  instanceKey: string | null;
  status: SlotStatus;
}

export interface ProjectionSide {
  slots: ProjectionSlot[];
  // Core-owned template vocabulary (A5). 1 slot or fewer = single, 2 or more = declared template.
  template: "single" | "stack" | "tabs";
}

// Declaration summary of the bound view — the consumption point builds it from the session Tab.
// plugin view: ownerPluginId = that plugin. file view: the plugin of the responsible fileViewer (§3.1).
export interface BoundView {
  viewId: string;
  // Binding context (§4.1) — the group and space of the bound view. Blast radius of the implicit UI path (A6).
  groupId: string | null;
  contentId: string | null;
  ownerPluginId: string;
  sidebar: ContributedSidebar | null; // null = no declaration → left side degraded (R5)
}

export interface ProjectionDeps {
  // Is the global view key registered with rail placement — the verdict for resolution failure (unregistered, inactive, not rail).
  isRailView(key: string): boolean;
  // The owner plugin's consumed contract ids — the contract-pin gate (§3.2).
}

export interface Pins {
  left: string[];
  right: string[];
}

export interface Projection {
  binding: {
    viewId: string | null;
    groupId: string | null;
    contentId: string | null;
  };
  left: ProjectionSide;
  right: ProjectionSide | null; // right undeclared = null (A1 — the right side is optional)
  pins: Pins;
}

const NULL_BINDING = { viewId: null, groupId: null, contentId: null };

const EMPTY_SIDE: ProjectionSide = { slots: [], template: "single" };

function resolveSlot(
  projectId: string,
  boundViewId: string,
  owner: string,
  slot: SidebarSlot,
  pinned: string[],
  deps: ProjectionDeps,
): ProjectionSlot {
  let source: string;
  let resolvedRef: string | null = null;
  let live = false;

  if (slot.ref !== undefined) {
    const viewId = slot.ref.slice("self.".length);
    resolvedRef = `${owner}.${viewId}`;
    source = `self:${resolvedRef}`;
    live = deps.isRailView(resolvedRef);
  } else {
    // Another plugin's view, named. A slot held a contract address until 2026-08-16 and resolved an
    // implementation through discovery; the interface id was a second identity for what the plugin
    // id already names (C3, C4), and not one contract ever had both sides.
    const plugin = slot.plugin as string;
    resolvedRef = `${plugin}.${slot.view as string}`;
    source = `plugin:${resolvedRef}`;
    live = deps.isRailView(resolvedRef);
  }

  if (!live) {
    return { source, resolvedRef, instance: slot.instance, instanceKey: null, status: "degraded" };
  }
  const instanceKey =
    slot.instance === "shared"
      ? `${projectId}|${resolvedRef}`
      : `${projectId}|${resolvedRef}|${boundViewId}`;
  // Pin absorption (R4): if a shared slot's ref is already pinned, the pin absorbs the render (single render).
  const status: SlotStatus =
    slot.instance === "shared" && pinned.includes(resolvedRef as string)
      ? "satisfied-by-pin"
      : "live";
  return { source, resolvedRef, instance: slot.instance, instanceKey, status };
}

function resolveSide(
  projectId: string,
  boundViewId: string,
  owner: string,
  slots: SidebarSlot[],
  template: "stack" | "tabs",
  pinned: string[],
  deps: ProjectionDeps,
): ProjectionSide {
  const resolved = slots.map((s) =>
    resolveSlot(projectId, boundViewId, owner, s, pinned, deps),
  );
  return { slots: resolved, template: resolved.length >= 2 ? template : "single" };
}

// Bound view → rail projection (pure). A null binding = empty left slots + right null (pins only, R6).
export function resolveProjection(
  projectId: string,
  bound: BoundView | null,
  pins: Pins,
  deps: ProjectionDeps,
): Projection {
  if (!bound) {
    return { binding: NULL_BINDING, left: EMPTY_SIDE, right: null, pins };
  }
  if (!bound.sidebar) {
    // No declaration = degraded slot (R5) — an empty slot plus a place to render guidance.
    return {
      binding: { viewId: bound.viewId, groupId: bound.groupId, contentId: bound.contentId },
      left: {
        slots: [
          {
            source: "undeclared",
            resolvedRef: null,
            instance: "shared",
            instanceKey: null,
            status: "degraded",
          },
        ],
        template: "single",
      },
      right: null,
      pins,
    };
  }
  const { sidebar, ownerPluginId, viewId, groupId, contentId } = bound;
  const left = resolveSide(
    projectId, viewId, ownerPluginId, sidebar.left, sidebar.template, pins.left, deps,
  );
  const right =
    sidebar.right.length === 0
      ? null
      : resolveSide(
          projectId, viewId, ownerPluginId, sidebar.right, sidebar.template, pins.right, deps,
        );
  return { binding: { viewId, groupId, contentId }, left, right, pins };
}

// ── Store — user-owned state only (focusHistory, pins). Resolution results are derived, never stored. ──

const HISTORY_CAP = 50;

interface WorkspaceEntry {
  focusHistory: string[]; // Most recent first. Session local (§4.5 — not restored)
  pins: Pins; // Persisted with the workspace (§4.5)
}

interface ProjectionStore {
  byWorkspace: Record<string, WorkspaceEntry>;
  // Record a binding observation — the consumption point calls this on every active-chain change (most-recent-first dedupe).
  noteBinding(projectId: string, viewId: string): void;
  // View closed — removed from the succession material (R6).
  forgetView(projectId: string, viewId: string): void;
  // Pin (R4) — idempotent. Pinnability validation (rail view exists, shared/resident) is owned by the command layer.
  pin(projectId: string, side: "left" | "right", ref: string): void;
  unpin(projectId: string, side: "left" | "right", ref: string): void;
  // Restore seeding (§4.5·R9) — a snapshot's pins are planted only when absent (never clobber live state).
  seedWorkspace(projectId: string, entry: { pins: Pins }): void;
  // Workspace closed — state reclaimed.
  dropWorkspace(projectId: string): void;
}

const emptyEntry = (): WorkspaceEntry => ({
  focusHistory: [],
  pins: { left: [], right: [] },
});

function withPin(entry: WorkspaceEntry, side: "left" | "right", ref: string): WorkspaceEntry {
  if (entry.pins[side].includes(ref)) return entry;
  return {
    ...entry,
    pins: { ...entry.pins, [side]: [...entry.pins[side], ref] },
  };
}

// The store is outside the module boundary — if hot-swapping replaces it, registrations,
// subscriptions and screen state all become new, while the filling side treats them as already
// filled and never refills (empty forever).
export const useProjection = moduleState("state/projection#store", () =>
  create<ProjectionStore>((set) => ({
  byWorkspace: {},

  noteBinding: (projectId, viewId) =>
    set((s) => {
      const entry = s.byWorkspace[projectId] ?? emptyEntry();
      if (entry.focusHistory[0] === viewId) return s;
      const focusHistory = [
        viewId,
        ...entry.focusHistory.filter((v) => v !== viewId),
      ].slice(0, HISTORY_CAP);
      return {
        byWorkspace: { ...s.byWorkspace, [projectId]: { ...entry, focusHistory } },
      };
    }),

  forgetView: (projectId, viewId) =>
    set((s) => {
      const entry = s.byWorkspace[projectId];
      if (!entry || !entry.focusHistory.includes(viewId)) return s;
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [projectId]: {
            ...entry,
            focusHistory: entry.focusHistory.filter((v) => v !== viewId),
          },
        },
      };
    }),

  pin: (projectId, side, ref) =>
    set((s) => {
      const entry = s.byWorkspace[projectId] ?? emptyEntry();
      const next = withPin(entry, side, ref);
      if (next === entry && s.byWorkspace[projectId]) return s; // Idempotent.
      return { byWorkspace: { ...s.byWorkspace, [projectId]: next } };
    }),

  unpin: (projectId, side, ref) =>
    set((s) => {
      const entry = s.byWorkspace[projectId];
      if (!entry || !entry.pins[side].includes(ref)) return s; // Idempotent.
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [projectId]: {
            ...entry,
            pins: { ...entry.pins, [side]: entry.pins[side].filter((r) => r !== ref) },
          },
        },
      };
    }),

  seedWorkspace: (projectId, entry) =>
    set((s) => {
      if (s.byWorkspace[projectId]) return s; // Live state wins — restore only seeds the first time.
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [projectId]: {
            focusHistory: [],
            pins: { left: [...entry.pins.left], right: [...entry.pins.right] },
          },
        },
      };
    }),

  dropWorkspace: (projectId) =>
    set((s) => {
      if (!s.byWorkspace[projectId]) return s;
      const byWorkspace = { ...s.byWorkspace };
      delete byWorkspace[projectId];
      return { byWorkspace };
    }),
})),
);
