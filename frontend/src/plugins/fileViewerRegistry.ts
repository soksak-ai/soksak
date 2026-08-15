// File viewer registry — the single store of renderers routed by extension when a file opens as content.
// Engine neutral (contract A13): the core only matches and hosts. The render engine (CodeMirror/Monaco/media)
// is plugin owned — provider.mount draws into the container directly (same shape as viewRegistry). version is the UI rebuild signal.

import { moduleState } from "../lib/moduleState";
import { create } from "zustand";
import { qualifiedViewId, type ContributedFileViewer } from "./spec";
import { tmsg } from "../i18n";

// Context a file viewer receives. The only channel the core passes in (contract A2) — no store, no layout exposure.
export interface FileViewerContext {
  viewId: string; // stable id of this file view (instance key — separates splits and windows)
  path: string; // absolute path of the file to open
  projectId: string;
  root: string | null;
  // Reports unsaved-change state to the core tab (dirty marker). Meaningful only for an editable viewer.
  setDirty: (dirty: boolean) => void;
}

// File viewer a plugin implements. React not required — draws into the container DOM directly (same shape as PluginViewProvider).
export interface FileViewerProvider {
  mount(container: HTMLElement, ctx: FileViewerContext): void;
  unmount?(container: HTMLElement): void;
}

export interface RegisteredFileViewer {
  pluginId: string;
  decl: ContributedFileViewer; // manifest declaration (extensions/priority) — the single truth for matching
  provider: FileViewerProvider;
}

interface FileViewerRegistryState {
  viewers: Record<string, RegisteredFileViewer>; // key = "<pluginId>.<id>"
  version: number; // increments on every register/unregister — re-evaluation signal for the file view host
  register: (
    pluginId: string,
    decl: ContributedFileViewer,
    provider: FileViewerProvider,
  ) => () => void;
}

// The store is outside the module boundary — a module swap replaces registration, subscription, and screen
// state wholesale, and the populating side does not populate again (empty forever).
export const useFileViewerRegistry = moduleState("plugins/fileViewerRegistry#store", () =>
  create<FileViewerRegistryState>(
  (set, get) => ({
    viewers: {},
    version: 0,

    register: (pluginId, decl, provider) => {
      const key = qualifiedViewId(pluginId, decl.id);
      if (get().viewers[key]) {
        // §0-3 no silent failure — duplicate registration is a bug (re-activation without unregister).
        throw new Error(tmsg("plugin.fileViewer.duplicate", { viewer: key }));
      }
      set((s) => ({
        viewers: { ...s.viewers, [key]: { pluginId, decl, provider } },
        version: s.version + 1,
      }));
      return () => {
        set((s) => {
          if (!s.viewers[key]) return s; // already unregistered — idempotent
          const viewers = { ...s.viewers };
          delete viewers[key];
          return { viewers, version: s.version + 1 };
        });
      };
    },
  }),
),
);

// Extension at the end of the file name (lowercase). "" when absent, as in 'Makefile'/'.zshrc'.
function extOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

// Candidate ordering that preserves registration order (priority desc, ties by registration order). Object insertion order = registration order.
function best(
  candidates: RegisteredFileViewer[],
): RegisteredFileViewer | null {
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) =>
    (b.decl.priority ?? 0) > (a.decl.priority ?? 0) ? b : a,
  );
}

// Best viewer for the path extension. An exact extension match (priority) always beats the fallback ("*").
// null when there is none (the core renders the "no viewer for this file type" empty state — pure skeleton).
export function resolveFileViewer(path: string): RegisteredFileViewer | null {
  const ext = extOf(path);
  const all = Object.values(useFileViewerRegistry.getState().viewers);
  const exact = all.filter((v) => v.decl.extensions.includes(ext));
  const hit = best(exact);
  if (hit) return hit;
  return best(all.filter((v) => v.decl.extensions.includes("*")));
}

// fileViewer ids this plugin actually registered (the actual of declared≡actual). Registration order preserved.
export function registeredFileViewerIds(pluginId: string): string[] {
  return Object.values(useFileViewerRegistry.getState().viewers)
    .filter((v) => v.pluginId === pluginId)
    .map((v) => v.decl.id);
}
