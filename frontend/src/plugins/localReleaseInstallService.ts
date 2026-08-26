import { invoke } from "../framework";
import { reconcileEnvironmentRevision } from "../state/environmentEvents";
import { loadReleaseClosure, type ReleaseCoordinates, type ReleaseRead } from "./registryReleaseClosure";
import { localReleaseFile, localStoreReleaseResolver, type LocalReleaseRead } from "./releaseResolver";
import { installCertifiedRegistryRelease, type RegistryInstallRuntimeResult } from "./registryInstallRuntime";
import { releaseIdentity, type ReleaseDocument, type ReleaseReference } from "./spec";
import { beginPluginInstall, setPluginInstallProgress } from "./registryInstallProgress";
import { publishActivity } from "../state/activityFeed";

interface InstalledPluginManifest { id: string; version: string; manifest: string | null }
type LocalRoot = ReleaseCoordinates & ReleaseReference;

export class DependencyVersionConflict extends Error {
  readonly code = "DEPENDENCY_VERSION_CONFLICT";
  constructor(readonly conflict: { pluginId: string; pluginVersion: string; sidecarId: string; requiredVersion: string; requestedVersion: string }) {
    super(`${conflict.pluginId}@${conflict.pluginVersion} requires Sidecar ${conflict.sidecarId} ${conflict.requiredVersion}; requested ${conflict.requestedVersion}`);
  }
}

async function requireSidecarCompatibleWithInstalledPlugins(sidecarId: string, requestedVersion: string): Promise<void> {
  const records = await invoke<InstalledPluginManifest[]>("plugin_manifest_list");
  for (const record of records) {
    if (record.manifest === null) continue;
    let raw: { runtimeDependencies?: { sidecars?: Array<{ id?: unknown; version?: unknown }> } };
    try { raw = JSON.parse(record.manifest); } catch { continue; }
    const dependency = raw.runtimeDependencies?.sidecars?.find((value) => value.id === sidecarId);
    if (typeof dependency?.version === "string" && dependency.version !== requestedVersion) {
      throw new DependencyVersionConflict({
        pluginId: record.id, pluginVersion: record.version, sidecarId,
        requiredVersion: dependency.version, requestedVersion,
      });
    }
  }
}

const readLocal = ({ store, kind, id, version }: { store: string } & ReleaseCoordinates) => invoke<LocalReleaseRead>("local_release_read", { store, kind, id, version });

// The root has no reference that pins it: the host validates the stored document and returns its
// bytes, and the size and sha256 of those bytes become the root reference.
async function localRoot(store: string, kind: ReleaseCoordinates["kind"], id: string, version: string): Promise<{ reference: LocalRoot; body: string }> {
  const result = await readLocal({ store, kind, id, version });
  if (!result.found || result.body === undefined || result.size === undefined || result.sha256 === undefined) {
    throw new Error(`unresolved release ${id}@${version}: ${localReleaseFile(store, kind, id, version, "release.json")}`);
  }
  return { reference: { kind, id, version, size: result.size, sha256: result.sha256 }, body: result.body };
}

export interface LocalInstallPlan { digest: string; store: string; id: string; version: string; releases: ReleaseDocument[] }

