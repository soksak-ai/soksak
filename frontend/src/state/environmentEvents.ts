import { invoke } from "../framework";

// The host document environment_get returns. The Go host owns, writes, and validates environment.json
// (platformspec.ValidateEnvironment); the frontend reads it as typed data and does not validate it.
// A development record: source "development", artifactSha256 "" (key present), no registry key.
export type HostEnvironmentSource = "registry" | "local" | "development";
export interface HostComponent {
  version: string;
  path: string;
  artifactSha256: string;
  source: HostEnvironmentSource;
  registry?: string;
  target?: string;
}
export interface HostPlugin extends HostComponent { enabled: boolean }
export interface HostSidecar extends HostComponent { target: string }
export interface HostEnvironment {
  revision: number;
  plugins: Record<string, HostPlugin>;
  sidecars: Record<string, HostSidecar>;
}

// artifactDeleteFailed: plugin_remove / sidecar_remove only. The record is removed and the revision advanced;
// the artifact directory (the <dir>.removing path) remains. The host never throws for this case.
export interface ArtifactDeleteFailed { path: string; error: string }
export interface EnvironmentChange { previousRevision: number; revision: number; artifactDeleteFailed?: ArtifactDeleteFailed }
export interface EnvironmentEventHandler { (change: EnvironmentChange): Promise<void>; revision(): number }

let activeHandler: EnvironmentEventHandler | null = null;

export function setEnvironmentEventHandler(handler: EnvironmentEventHandler): () => void {
  const previous = activeHandler;
  activeHandler = handler;
  return () => {
    if (activeHandler === handler) activeHandler = previous;
  };
}

export function reconcileEnvironmentRevision(revision: number): Promise<void> {
  if (activeHandler === null) return Promise.reject(new Error("environment revision coordinator is not ready"));
  return activeHandler({ previousRevision: activeHandler.revision(), revision });
}

// One environment revision step: read the revision, write at that revision (compare-and-swap in the host),
// then reconcile once through the coordinator so the environment.changed event for the same revision is a no-op.
// The host validates the arguments and applies the record rule; a host refusal propagates as a thrown error.
export async function writeEnvironmentRevision(
  command: "plugin_develop" | "sidecar_develop" | "sidecar_remove",
  args: { id: string; path?: string },
): Promise<EnvironmentChange> {
  const environment = await invoke<HostEnvironment>("environment_get");
  const change = await invoke<EnvironmentChange>(command, { ...args, expectedRevision: environment.revision });
  await reconcileEnvironmentRevision(change.revision);
  return change;
}

export function createEnvironmentEventHandler(reload: () => Promise<void>, initialRevision: number): EnvironmentEventHandler {
  let applied = initialRevision;
  let pending = initialRevision;
  let running: Promise<void> | null = null;
  const drain = async (): Promise<void> => { while (pending > applied) { const target = pending; await reload(); applied = target; } };
  const handler = (async (change: EnvironmentChange): Promise<void> => {
    if (!Number.isSafeInteger(change.revision) || change.revision <= applied) return;
    pending = Math.max(pending, change.revision);
    if (running === null) running = drain().finally(() => { running = null; });
    await running;
  }) as EnvironmentEventHandler;
  handler.revision = () => applied;
  return handler;
}
