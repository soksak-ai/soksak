import { create } from "zustand";

export type PluginInstallPhase =
  | "resolving"
  | "staging"
  | "committing"
  | "installed"
  | "failed";

export interface PluginInstallProgress {
  pluginId: string;
  phase: PluginInstallPhase;
  completed: number;
  total: number;
  componentId?: string;
  error?: string;
}

interface PluginInstallProgressState {
  installs: Record<string, PluginInstallProgress>;
}

export const usePluginInstallProgress = create<PluginInstallProgressState>(() => ({ installs: {} }));

const active = (phase: PluginInstallPhase): boolean =>
  phase === "resolving" || phase === "staging" || phase === "committing";

export function beginPluginInstall(pluginId: string): boolean {
  const current = usePluginInstallProgress.getState().installs[pluginId];
  if (current && active(current.phase)) return false;
  setPluginInstallProgress({ pluginId, phase: "resolving", completed: 0, total: 0 });
  return true;
}

export function setPluginInstallProgress(progress: PluginInstallProgress): void {
  usePluginInstallProgress.setState((state) => ({
    installs: { ...state.installs, [progress.pluginId]: Object.freeze({ ...progress }) },
  }));
}

export function pluginInstallProgress(pluginId?: string): PluginInstallProgress[] {
  const installs = usePluginInstallProgress.getState().installs;
  if (pluginId) return installs[pluginId] ? [{ ...installs[pluginId] }] : [];
  return Object.values(installs).map((progress) => ({ ...progress }));
}

export function pluginInstallActive(progress: PluginInstallProgress | undefined): boolean {
  return progress ? active(progress.phase) : false;
}

export function waitForPluginInstallPhase(pluginId: string, phase: PluginInstallPhase, timeoutMs: number): Promise<PluginInstallProgress> {
  const current = usePluginInstallProgress.getState().installs[pluginId];
  if (current?.phase === phase) return Promise.resolve({ ...current });
  if (current?.phase === "failed" && phase !== "failed") {
    return Promise.reject(new Error(current.error ?? `plugin ${pluginId} installation failed`));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error(`plugin ${pluginId} did not reach ${phase} within ${timeoutMs}ms`)); }, timeoutMs);
    const unsubscribe = usePluginInstallProgress.subscribe((state) => {
      const progress = state.installs[pluginId];
      if (progress?.phase === "failed" && phase !== "failed") {
        clearTimeout(timer);
        unsubscribe();
        reject(new Error(progress.error ?? `plugin ${pluginId} installation failed`));
        return;
      }
      if (progress?.phase !== phase) return;
      clearTimeout(timer);
      unsubscribe();
      resolve({ ...progress });
    });
  });
}
