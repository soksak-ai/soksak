// Project root constitution — the single truth shared by the new-project modal, the
// project.create command, and boot:
//   P1 Root required: every project has a root directory (enforced by the type —
//      Project.root: string). A project without a root cannot exist.
//   P2 Forbidden roots: home (~) and the filesystem root (/) cannot be a project root — the
//      root initialization policy plugin (git init and such, once per project.created) acts
//      on the whole root. Subdirectories are free.
//   P3 Automatic root: with no folder given, create and use ~/.soksak/projects/<folder> (a
//      folder the app made is app-managed). The first project at boot is projects/project1.
//   P4 Identity = root path: no persistent id field (no duplication). In automatic mode the
//      input is only the "folder name" (slug) to create and is not stored. Alias = display
//      name (falls back to the folder name when empty).
//   P5 No duplicates: two projects cannot share a root (compared normalized) — a duplicate
//      create activates the existing project and returns existing. (Window-local guard.)
//   P6 Global single open: one root is open in at most one place across all windows — the
//      global enforcement of P4 (identity = root). The core registry
//      (project_registry.rs, core singleton) is the single truth of the enforcement point,
//      and every open/close route goes through the projectRegistry.ts util. On conflict,
//      focus the owning window instead of opening again. The core releases the claim when a
//      window is destroyed.

import { invoke } from "../framework";

export const FOLDER_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

// Creates ~/.soksak/projects/<folder> (idempotent) and returns the absolute path. The core re-validates.
export function ensureDefaultProjectRoot(folder: string): Promise<string> {
  return invoke<string>("ensure_project_dir", { folder });
}

// Validates P1/P2 and returns the normalized path (the basis of the P5 duplicate comparison). Rejects with the reason on violation.
export function validateProjectRoot(path: string): Promise<string> {
  return invoke<string>("validate_project_root", { path });
}
