// One digest of what a window holds, so a restore is judged by comparing two numbers.
//
// state.tree, layout.arrangement and surface.composition each answer part of it. Comparing three
// answers by hand across a restart puts the rule in whoever is comparing, and two people comparing
// the same restart can disagree about it.
//
// Two digests, because there are two questions.
//
// `digest` is what the layout *is*: rectangles, the active pane, the rail, ordered by root. It
// holds no identifier — a root is the workspace's identity (P4), and two windows holding different
// roots are not the same window however alike their panes are.
//
// `ids` is who they are. Every identifier survives a restart (NAMING N2a, RESTORE R3), so the
// names are as comparable as the shape, and they answer something the shape cannot: a terminal
// session is keyed by `windowLabel + "|" + paneId`, so a pane that came back under a new name has
// lost its shell while every rectangle is exactly where it was.
//
// Measured 2026-08-16: a change that renamed every identifier on restore matched `digest` exactly
// — it never held one — and broke that key. The one number a restore was judged by could not see
// the defect, and the gate built on it passed. Answering both, side by side and never mixed, is
// EVIDENCE E6: a reading names the claim it does not make rather than leaving the gap silent.

/** One pane, as the comparison sees it. */
export interface FingerprintPane {
  rect: { left: number; top: number; width: number; height: number };
  active: boolean;
}

export interface FingerprintSpace {
  panes: FingerprintPane[];
}

export interface FingerprintWorkspace {
  root: string;
  mode: string;
  station: number;
  cleanLines: number[];
  spaces: FingerprintSpace[];
}

export interface StateFingerprint {
  /** The shape: what a person sees. */
  digest: string;
  /** The identifiers: what things are. Separate, because a caller told only that "something moved"
   *  has to find out which of the two it was. */
  ids: string;
  workspaces: FingerprintWorkspace[];
}

type Rect = { left: number; top: number; width: number; height: number };

function rectOf(value: unknown): Rect {
  const r = (value ?? {}) as Partial<Rect>;
  // Rounded to the ninth place. Two runs of the same solve differ in the last bits of a double, and
  // a digest that counted those would never match twice.
  const round = (n: unknown) => Math.round((typeof n === "number" ? n : 0) * 1e9) / 1e9;
  return { left: round(r.left), top: round(r.top), width: round(r.width), height: round(r.height) };
}

/** Builds the fingerprint from a state.tree answer. */
export function fingerprintOf(tree: unknown): StateFingerprint {
  const source = (tree ?? {}) as { workspaces?: unknown[] };
  const workspaces: FingerprintWorkspace[] = (source.workspaces ?? []).map((raw) => {
    const workspace = (raw ?? {}) as Record<string, unknown>;
    const rail = (workspace.leftRailPosition ?? {}) as Record<string, unknown>;
    const spaces = ((workspace.spaces ?? []) as unknown[]).map((rawSpace) => {
      const space = (rawSpace ?? {}) as Record<string, unknown>;
      const active = space.activePaneId;
      const panes = ((space.panes ?? []) as unknown[]).map((rawPane) => {
        const pane = (rawPane ?? {}) as Record<string, unknown>;
        return { rect: rectOf(pane.rect), active: pane.id === active };
      });
      return { panes };
    });
    return {
      root: typeof workspace.root === "string" ? workspace.root : "",
      mode: typeof rail.mode === "string" ? rail.mode : "",
      station: typeof rail.effectiveStation === "number" ? rail.effectiveStation : 0,
      cleanLines: Array.isArray(rail.cleanLines) ? (rail.cleanLines as number[]).slice() : [],
      spaces,
    };
  });
  // Ordered by root, because a window that restored the same workspaces in another order holds the
  // same layout and a caller comparing two digests should not be told otherwise.
  workspaces.sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
  return {
    digest: digestOf(JSON.stringify(workspaces)),
    ids: digestOf(identifiersOf(source).join("\n")),
    workspaces,
  };
}

/** Every identifier the window holds, sorted.
 *
 *  Sorted, so restoring the same things in another order is not reported as a renaming — the same
 *  reason the shape is ordered by root. The set is what matters, not the order of the names.
 *
 *  Read by key, not by walking a shape declared here. A reading taught the tree answers nothing for
 *  a kind of node added later, and answering nothing is how a renaming goes unseen. */
function identifiersOf(tree: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "id" && typeof value === "string" && value !== "") found.add(value);
      walk(value);
    }
  };
  walk(tree);
  return [...found].sort();
}

// FNV-1a over the canonical text. Short, stable across processes, and dependency-free — this is a
// comparison of two of our own answers, not a security boundary.
function digestOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
