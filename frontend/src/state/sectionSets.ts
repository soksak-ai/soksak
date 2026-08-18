import { create } from "zustand";
import { moduleState } from "../lib/moduleState";
import { createCoreSync } from "./coreSync";
import type { CoreStoreDeps } from "./coreStore";
import { issueId } from "./ids";
import { allGroups, type Workspace } from "./sessions";

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

/**
 * Where a sidebar stands. Three places, and the place is the rule.
 *
 * `rail` is the one that moves: it stands between panes, on a clean line, and travels with the
 * focus (FLOW) or holds a station (PIN). What stands in it is the focused view's plugin's set,
 * because a sidebar that follows the focus and does not change with it is a box that moves for no
 * reason.
 *
 * `left` and `right` are the window's own edges. They do not move, they take a width a person
 * drags, and they draw over the content or take room from it. `right` holds the focused plugin's
 * set like the rail does; `left` holds one set for the whole installation, whatever is focused.
 *
 * There is no mode switch between those — the place is the rule. A switch would let two places
 * behave the same way, and then there is no reason for there to be two.
 *
 * `left` meant the rail until 2026-08-18. The stored key is versioned rather than migrated (L11c) —
 * a value that reads correct and means somewhere else is worse than no value.
 */
export type SectionPlace = "left" | "rail" | "right";

/**
 * Every place, in the order they stand on the screen.
 *
 * One list, because a caller that writes the three out by hand forgets one: measured while adding
 * the third, six records were built by naming `left` and `right` and none of them mentioned the
 * rail — each a place that would hold nothing with nothing to say it was missing.
 */
export const SECTION_PLACES: readonly SectionPlace[] = ["left", "rail", "right"];

/** A record with one entry per place, from a function of the place. */
export function byPlace<T>(of: (place: SectionPlace) => T): Record<SectionPlace, T> {
  return { left: of("left"), rail: of("rail"), right: of("right") };
}

/** One set. Sections are view keys, `<pluginId>.<viewId>`, in the order they stand. */
export interface SectionSet {
  id: string;
  title: string;
  sections: string[];
}

/** Which set stands in each place a plugin can fill. A place with no entry has nothing standing.
 *
 *  One standing for the whole plugin was the same record with a `region` on it, and it made the two
 *  regions exclusive: a plugin standing a set on the left had no place to name a second one, so the
 *  right toggle took no width whatever it was pressed. A region is a place, and each place holds
 *  its own set. */
export type Standing = Partial<Record<PluginPlace, string>>;

/** The places a plugin's link can fill: the two that follow the focus. `left` is not one of them —
 *  it holds one set for the installation and is set once, not per plugin. */
export type PluginPlace = "rail" | "right";

export interface SectionSetsState {
  sets: SectionSet[];
  /** pluginId → which set stands in the places that follow the focus. */
  byPlugin: Record<string, Standing>;
  /** The one set standing on the left, for the whole installation. Null = nothing stands there,
   *  and a place with nothing standing does not open. */
  left: string | null;

  create: (title: string) => SectionSet;
  rename: (id: string, title: string) => void;
  remove: (id: string) => void;
  arrange: (id: string, sections: string[]) => void;
  link: (pluginId: string, place: PluginPlace, set: string | null) => void;
  standLeft: (set: string | null) => void;
}

interface Persisted {
  sets: SectionSet[];
  byPlugin: Record<string, Standing>;
  left: string | null;
}

const EMPTY: Persisted = { sets: [], byPlugin: {}, left: null };

const sync = createCoreSync<Persisted>({
  // Versioned rather than migrated. `left` named the rail until 2026-08-18 and names the window's
  // left edge now, so a stored value under the old key reads correct and means somewhere else — a
  // sidebar appearing at the wrong edge with nothing to say it moved. A new key is not read by the
  // old build and the old key is not read by this one; what a person had is gone and a few clicks
  // rebuild it, which is the honest half of that trade (L11c).
  key: "sectionSets.v2",
  lsKey: "soksak.sectionSets.v2",
  fallback: EMPTY,
  apply: (v) => useSectionSets.setState(shapeOf(v)),
});

export const initSectionSetsPersistence = (deps: CoreStoreDeps): (() => void) => sync.init(deps);

const isPluginPlace = (v: unknown): v is PluginPlace => v === "rail" || v === "right";

