import { create } from "zustand";
import { moduleState } from "../lib/moduleState";
import type { MapEntry } from "../plugins/spec";
import { createCoreSync } from "./coreSync";
import type { CoreStoreDeps } from "./coreStore";

// Plugin user settings — two layers: global (app-wide) + per-project override.
// Only overridden values are stored (manifest configuration is the single truth for defaults —
// not kept here).
// effective = project override ?? global ?? schema default (the caller passes it as def).
//
// Project identity = root path (Project.root, P4) — a persistent key, not a session-scoped tab id.

// Includes list (string array) and map ({key,value} array) setting values — the settings modal edits them per row with add/remove.
export type SettingValue = boolean | number | string | string[] | MapEntry[];
// [pluginId][key] → value
type Bag = Record<string, Record<string, SettingValue>>;

interface PluginSettingsState {
  global: Bag;
  byProject: Record<string, Bag>; // [projectRoot][pluginId][key]
  getGlobal: (pluginId: string, key: string) => SettingValue | undefined;
  getProject: (root: string, pluginId: string, key: string) => SettingValue | undefined;
  setGlobal: (pluginId: string, key: string, value: SettingValue) => void;
  setProject: (root: string, pluginId: string, key: string, value: SettingValue) => void;
  // Omitted key = remove every override of that plugin in that scope (defaults restored).
  resetGlobal: (pluginId: string, key?: string) => void;
  resetProject: (root: string, pluginId: string, key?: string) => void;
  effective: (pluginId: string, key: string, def: SettingValue, root?: string) => SettingValue;
  allEffective: (
    pluginId: string,
    defaults: Record<string, SettingValue>,
    root?: string,
  ) => Record<string, SettingValue>;
}

const KEY = "soksak.pluginSettings";

type PluginSettingsBlob = { global: Bag; byProject: Record<string, Bag> };
const EMPTY: PluginSettingsBlob = { global: {}, byProject: {} };

const pluginSettingsSync = createCoreSync<PluginSettingsBlob>({
  key: "pluginSettings",
  lsKey: KEY,
  fallback: EMPTY,
  apply: (v) =>
    usePluginSettings.setState({
      global: v?.global ?? {},
      byProject: v?.byProject ?? {},
    }),
});
export const initPluginSettingsPersistence = (deps: CoreStoreDeps): (() => void) =>
  pluginSettingsSync.init(deps);

function load(): PluginSettingsBlob {
  const v = pluginSettingsSync.loadSync();
  return { global: v?.global ?? {}, byProject: v?.byProject ?? {} };
}

// Immutable nested set — a new object replaces the old one so zustand subscribers update.
function bagSet(bag: Bag, pluginId: string, key: string, value: SettingValue): Bag {
  return { ...bag, [pluginId]: { ...(bag[pluginId] ?? {}), [key]: value } };
}
// With key, remove that key only; without it, remove the whole plugin entry.
function bagDelete(bag: Bag, pluginId: string, key?: string): Bag {
  if (!(pluginId in bag)) return bag;
  if (key === undefined) {
    const next = { ...bag };
    delete next[pluginId];
    return next;
  }
  const inner = { ...(bag[pluginId] ?? {}) };
  delete inner[key];
  return { ...bag, [pluginId]: inner };
}

// The store is outside the module boundary — a hot swap that replaces it makes registrations,
// subscriptions, and screen state all new, while the side that filled them treats them as already
// filled and never refills (empty forever).
export const usePluginSettings = moduleState("state/pluginSettings#store", () =>
  create<PluginSettingsState>((set, get) => {
  const persist = () => {
    const s = get();
    pluginSettingsSync.save({ global: s.global, byProject: s.byProject });
  };
  const init = load();
  return {
    global: init.global,
    byProject: init.byProject,
    getGlobal: (pluginId, key) => get().global[pluginId]?.[key],
    getProject: (root, pluginId, key) => get().byProject[root]?.[pluginId]?.[key],
    setGlobal: (pluginId, key, value) => {
      set((s) => ({ global: bagSet(s.global, pluginId, key, value) }));
      persist();
    },
    setProject: (root, pluginId, key, value) => {
      set((s) => ({
        byProject: { ...s.byProject, [root]: bagSet(s.byProject[root] ?? {}, pluginId, key, value) },
      }));
      persist();
    },
    resetGlobal: (pluginId, key) => {
      set((s) => ({ global: bagDelete(s.global, pluginId, key) }));
      persist();
    },
    resetProject: (root, pluginId, key) => {
      set((s) => {
        if (!s.byProject[root]) return s;
        return { byProject: { ...s.byProject, [root]: bagDelete(s.byProject[root], pluginId, key) } };
      });
      persist();
    },
    effective: (pluginId, key, def, root) => {
      const s = get();
      const proj = root ? s.byProject[root]?.[pluginId]?.[key] : undefined;
      if (proj !== undefined) return proj;
      const glob = s.global[pluginId]?.[key];
      if (glob !== undefined) return glob;
      return def;
    },
    allEffective: (pluginId, defaults, root) => {
      const out: Record<string, SettingValue> = {};
      for (const k of Object.keys(defaults)) {
        out[k] = get().effective(pluginId, k, defaults[k], root);
      }
      return out;
    },
  };
}),
);
