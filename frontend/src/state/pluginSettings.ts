import { create } from "zustand";
import { moduleState } from "../lib/moduleState";
import type { MapEntry } from "../plugins/spec";
import { createCoreSync } from "./coreSync";
import type { CoreStoreDeps } from "./coreStore";

// Plugin user settings — two layers: global (app-wide) + per-workspace override.
// Only overridden values are stored (manifest configuration is the single truth for defaults —
// not kept here).
// effective = workspace override ?? global ?? schema default (the caller passes it as def).
//
// Workspace identity = root path (Workspace.root, P4) — a persistent key, not a session-scoped tab id.

// Includes list (string array) and map ({key,value} array) setting values — the settings modal edits them per row with add/remove.
export type SettingValue = boolean | number | string | string[] | MapEntry[];
// [pluginId][key] → value
type Bag = Record<string, Record<string, SettingValue>>;

interface PluginSettingsState {
  global: Bag;
  byWorkspace: Record<string, Bag>; // [workspaceRoot][pluginId][key]
  getGlobal: (pluginId: string, key: string) => SettingValue | undefined;
  getWorkspace: (root: string, pluginId: string, key: string) => SettingValue | undefined;
  setGlobal: (pluginId: string, key: string, value: SettingValue) => void;
  setWorkspace: (root: string, pluginId: string, key: string, value: SettingValue) => void;
  // Omitted key = remove every override of that plugin in that scope (defaults restored).
  resetGlobal: (pluginId: string, key?: string) => void;
  resetWorkspace: (root: string, pluginId: string, key?: string) => void;
  effective: (pluginId: string, key: string, def: SettingValue, root?: string) => SettingValue;
  allEffective: (
    pluginId: string,
    defaults: Record<string, SettingValue>,
    root?: string,
  ) => Record<string, SettingValue>;
}

const KEY = "soksak.pluginSettings";

type PluginSettingsBlob = { global: Bag; byWorkspace: Record<string, Bag> };
const EMPTY: PluginSettingsBlob = { global: {}, byWorkspace: {} };

const pluginSettingsSync = createCoreSync<PluginSettingsBlob>({
  key: "pluginSettings",
  lsKey: KEY,
  fallback: EMPTY,
  apply: (v) =>
    usePluginSettings.setState({
      global: v?.global ?? {},
      byWorkspace: v?.byWorkspace ?? {},
    }),
});
export const initPluginSettingsPersistence = (deps: CoreStoreDeps): (() => void) =>
  pluginSettingsSync.init(deps);

function load(): PluginSettingsBlob {
  const v = pluginSettingsSync.loadSync();
  return { global: v?.global ?? {}, byWorkspace: v?.byWorkspace ?? {} };
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
// subscriptions, and screen state all new, while the filling side treats it as already filled
// and never fills again (empty forever).
export const usePluginSettings = moduleState("state/pluginSettings#store", () =>
  create<PluginSettingsState>((set, get) => {
  const persist = () => {
    const s = get();
    pluginSettingsSync.save({ global: s.global, byWorkspace: s.byWorkspace });
  };
  const init = load();
  return {
    global: init.global,
    byWorkspace: init.byWorkspace,
    getGlobal: (pluginId, key) => get().global[pluginId]?.[key],
    getWorkspace: (root, pluginId, key) => get().byWorkspace[root]?.[pluginId]?.[key],
    setGlobal: (pluginId, key, value) => {
      set((s) => ({ global: bagSet(s.global, pluginId, key, value) }));
      persist();
    },
    setWorkspace: (root, pluginId, key, value) => {
      set((s) => ({
        byWorkspace: { ...s.byWorkspace, [root]: bagSet(s.byWorkspace[root] ?? {}, pluginId, key, value) },
      }));
      persist();
    },
    resetGlobal: (pluginId, key) => {
      set((s) => ({ global: bagDelete(s.global, pluginId, key) }));
      persist();
    },
    resetWorkspace: (root, pluginId, key) => {
      set((s) => {
        if (!s.byWorkspace[root]) return s;
        return { byWorkspace: { ...s.byWorkspace, [root]: bagDelete(s.byWorkspace[root], pluginId, key) } };
      });
      persist();
    },
    effective: (pluginId, key, def, root) => {
      const s = get();
      const proj = root ? s.byWorkspace[root]?.[pluginId]?.[key] : undefined;
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
