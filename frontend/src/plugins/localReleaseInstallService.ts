import { invoke } from "../framework";
import { reconcileEnvironmentRevision } from "../state/environmentEvents";
import { loadReleaseClosure, type ReleaseCoordinates, type ReleaseRead } from "./registryReleaseClosure";
import { localReleaseFile, localStoreReleaseResolver, type LocalReleaseRead } from "./releaseResolver";
import { installCertifiedRegistryRelease, installCertifiedRegistryReleases, type RegistryInstallRuntimeResult } from "./registryInstallRuntime";
import { releaseIdentity, type ReleaseDocument, type ReleaseReference } from "./spec";
import { beginPluginInstall, pluginInstallActive, pluginInstallProgress, setPluginInstallProgress } from "./registryInstallProgress";
import { publishActivity } from "../state/activityFeed";

interface InstalledPluginManifest { id: string; version: string; manifest: string | null }
type LocalRoot = ReleaseCoordinates & ReleaseReference;

export class DependencyVersionConflict extends Error {
  readonly code = "DEPENDENCY_VERSION_CONFLICT";
  readonly conflicts: DependencyConflict[];
  readonly conflict: DependencyConflict;
  constructor(conflict: DependencyConflict | DependencyConflict[]) {
    const conflicts = Array.isArray(conflict) ? conflict : [conflict];
    const message = conflicts.map((item) => "kind" in item
      ? `${item.kind} ${item.id} selects incompatible versions ${item.versions.join(", ")}`
      : `${item.pluginId}@${item.pluginVersion} requires Sidecar ${item.sidecarId} ${item.requiredVersion}; requested ${item.requestedVersion}`
    ).join("; ");
    super(message);
    this.conflicts = conflicts;
    this.conflict = conflicts[0];
  }
}

type DependencyConflict = {
  pluginId: string;
  pluginVersion: string;
  sidecarId: string;
  requiredVersion: string;
  requestedVersion: string;
} | {
  kind: ReturnType<typeof releaseIdentity>["kind"];
  id: string;
  versions: string[];
  requiredBy: Array<{ pluginId: string; pluginVersion: string; version: string }>;
};

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
export interface LocalPluginRoot { id: string; version: string }
export interface LocalBatchInstallPlan { digest: string; store: string; roots: LocalPluginRoot[]; releases: ReleaseDocument[] }

