import { checkState } from "split-pane";
import type { WindowSnapshot } from "./windowPersistence";

export type SnapshotVerdict =
  | { ok: true; snapshot: WindowSnapshot }
  | { ok: false; why: string };

export function readableWindowSnapshot(value: unknown): SnapshotVerdict {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, why: "a window snapshot must be an object" };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.activeId !== "string") return { ok: false, why: "a window snapshot requires activeId" };
  if (!Array.isArray(record.workspaces)) return { ok: false, why: "a window snapshot requires workspaces" };
  for (const [workspaceIndex, rawWorkspace] of record.workspaces.entries()) {
    if (rawWorkspace === null || typeof rawWorkspace !== "object") return { ok: false, why: `workspace[${workspaceIndex}] must be an object` };
    const workspace = rawWorkspace as Record<string, unknown>;
    if (!Array.isArray(workspace.contents)) return { ok: false, why: `workspace[${workspaceIndex}] requires contents` };
    for (const [contentIndex, rawContent] of workspace.contents.entries()) {
      if (rawContent === null || typeof rawContent !== "object") return { ok: false, why: `workspace[${workspaceIndex}].contents[${contentIndex}] must be an object` };
      try { checkState((rawContent as Record<string, unknown>).layout as never); }
      catch (error) { return { ok: false, why: `content layout is invalid: ${String(error)}` }; }
    }
    if (workspace.sidebarLayouts === null || typeof workspace.sidebarLayouts !== "object") return { ok: false, why: "workspace requires sidebarLayouts" };
    for (const [region, layout] of Object.entries(workspace.sidebarLayouts)) {
      try { checkState(layout as never); }
      catch (error) { return { ok: false, why: `sidebar layout ${region} is invalid: ${String(error)}` }; }
    }
  }
  return { ok: true, snapshot: value as WindowSnapshot };
}
