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
