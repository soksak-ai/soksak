// One digest of what a window holds, so a restore is judged by comparing two numbers.
//
// state.tree, layout.arrangement and surface.composition each answer part of it. Comparing three
// answers by hand across a restart puts the rule in whoever is comparing, and two people comparing
// the same restart can disagree about it.
//
// The digest is of what the layout *is*, never of the ids it happens to hold. A restore regenerates
// split ids by contract (A2), so a fingerprint that counted them could never match across the one
// event it exists to judge. A root is not an id — it is the workspace's identity (P4), and two
// windows holding different roots are not the same window however alike their panes are.

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
  digest: string;
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
  return { digest: digestOf(JSON.stringify(workspaces)), workspaces };
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
