import { moduleState } from "../lib/moduleState";
import type { LoadedPluginModule } from "./pluginModuleRealm";

export type PluginModuleLoader = (source: string) => Promise<LoadedPluginModule>;

export interface PluginModuleCache {
  load(id: string, source: string, loader: PluginModuleLoader): Promise<unknown>;
  reuse(id: string, source: string): boolean;
  release(id: string): Promise<boolean>;
  retain(ids: ReadonlySet<string>): Promise<void>;
  releaseAll(): Promise<void>;
  stats(): { open: number; loaded: number; reused: number; replaced: number; released: number };
}

export function createPluginModuleCache(): PluginModuleCache {
  const entries = new Map<string, { source: string; loaded: LoadedPluginModule }>();
  let loaded = 0;
  let reused = 0;
  let replaced = 0;
  let released = 0;

  const release = async (id: string): Promise<boolean> => {
    const entry = entries.get(id);
    if (!entry) return false;
    entries.delete(id);
    await entry.loaded.dispose();
    released += 1;
    return true;
  };
  const reuse = (id: string, source: string): boolean => {
    const current = entries.get(id);
    if (current?.source !== source) return false;
    reused += 1;
    return true;
  };

  return {
    async load(id, source, loader) {
      if (reuse(id, source)) {
        return entries.get(id)!.loaded.module;
      }
      const current = entries.get(id);
      if (current) {
        entries.delete(id);
        await current.loaded.dispose();
        replaced += 1;
      }
      const next = await loader(source);
      entries.set(id, { source, loaded: next });
      loaded += 1;
      return next.module;
    },
    reuse,
    release,
    async retain(ids) {
      for (const id of [...entries.keys()]) {
        if (!ids.has(id)) await release(id);
      }
    },
    async releaseAll() {
      for (const id of [...entries.keys()]) await release(id);
    },
    stats: () => ({ open: entries.size, loaded, reused, replaced, released }),
  };
}

export const pluginModuleCache = moduleState(
  "plugins/pluginModuleCache#cache",
  createPluginModuleCache,
);
