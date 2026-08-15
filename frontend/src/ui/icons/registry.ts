// Icon set registry — same shape as viewRegistry (zustand + version counter).
// Built-in lucide is the always-present fallback: the UI still renders with no set selected
// (plugin disabled/removed) or with an empty name.

import { moduleState } from "../../lib/moduleState";
import { create } from "zustand";
import { ICON_NAMES, type IconGlyph, type IconName, type IconSetData } from "./types";
import { LUCIDE_ICONS } from "./sets/lucide";
import { tmsg } from "../../i18n";

export const BUILTIN_ICON_SET = "lucide";

export interface RegisteredIconSet {
  id: string;
  /** Display name (settings dropdown) */
  name: string;
  data: IconSetData;
}

interface IconRegistryState {
  sets: Record<string, RegisteredIconSet>;
  version: number;
  register: (set: RegisteredIconSet) => void;
  unregister: (id: string) => void;
}

// The store is outside the module boundary — a hot swap that replaces it makes registrations,
// subscriptions, and screen state all new, while the filling side treats it as already filled
// and never fills again (empty forever).
export const useIconRegistry = moduleState("ui/icons/registry#store", () =>
  create<IconRegistryState>((set) => ({
  sets: {
    [BUILTIN_ICON_SET]: { id: BUILTIN_ICON_SET, name: "Lucide", data: LUCIDE_ICONS },
  },
  version: 1,
  register: (s) =>
    set((st) => ({
      sets: { ...st.sets, [s.id]: s },
      version: st.version + 1,
    })),
  unregister: (id) =>
    set((st) => {
      if (id === BUILTIN_ICON_SET) return st; // Built-in fallback cannot be unregistered
      if (!(id in st.sets)) return st;
      const next = { ...st.sets };
      delete next[id];
      return { sets: next, version: st.version + 1 };
    }),
})),
);

// Set data validation — registration requires every semantic name (a partial set returns a
// message naming which one is missing). Guards plugin input.
export function validateIconSetData(data: unknown): string | null {
  if (!data || typeof data !== "object") return tmsg("plugin.iconSet.notObject");
  const d = data as Record<string, Partial<IconGlyph>>;
  for (const name of ICON_NAMES) {
    const g = d[name];
    if (!g || typeof g !== "object") return tmsg("plugin.iconSet.missingGlyph", { name });
    if (typeof g.v !== "string" || !g.v.trim()) return tmsg("plugin.iconSet.missingViewBox", { name });
    if (typeof g.b !== "string" || !g.b.trim()) return tmsg("plugin.iconSet.missingBody", { name });
    if (g.f !== "stroke" && g.f !== "fill" && g.f !== "both")
      return tmsg("plugin.iconSet.badRenderMode", { name });
  }
  return null;
}

/** Glyph of setId — falls back to built-in lucide when the set or the name is absent. */
export function getIconGlyph(setId: string, name: IconName): IconGlyph {
  const sets = useIconRegistry.getState().sets;
  return sets[setId]?.data[name] ?? LUCIDE_ICONS[name];
}

// Set ids this plugin actually registered (the actual of declared≡actual). Global
// id="<pluginId>.<setId>" → returns setId only. Built-in lucide (no prefix) is excluded
// automatically. A plugin id contains no dot, so splitting on the prefix is safe.
export function registeredIconSetIds(pluginId: string): string[] {
  const prefix = `${pluginId}.`;
  return Object.values(useIconRegistry.getState().sets)
    .filter((s) => s.id.startsWith(prefix))
    .map((s) => s.id.slice(prefix.length));
}