/** A standing as this build reads it: region → a set that exists. Anything else is dropped, and a
 *  standing left with no region is nothing standing. */
function standingOf(raw: unknown, known: Set<string>): Standing {
  const standing: Standing = {};
  for (const [place, set] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
    if (isPluginPlace(place) && typeof set === "string" && known.has(set)) standing[place] = set;
  }
  return standing;
}

/** Whether anything stands at all. */
export const standsSomewhere = (standing: Standing): boolean => Object.keys(standing).length > 0;

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
    if (standsSomewhere(kept)) byPlugin[plugin] = kept;
  }
  return {
    sets,
    byPlugin,
    left: typeof v.left === "string" && known.has(v.left) ? v.left : null,
  };
}

const persistedOf = (s: SectionSetsState): Persisted => ({
  sets: s.sets,
  byPlugin: s.byPlugin,
  left: s.left,
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
        const byPlugin: Record<string, Standing> = {};
        for (const [plugin, standing] of Object.entries(get().byPlugin)) {
          const kept = withoutSet(standing, id);
          if (standsSomewhere(kept)) byPlugin[plugin] = kept;
        }
        commit({
          sets: get().sets.filter((s) => s.id !== id),
          byPlugin,
          left: get().left === id ? null : get().left,
        });
      },
      arrange: (id, sections) =>
        commit({ sets: get().sets.map((s) => (s.id === id ? { ...s, sections } : s)) }),
      link: (pluginId, place, set) => {
        const standing = stood(get().byPlugin[pluginId] ?? {}, place, set);
        const byPlugin = { ...get().byPlugin };
        if (standsSomewhere(standing)) byPlugin[pluginId] = standing;
        else delete byPlugin[pluginId];
        commit({ byPlugin });
      },
      standLeft: (set) => commit({ left: set }),
    };
  }),
);

/** Whether a place is present: the person has it open and a set stands there.
 *
 *  A place open with nothing in it reserves its width and draws nothing, which reads as a view that
 *  failed. The rail asked this and the right did not until 2026-08-17, so the right stood empty in
 *  every capture of that day. One rule, all three places.
 */
export function placePresent(
  open: boolean,
  place: SectionPlace,
  focusedPluginId: string | null,
): boolean {
  return open && standingSet(place, focusedPluginId) !== null;
}

/** The set standing in a region, given the plugin of the focused view. null = none stands, and then
 *  the region is not drawn: composing nothing and reserving width for it is a hole on the screen. */
/**
 * The plugin of the view a workspace is focused on — what `individual` reads.
 *
 * Beside the rule it feeds rather than in the plane that draws it. Three readers depend on it: the
 * plane, the hole reported for the surface underneath a region, and sections.link, for whether
 * the link it just made changed what stands. A second copy would be a second answer to whose
 * sections stand.
 */
export function focusedPluginOf(workspace: Workspace | null | undefined): string | null {
  if (!workspace) return null;
  const space = workspace.spaces.find((c) => c.id === workspace.activeSpaceId);
  if (!space) return null;
  const group = allGroups(space.layout).find((g) => g.id === space.activePaneId);
  const view = group?.tabs.find((v) => v.id === group.activeTabId);
  return view?.pluginId ?? null;
}

export function standingSet(place: SectionPlace, focusedPluginId: string | null): SectionSet | null {
  const s = useSectionSets.getState();
  // The place is the rule. `left` holds one set for the installation; the other two hold the
  // focused view's plugin's set. There is no switch between the two, because a switch would let two
  // places answer the same way and then there is no reason for there to be two.
  const id =
    place === "left"
      ? s.left
      : focusedPluginId
        ? (s.byPlugin[focusedPluginId] ?? {})[place]
        : undefined;
  if (!id) return null;
  return s.sets.find((x) => x.id === id) ?? null;
}

/** The same standing with one place settled — a set stands there, or nothing does. */
function stood(standing: Standing, place: PluginPlace, set: string | null): Standing {
  const next = { ...standing };
  if (set === null) delete next[place];
  else next[place] = set;
  return next;
}

/** The same standing with one set gone from wherever it stood. */
function withoutSet(standing: Standing, set: string): Standing {
  const next: Standing = {};
  for (const [place, id] of Object.entries(standing)) {
    if (isPluginPlace(place) && id !== set) next[place] = id;
  }
  return next;
}
