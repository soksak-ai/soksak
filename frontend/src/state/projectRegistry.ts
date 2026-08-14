// Front-end gate for global single open (P6) — the core registry (project_registry.rs, core
// singleton) is the single truth of enforcement, and this module is the only path shared by every
// open/close route (single-truth util rule: no call site redefines claim logic).
//
// Rule (P6): one root is open in at most one place across all windows. On conflict, focus the owning
// window instead of opening again. Re-claim from the same window is idempotent (restore and retry
// safe). The core releases the claim when a window is destroyed.

import { useEffect, useState } from "react";
import { invoke } from "../framework";
import { safeListen } from "../lib/safeListen";
import { currentWindowLabel } from "../lib/webviewLabels";
import { recordRecentProject } from "./recentProjects";
import { useSessions, type NewProjectOpts } from "./sessions";

interface ClaimReply {
  ok: boolean;
  ownedBy?: string;
}

/** Try to claim a root — {ok:true} | {ok:false, ownedBy}. Failure is a value, not an exception (for branching). */
export async function claimProject(root: string): Promise<ClaimReply> {
  try {
    return (await invoke<ClaimReply>("project_claim", { root })) ?? { ok: false };
  } catch (e) {
    // An unavailable registry (non-tauri tests etc.) must not block opening — keep the old behavior when enforcement is impossible.
    console.warn("project_claim failed (registry unavailable):", e);
    return { ok: true };
  }
}

/** Release a root claim (effective only when this window owns it). Shared by every close route. */
export async function releaseProject(root: string): Promise<void> {
  await invoke("project_release", { root }).catch(() => {});
}

/** Open a project through the P6 gate — the shared entry point for every open route (command, modal, boot).
 *  If another window owns the root, focus that window and report { existingWindow } (no new window or tab). */
export async function addProjectClaimed(
  opts: NewProjectOpts,
): Promise<
  | { ok: true; existingWindow: string }
  | { ok: true; routedWindow: string }
  | ReturnType<ReturnType<typeof useSessions.getState>["addProject"]>
> {
  // Control-plane (main = orchestrator) routing — the control plane loads no plugins or programs, so
  // a project opened here becomes a half-dead workspace (no terminal, no browser). An open from the
  // control plane is routed to a dedicated workspace window instead of refused: release the leftover
  // claim main already holds, then spawn a new window. If another window owns the root, keep the
  // existing P6 behavior (focus that window).
  if (currentWindowLabel() === "main") {
    const c = await claimProject(opts.root);
    if (!c.ok && c.ownedBy && c.ownedBy !== "main") {
      await invoke("window_focus", { label: c.ownedBy }).catch(() => {});
      return { ok: true as const, existingWindow: c.ownedBy };
    }
    const held = useSessions.getState().projects.find((t) => t.root === opts.root);
    if (held) {
      useSessions.getState().closeTab(held.id);
    }
    await releaseProject(opts.root); // the new window claims the root again under its own label at boot
    const label = await invoke<string>("window_create", {
      init: `root=${encodeURIComponent(opts.root)}`,
    });
    void recordRecentProject(opts.root, opts.alias);
    return { ok: true as const, routedWindow: label };
  }
  const c = await claimProject(opts.root);
  if (!c.ok && c.ownedBy) {
    await invoke("window_focus", { label: c.ownedBy }).catch(() => {});
    return { ok: true as const, existingWindow: c.ownedBy };
  }
  const r = useSessions.getState().addProject(opts);
  if (r.ok) void recordRecentProject(opts.root, opts.alias);
  return r;
}

/** Close a project and release its claim — the shared entry point for close routes (command, UI tab close).
 *  Release only on a successful close (on failure, such as refusing the last project, keeping the claim is correct). */
export async function closeProjectReleased(projectId: string) {
  const s = useSessions.getState();
  const root = s.projects.find((t) => t.id === projectId)?.root;
  const r = s.closeTab(projectId);
  if (r.ok && root) await releaseProject(root);
  return r;
}

/** Restore/boot route: claim every root in this window's snapshot at once. Returns the set of roots
 *  whose claim failed (owned by another window) — the caller (windowBoot) drops those tabs from this
 *  window (graceful degradation, no duplicate windows). */
export async function claimRoots(roots: string[]): Promise<Set<string>> {
  const denied = new Set<string>();
  for (const root of roots) {
    const c = await claimProject(root);
    if (!c.ok) denied.add(root);
  }
  return denied;
}

/** Projects open in other windows (global registry view) — consumed by the rail so no window shows
 *  only its own: every window lists every project, and a click focuses the owning window (P6 — move
 *  instead of opening twice). Reactive: project-registry-change broadcast (core singleton emit —
 *  multi-window cross-state rule). */
export function useOtherWindowProjects(): { root: string; window: string }[] {
  const [others, setOthers] = useState<{ root: string; window: string }[]>([]);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const r = await invoke<{ owners: { root: string; window: string }[] }>(
          "project_owners",
        );
        if (disposed) return;
        const me = currentWindowLabel();
        setOthers(r.owners.filter((o) => o.window !== me));
      } catch {
        /* Registry unavailable (test harness etc.) — keep the list empty */
      }
    };
    void refresh();
    const un = safeListen("project-registry-change", refresh);
    return () => {
      disposed = true;
      un();
    };
  }, []);
  return others;
}