async function digestPlan(releases: ReleaseDocument[]): Promise<string> {
  const projection = releases.map((release) => ({ identity: releaseIdentity(release), artifacts: release.artifacts.map(({ target, file, size, sha256 }) => ({ target, file, size, sha256 })) }));
  const bytes = new TextEncoder().encode(JSON.stringify(projection));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The root bytes are read once; every dependency is read from the same store by its coordinates.
async function resolveLocalClosure(store: string, id: string, version: string, kind: ReleaseCoordinates["kind"]): Promise<{ releases: ReleaseDocument[]; root: LocalRoot }> {
  const root = await localRoot(store, kind, id, version);
  const resolve = localStoreReleaseResolver(store, readLocal);
  const read: ReleaseRead = (release) => release.kind === kind && release.id === id && release.version === version ? Promise.resolve(root.body) : resolve(release);
  const releases = await loadReleaseClosure(root.reference, read, kind);
  return { releases, root: root.reference };
}

async function resolveLocal(store: string, id: string, version: string, kind: ReleaseCoordinates["kind"]): Promise<{ plan: LocalInstallPlan; root: LocalRoot }> {
  const resolved = await resolveLocalClosure(store, id, version, kind);
  return {
    plan: { digest: await digestPlan(resolved.releases), store, id, version, releases: resolved.releases },
    root: resolved.root,
  };
}

export const planLocalPlugin = async (store: string, id: string, version: string) => (await resolveLocal(store, id, version, "plugin")).plan;
async function resolveLocalPlugins(store: string, requested: LocalPluginRoot[]): Promise<{ plan: LocalBatchInstallPlan; references: LocalRoot[] }> {
  if (requested.length < 2) throw new Error("a multi-plugin transaction requires at least two roots");
  const roots = [...requested].sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(roots.map(({ id }) => id)).size !== roots.length) throw new Error("a multi-plugin transaction contains a duplicate root");
  const resolved = await Promise.all(roots.map(({ id, version }) => resolveLocalClosure(store, id, version, "plugin")));

  // One installed environment can select one version of a component id. A release identity includes
  // version, so keying the union by kind:id@version accepts two incompatible releases as if they
  // were unrelated. Detect the conflict on kind+id before building or digesting the transaction.
  const selections = new Map<string, {
    kind: ReturnType<typeof releaseIdentity>["kind"];
    id: string;
    versions: Map<string, Array<{ pluginId: string; pluginVersion: string; version: string }>>;
  }>();
  for (let index = 0; index < resolved.length; index += 1) {
    const root = roots[index];
    for (const release of resolved[index].releases) {
      const identity = releaseIdentity(release);
      const key = `${identity.kind}:${identity.id}`;
      const selected: {
        kind: ReturnType<typeof releaseIdentity>["kind"];
        id: string;
        versions: Map<string, Array<{ pluginId: string; pluginVersion: string; version: string }>>;
      } = selections.get(key) ?? {
        kind: identity.kind,
        id: identity.id,
        versions: new Map<string, Array<{ pluginId: string; pluginVersion: string; version: string }>>(),
      };
      const requiredBy = selected.versions.get(identity.version) ?? [];
      if (!requiredBy.some((value) => value.pluginId === root.id && value.pluginVersion === root.version)) {
        requiredBy.push({ pluginId: root.id, pluginVersion: root.version, version: identity.version });
      }
      selected.versions.set(identity.version, requiredBy);
      selections.set(key, selected);
    }
  }
  const conflicts: DependencyConflict[] = [...selections.values()]
    .filter((selection) => selection.versions.size > 1)
    .sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))
    .map((selection) => ({
      kind: selection.kind,
      id: selection.id,
      versions: [...selection.versions.keys()].sort(),
      requiredBy: [...selection.versions.values()].flat().sort((left, right) =>
        `${left.pluginId}@${left.pluginVersion}:${left.version}`.localeCompare(
          `${right.pluginId}@${right.pluginVersion}:${right.version}`,
        )),
    }));
  if (conflicts.length > 0) throw new DependencyVersionConflict(conflicts);

  const releases = new Map<string, ReleaseDocument>();
  for (const item of resolved) for (const release of item.releases) {
    const identity = releaseIdentity(release);
    const key = `${identity.kind}:${identity.id}@${identity.version}`;
    const previous = releases.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(release)) throw new Error(`release identity has conflicting documents: ${key}`);
    releases.set(key, release);
  }
  const ordered = [...releases.values()].sort((a, b) => {
    const left = releaseIdentity(a); const right = releaseIdentity(b);
    return `${left.kind}:${left.id}@${left.version}`.localeCompare(`${right.kind}:${right.id}@${right.version}`);
  });
  const rootProjection = roots.map(({ id, version }) => ({ kind: "plugin", id, version }));
  const releaseProjection = ordered.map((release) => ({ identity: releaseIdentity(release), artifacts: release.artifacts.map(({ target, file, size, sha256 }) => ({ target, file, size, sha256 })) }));
  const bytes = new TextEncoder().encode(JSON.stringify({ roots: rootProjection, releases: releaseProjection }));
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { plan: { digest, store, roots, releases: ordered }, references: resolved.map(({ root }) => root) };
}
export const planLocalPlugins = async (store: string, requested: LocalPluginRoot[]) => (await resolveLocalPlugins(store, requested)).plan;
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
    if (cause instanceof DependencyVersionConflict) {
      const message = cause.message;
      report({ phase: "failed", completed: 0, total: 0, error: message });
      return { ok: false, code: cause.code, message, errors: cause.conflicts.map((conflict) => JSON.stringify(conflict)) };
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    report({ phase: "failed", completed: 0, total: 0, error: message });
    return { ok: false, code: "LOCAL_RELEASE_INVALID", message, errors: [message] };
  }
}

export async function installLocalPlugins(store: string, roots: LocalPluginRoot[], expectedPlanDigest: string): Promise<RegistryInstallRuntimeResult> {
  const active = roots.find(({ id }) => pluginInstallActive(pluginInstallProgress(id)[0]));
  if (active) return { ok: false, code: "INSTALL_IN_PROGRESS", message: `Plugin installation is already running: ${active.id}` };
  for (const { id } of roots) beginPluginInstall(id);
  const report = (progress: { phase: "resolving" | "staging" | "committing" | "installed" | "failed"; completed: number; total: number; componentId?: string; error?: string }) => {
    for (const { id } of roots) {
      const value = { pluginId: id, ...progress };
      setPluginInstallProgress(value);
      publishActivity("plugin.install.progress", "core", value);
    }
  };
  try {
    const { plan, references } = await resolveLocalPlugins(store, roots);
    if (plan.digest !== expectedPlanDigest) { report({ phase: "failed", completed: 0, total: plan.releases.length, error: "local release closure changed after planning" }); return { ok: false, code: "LOCAL_INSTALL_PLAN_CHANGED", message: "local release closure changed after planning" }; }
    const result = await installCertifiedRegistryReleases({ sourceId: "local", localStore: store, roots: references, releases: plan.releases, onProgress: report });
    if (result.ok) { await reconcileEnvironmentRevision(result.revision); report({ phase: "installed", completed: plan.releases.length, total: plan.releases.length }); }
    else report({ phase: "failed", completed: 0, total: plan.releases.length, error: result.message });
    return result;
  } catch (cause) {
    if (cause instanceof DependencyVersionConflict) {
      const message = cause.message;
      report({ phase: "failed", completed: 0, total: 0, error: message });
      return { ok: false, code: cause.code, message, errors: cause.conflicts.map((conflict) => JSON.stringify(conflict)) };
    }
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
