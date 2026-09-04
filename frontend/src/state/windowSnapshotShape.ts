import type { WindowSnapshot } from "./windowPersistence";

// Whether a stored window snapshot is one this build can read.
//
// Measured 2026-08-16 after a cold restart: nothing came back. Every snapshot was in the store and
// the ledger held 23 restorable slots, and the boot facts read
//   respawn:slots:23:live:1:restorable:23
//   respawn:error:TypeError: undefined is not an object (evaluating 'a.workspaces.length')
//
// Two of those snapshots were written before the project → workspace rename and carry `projects`
// where this build reads `workspaces`. Reading `.length` on the missing field threw, the throw left
// the loop, and all twenty-three windows stayed closed — including the twenty-one this build had
// written itself.
//
// One unreadable record costs that record only, and the reason goes in the boot facts. No
// migration is
// written: this build does not carry old paths (L11c), and a record it cannot read is left where it
// is rather than rewritten into a shape its author never meant.

export type SnapshotVerdict =
  | { ok: true; snapshot: WindowSnapshot }
  | { ok: false; why: string };

export function readableWindowSnapshot(value: unknown): SnapshotVerdict {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, why: `a window snapshot is an object, and this is ${describe(value)}` };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.activeId !== "string") {
    // Workspaces with none selected is a window with panes and nothing shown, which reads as a
    // blank screen with content behind it.
    return { ok: false, why: "a window snapshot names its active workspace in activeId, and this has none" };
  }
  if (!Array.isArray(record.workspaces)) {
    return {
      ok: false,
      why: `a window snapshot lists its workspaces in workspaces, and this has ${
        Array.isArray(record.projects) ? "projects — it predates the rename" : "none"
      }`,
    };
  }
  const nameless = splitWithNoID(record.workspaces);
  if (nameless) {
    return { ok: false, why: nameless };
  }
  return { ok: true, snapshot: { activeId: record.activeId, workspaces: record.workspaces as WindowSnapshot["workspaces"] } };
}

// Every id survives a restart (NAMING N2a), with no exception. The split node's went into the
// snapshot on 2026-08-16, and a record written before that has none.
//
// It is refused rather than mended. A fallback that minted the name would be an old path carried
// forward, and it would make a restore rename part of itself in silence — the shape that cost a
// day that same date. One unreadable record costs that record only (R1) and its ledger slot stays,
// so the window is reported by name on every boot until it is written again.
function splitWithNoID(workspaces: unknown[]): string | null {
  let found: string | null = null;
  const walk = (node: unknown, where: string): void => {
    if (found || node === null || typeof node !== "object") return;
    const branch = node as Record<string, unknown>;
    if (branch.t === "s") {
      if (typeof branch.id !== "string" || branch.id === "") {
        found = `a split node in ${where} carries no id, so this record predates 2026-08-16`;
        return;
      }
      for (const child of (branch.children as unknown[]) ?? []) walk(child, where);
    }
  };
  for (const workspace of workspaces) {
    if (workspace === null || typeof workspace !== "object") continue;
    const held = workspace as Record<string, unknown>;
    const name = typeof held.id === "string" ? held.id : "a workspace";
    for (const space of (held.contents as unknown[]) ?? []) {
      if (space === null || typeof space !== "object") continue;
      walk((space as Record<string, unknown>).layout, name);
    }
    const layouts = (held.sidebarLayouts as Record<string, unknown>) ?? {};
    for (const layout of Object.values(layouts)) walk(layout, name);
  }
  return found;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}
