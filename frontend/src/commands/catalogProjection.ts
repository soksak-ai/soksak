// Sidebar projection command surface — ui.projection.*.
//
// `ui.intent.open` stood here until 2026-08-16: it opened a path as a file tab, which was the core's
// second content kind and no plugin ever provided a viewer for it (CORE-CENSUS 1). Opening a thing
// by naming it is the work of whichever plugin claims that kind of thing.
// Registered at the end of registerCatalog() (catalog split — catalogUi precedent).

import { tmsg } from "../i18n";
import { register } from "./registry";
import { err, ok, projectIdOfView, useSessions } from "../state/sessions";
import { useProjection } from "../state/projection";
import { projectionFor } from "../state/projectionWiring";

const SIDES = ["left", "right"] as const;
type Side = (typeof SIDES)[number];

import type { CommandContext } from "./registry";

// Target workspace: explicit param > the calling tab's workspace (ctx) > active workspace.
function targetWorkspace(p: Record<string, unknown>, ctx?: CommandContext): string {
  return (
    (p.workspace as string | undefined) ??
    (ctx?.pane ? projectIdOfView(ctx.pane) ?? undefined : undefined) ??
    useSessions.getState().activeId
  );
}

function pinsOf(projectId: string) {
  return (
    useProjection.getState().byWorkspace[projectId]?.pins ?? { left: [], right: [] }
  );
}

export function registerProjectionCatalog(): void {
  register("ui.projection.state", {
    description:
      "Read the sidebar projection state of a workspace: the bound content view (binding follows the session active chain — switching the active tab inside a group changes the binding too), resolved left/right rail slots with instanceKey and status (live|degraded|satisfied-by-pin), and pinned refs.",
    triggers: { ko: "투영상태 결부 사이드바상태 레일상태 projection binding rail" },
    params: {
      workspace: {
        type: "string",
        description: tmsg("cmd.param.workspace"),
      },
    },
    returns:
      "{ projectId, binding: {tabId|null}, left: {slots:[{source,resolvedRef,instance,instanceKey,status}], template}, right|null, pins: {left,right} }",
    message: (d) =>
      tmsg("msg.ui.projection.state", {
        view: String((d.binding as { tabId?: string | null })?.tabId ?? "-"),
      }),
    examples: ["ui.projection.state", 'ui.projection.state \'{"workspace":"t1"}\''],
    handler: (p, ctx) => {
      const pid = targetWorkspace(p, ctx);
      const proj = projectionFor(pid);
      if (!proj) return err("TARGET_NOT_FOUND", tmsg("msg.workspace.notFoundId", { id: pid }));
      const focusHistory =
        useProjection.getState().byWorkspace[pid]?.focusHistory ?? [];
      return ok({ projectId: pid, ...proj, focusHistory });
    },
  });

  register("ui.projection.pin", {
    description:
      "Reserved. The left rail is projection-only — it renders the bound content view's declared sidebar and nothing user-pinned, so left pins are always rejected. Right-side pinning is the reserved plugin surface and stays rejected until the right pin stack renderer ships. Use unpin to clean stale pins from old snapshots.",
    triggers: { ko: "핀 고정 레일핀 pin rail" },
    params: {
      ref: {
        type: "string",
        description: 'Rail view ref "<pluginId>.<viewId>"',
        required: true,
      },
      side: { type: "string", description: '"left" (default) | "right"' },
      workspace: {
        type: "string",
        description: tmsg("cmd.param.workspace"),
      },
    },
    returns: "{ projectId, pins: {left, right} }",
    message: () => tmsg("msg.ui.projection.pin"),
    examples: ['ui.projection.pin \'{"ref":"<pluginId>.<viewId>"}\''],
    handler: (p, ctx) => {
      const pid = targetWorkspace(p, ctx);
      if (!useSessions.getState().workspaces.some((t) => t.id === pid)) {
        return err("TARGET_NOT_FOUND", tmsg("msg.workspace.notFoundId", { id: pid }));
      }
      const side = ((p.side as string | undefined) ?? "left") as Side;
      if (!SIDES.includes(side)) {
        return err("INVALID_PARAMS", tmsg("msg.ui.projection.sideInvalid"));
      }
      // The left rail is projection-only for the bound feature (2026-07-22 decision) — there is no user pin axis.
      // Resident (plugin-owned) surfaces remain the right rail's share only.
      if (side === "left") {
        return err("INVALID_PARAMS", tmsg("msg.ui.projection.pin.leftProjectionOnly"));
      }
      // [temporary] No right pin stack renderer yet — rejected to prevent absorbing a pin with no render (view loss).
      // Removal condition: open this the moment the unit that renders the pins.right stack in PluginSidebar merges.
      return err("INVALID_PARAMS", tmsg("msg.ui.projection.pin.rightUnsupported"));
    },
  });

  register("ui.projection.unpin", {
    description:
      "Remove a pinned ref from a rail side. Idempotent — unpinning an absent ref succeeds. No rail-registration check: a ref must stay removable after its plugin is gone.",
    triggers: { ko: "핀해제 언핀 unpin" },
    params: {
      ref: { type: "string", description: "Pinned ref", required: true },
      side: { type: "string", description: '"left" (default) | "right"' },
      workspace: {
        type: "string",
        description: tmsg("cmd.param.workspace"),
      },
    },
    returns: "{ projectId, pins: {left, right} }",
    message: () => tmsg("msg.ui.projection.unpin"),
    examples: ['ui.projection.unpin \'{"ref":"<pluginId>.<viewId>"}\''],
    handler: (p, ctx) => {
      const pid = targetWorkspace(p, ctx);
      if (!useSessions.getState().workspaces.some((t) => t.id === pid)) {
        return err("TARGET_NOT_FOUND", tmsg("msg.workspace.notFoundId", { id: pid }));
      }
      const side = ((p.side as string | undefined) ?? "left") as Side;
      if (!SIDES.includes(side)) {
        return err("INVALID_PARAMS", tmsg("msg.ui.projection.sideInvalid"));
      }
      useProjection.getState().unpin(pid, side, p.ref as string);
      return ok({ projectId: pid, pins: pinsOf(pid) });
    },
  });

}
