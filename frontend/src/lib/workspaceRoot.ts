// Workspace root constitution — the single truth shared by the new-workspace modal, the
// workspace.create command, and boot:
//   P1 Root required: every workspace has a root directory (enforced by the type —
//      Workspace.root: string). A workspace without a root cannot exist.
//   P2 Forbidden roots: home (~) and the filesystem root (/) cannot be a workspace root — the
//      root initialization policy plugin (git init and such, once per workspace.created) acts
//      on the whole root. Subdirectories are free.
//   P3 Automatic root: with no folder given, create and use ~/.soksak/workspaces/<folder> (a
//      folder the app made is app-managed). The first workspace at boot is workspaces/workspace1.
//   P4 Identity = root path: no persistent id field (no duplication). In automatic mode the
//      input is only the "folder name" (slug) to create and is not stored. Alias = display
//      name (falls back to the folder name when empty).
//   P5 No duplicates: two workspaces cannot share a root (compared normalized) — a duplicate
//      create activates the existing workspace and returns existing. (Window-local guard.)
//   P6 Global single open: one root is open in at most one place across all windows — the
//      global enforcement of P4 (identity = root). The core registry
//      (workspace_registry.rs, core singleton) is the single truth of the enforcement point,
//      and every open/close route goes through the workspaceRegistry.ts util. On conflict,
//      focus the owning window instead of opening again. The core releases the claim when a
//      window is destroyed.

import { invoke } from "../framework";

export const FOLDER_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

// Creates ~/.soksak/workspaces/<folder> (idempotent) and returns the absolute path. The core re-validates.
export function ensureDefaultWorkspaceRoot(folder: string): Promise<string> {
  return invoke<string>("ensure_workspace_dir", { folder });
}

// Validates P1/P2 and returns the normalized path (the basis of the P5 duplicate comparison). Rejects with the reason on violation.
export function validateWorkspaceRoot(path: string): Promise<string> {
  return invoke<string>("validate_workspace_root", { path });
}
