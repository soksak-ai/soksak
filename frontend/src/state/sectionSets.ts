import { create } from "zustand";
import { moduleState } from "../lib/moduleState";
import { createCoreSync } from "./coreSync";
import type { CoreStoreDeps } from "./coreStore";
import { issueId } from "./ids";

// Section sets: which sections go together, who gets which set, and which one stands.
//
// A section is a plugin (A2a) — a file tree, a daemon list, bookmarks — and no plugin declares what
// it appears beside. A set is a named, ordered list of sections, and this is where a person puts
// sections together and gives a plugin its set.
//
// A set names no region. Where it stands is settled where placement is settled — the link, or the
// fixed choice — so the same set stands on the left in one arrangement and on the right in another.
// A region on the set would be a second place deciding placement.
//
// It is settings rather than workspace state because the same set is wanted in every workspace; per
// workspace it would be built again for each one. What stays with a workspace is that window's
// arrangement — split, tab, order.

export type Region = "left" | "right";

/** One set. Sections are view keys, `<pluginId>.<viewId>`, in the order they stand. */
export interface SectionSet {
  id: string;
  title: string;
  sections: string[];
}

/** Where a set stands, and which one. */
export interface Standing {
  set: string;
  region: Region;
}

/** individual = the set linked to the focused view\'s plugin stands, and nothing stands when that
 *  plugin has no link. fixed = one set stands, in every workspace, whatever is focused. */
export type SectionMode = "individual" | "fixed";

export interface SectionSetsState {
  sets: SectionSet[];
  /** pluginId → where its set stands. Read in `individual` only. */
  byPlugin: Record<string, Standing>;
  mode: SectionMode;
  /** The one that stands in `fixed`. null = none, and then nothing stands. */
  fixed: Standing | null;

  create: (title: string) => SectionSet;
  rename: (id: string, title: string) => void;
  remove: (id: string) => void;
  arrange: (id: string, sections: string[]) => void;
  link: (pluginId: string, standing: Standing | null) => void;
  setMode: (mode: SectionMode) => void;
  setFixed: (standing: Standing | null) => void;
}

interface Persisted {
  sets: SectionSet[];
  byPlugin: Record<string, Standing>;
  mode: SectionMode;
  fixed: Standing | null;
}

const EMPTY: Persisted = { sets: [], byPlugin: {}, mode: "individual", fixed: null };

const sync = createCoreSync<Persisted>({
  key: "sectionSets",
  lsKey: "soksak.sectionSets",
  fallback: EMPTY,
  apply: (v) => useSectionSets.setState(shapeOf(v)),
});

export const initSectionSetsPersistence = (deps: CoreStoreDeps): (() => void) => sync.init(deps);

const isRegion = (v: unknown): v is Region => v === "left" || v === "right";

function standingOf(raw: unknown, known: Set<string>): Standing | null {
  const v = (raw ?? {}) as Partial<Standing>;
  if (typeof v.set !== "string" || !known.has(v.set) || !isRegion(v.region)) return null;
  return { set: v.set, region: v.region };
}

/** What was read back, as this build reads it. A record from another shape costs that record, not
 *  the whole set (RESTORE R1) — an entry that is not a set is dropped and the rest stands. */
function shapeOf(raw: unknown): Persisted {
  const v = (raw ?? {}) as Partial<Persisted>;
  const sets = Array.isArray(v.sets)
    ? v.sets.filter(
        (s): s is SectionSet =>
          !!s && typeof s.id === "string" && typeof s.title === "string" && Array.isArray(s.sections),
      )
    : [];
  const known = new Set(sets.map((s) => s.id));
  const byPlugin: Record<string, Standing> = {};
  for (const [plugin, standing] of Object.entries(v.byPlugin ?? {})) {
    const kept = standingOf(standing, known);
    if (kept) byPlugin[plugin] = kept;
  }
  return {
    sets,
    byPlugin,
    mode: v.mode === "fixed" ? "fixed" : "individual",
    fixed: standingOf(v.fixed, known),
  };
}

const persistedOf = (s: SectionSetsState): Persisted => ({
  sets: s.sets,
  byPlugin: s.byPlugin,
  mode: s.mode,
  fixed: s.fixed,
});

// The store is held outside the module boundary — a hot swap that replaced it would leave the
// screen subscribed to the old one while the filling side records the fill and never repeats it.
export const useSectionSets = moduleState("state/sectionSets#store", () =>
  create<SectionSetsState>((set, get) => {
    const commit = (next: Partial<SectionSetsState>) => {
      set(next);
      sync.save(persistedOf(get()));
    };
    return {
      ...shapeOf(sync.loadSync()),

      create: (title) => {
        const made: SectionSet = { id: issueId("sectionSet"), title, sections: [] };
        commit({ sets: [...get().sets, made] });
        return made;
      },
      rename: (id, title) =>
        commit({ sets: get().sets.map((s) => (s.id === id ? { ...s, title } : s)) }),
      remove: (id) => {
        // A link to a removed set goes with it. Left behind, it names nothing and its plugin reads
        // as linked while nothing stands.
        const byPlugin = Object.fromEntries(
          Object.entries(get().byPlugin).filter(([, v]) => v.set !== id),
        );
        commit({
          sets: get().sets.filter((s) => s.id !== id),
          byPlugin,
          fixed: get().fixed?.set === id ? null : get().fixed,
        });
      },
      arrange: (id, sections) =>
        commit({ sets: get().sets.map((s) => (s.id === id ? { ...s, sections } : s)) }),
      link: (pluginId, standing) => {
        const byPlugin = { ...get().byPlugin };
        if (standing === null) delete byPlugin[pluginId];
        else byPlugin[pluginId] = standing;
        commit({ byPlugin });
      },
      setMode: (mode) => commit({ mode }),
      setFixed: (standing) => commit({ fixed: standing }),
    };
  }),
);

/** Whether a region is present: the person has it open and a set stands there.
 *
 *  A region open with nothing in it reserves its width and draws nothing, which reads as a view that
 *  failed. The left asked this and the right did not until 2026-08-17, so the right stood empty in
 *  every capture of that day. One rule, both regions, one place.
 */
export function regionPresent(
  open: boolean,
  region: Region,
  focusedPluginId: string | null,
): boolean {
  return open && standingSet(region, focusedPluginId) !== null;
}

/** The set standing in a region, given the plugin of the focused view. null = none stands, and then
 *  the region is not drawn: composing nothing and reserving width for it is a hole on the screen. */
export function standingSet(region: Region, focusedPluginId: string | null): SectionSet | null {
  const s = useSectionSets.getState();
  const standing =
    s.mode === "fixed" ? s.fixed : focusedPluginId ? (s.byPlugin[focusedPluginId] ?? null) : null;
  if (!standing || standing.region !== region) return null;
  return s.sets.find((x) => x.id === standing.set) ?? null;
}