async function digestPlan(releases: ReleaseDocument[]): Promise<string> {
  const projection = releases.map((release) => ({ identity: releaseIdentity(release), artifacts: release.artifacts.map(({ target, file, size, sha256 }) => ({ target, file, size, sha256 })) }));
  const bytes = new TextEncoder().encode(JSON.stringify(projection));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The root bytes are read once; every dependency is read from the same store by its coordinates.
async function resolveLocal(store: string, id: string, version: string, kind: ReleaseCoordinates["kind"]): Promise<{ plan: LocalInstallPlan; root: LocalRoot }> {
  const root = await localRoot(store, kind, id, version);
  const resolve = localStoreReleaseResolver(store, readLocal);
  const read: ReleaseRead = (release) => release.kind === kind && release.id === id && release.version === version ? Promise.resolve(root.body) : resolve(release);
  const releases = await loadReleaseClosure(root.reference, read, kind);
  return { plan: { digest: await digestPlan(releases), store, id, version, releases }, root: root.reference };
}

export const planLocalPlugin = async (store: string, id: string, version: string) => (await resolveLocal(store, id, version, "plugin")).plan;
export const planLocalSidecar = async (store: string, id: string, version: string) => {
  await requireSidecarCompatibleWithInstalledPlugins(id, version);
  return (await resolveLocal(store, id, version, "sidecar")).plan;
};

export async function installLocalPlugin(store: string, id: string, version: string, expectedPlanDigest: string): Promise<RegistryInstallRuntimeResult> {
  if (!beginPluginInstall(id)) return { ok: false, code: "INSTALL_IN_PROGRESS", message: `Plugin installation is already running: ${id}` };
  const report = (progress: { phase: "resolving" | "staging" | "committing" | "installed" | "failed"; completed: number; total: number; componentId?: string; error?: string }) => {
    const value = { pluginId: id, ...progress };
    setPluginInstallProgress(value);
    publishActivity("plugin.install.progress", "core", value);
  };
  try {
    const { plan, root } = await resolveLocal(store, id, version, "plugin");
    if (plan.digest !== expectedPlanDigest) { report({ phase: "failed", completed: 0, total: plan.releases.length, error: "local release closure changed after planning" }); return { ok: false, code: "LOCAL_INSTALL_PLAN_CHANGED", message: "local release closure changed after planning" }; }
    const result = await installCertifiedRegistryRelease({ sourceId: "local", localStore: store, root, releases: plan.releases, onProgress: (progress) => report(progress) });
    if (result.ok) { await reconcileEnvironmentRevision(result.revision); report({ phase: "installed", completed: plan.releases.length, total: plan.releases.length }); }
    else report({ phase: "failed", completed: 0, total: plan.releases.length, error: result.message });
    return result;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    report({ phase: "failed", completed: 0, total: 0, error: message });
    return { ok: false, code: "LOCAL_RELEASE_INVALID", message, errors: [message] };
  }
}

// A Sidecar listed by sidecar_status as open or recorded is in use. Installation, removal, and development
// registration refuse it with SIDECAR_IN_USE; none of them stops it.
export async function sidecarInUse(id: string): Promise<boolean> {
  const status = await invoke<{ open: Array<{ name: string }>; recorded: Array<{ name: string }> }>("sidecar_status");
  return [...status.open, ...status.recorded].some((entry) => entry.name === id);
}
export function sidecarInUseMessage(id: string, operation: "installation" | "removal" | "development"): string {
  return `Sidecar ${id} is running or recorded; stop it explicitly before ${operation}`;
}

export async function installLocalSidecar(store: string, id: string, version: string, expectedPlanDigest: string): Promise<RegistryInstallRuntimeResult> {
  try { await requireSidecarCompatibleWithInstalledPlugins(id, version); }
  catch (cause) {
    if (cause instanceof DependencyVersionConflict) return { ok: false, code: cause.code, message: cause.message, errors: [JSON.stringify(cause.conflict)] };
    throw cause;
  }
  if (await sidecarInUse(id)) return { ok: false, code: "SIDECAR_IN_USE", message: sidecarInUseMessage(id, "installation") };
  const { plan, root } = await resolveLocal(store, id, version, "sidecar");
  if (plan.digest !== expectedPlanDigest) return { ok: false, code: "LOCAL_INSTALL_PLAN_CHANGED", message: "local release closure changed after planning" };
  const result = await installCertifiedRegistryRelease({ sourceId: "local", localStore: store, root, releases: plan.releases });
  if (result.ok) await reconcileEnvironmentRevision(result.revision);
  return result;
}
