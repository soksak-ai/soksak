import { invoke } from "../framework";
import { reconcileEnvironmentRevision } from "../state/environmentEvents";
import { publicReleaseMetadataGet } from "../state/registry";
import { loadReleaseClosure, type ReleaseMetadataGet } from "./registryReleaseClosure";
import { installCertifiedRegistryRelease, type RegistryInstallRuntimeResult } from "./registryInstallRuntime";
import { parseReleaseManifest, releaseIdentity, type ReleaseDocument, type ReleaseReference } from "./spec";
import { beginPluginInstall, setPluginInstallProgress } from "./registryInstallProgress";
import { publishActivity } from "../state/activityFeed";

interface LocalReleaseRead { found: boolean; body?: string; size?: number; sha256?: string }
interface InstalledPluginManifest { id: string; version: string; manifest: string | null }

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

async function readLocal(store: string, reference: Pick<ReleaseReference, "id" | "version">, kind: "plugin" | "sidecar"): Promise<LocalReleaseRead> {
  return invoke<LocalReleaseRead>("local_release_read", { store, kind, id: reference.id, version: reference.version });
}

async function localRoot(store: string, id: string, version: string, kind: "plugin" | "sidecar"): Promise<{ reference: ReleaseReference; body: string }> {
  const result = await readLocal(store, { id, version }, kind);
  if (!result.found || result.body === undefined || result.size === undefined || result.sha256 === undefined) throw new Error(`local ${kind} release is missing: ${id}@${version}`);
  const parsed = parseReleaseManifest(JSON.parse(result.body));
  if (!parsed.ok || parsed.value.kind !== kind || parsed.value.id !== id || parsed.value.version !== version) throw new Error(`local ${kind} release is invalid: ${id}@${version}`);
  return { reference: { id, version, url: `${parsed.value.source.repository}/releases/download/v${version}/release.json`, size: result.size, sha256: result.sha256 }, body: result.body };
}

export interface LocalInstallPlan { digest: string; store: string; id: string; version: string; releases: ReleaseDocument[] }

async function digestPlan(releases: ReleaseDocument[]): Promise<string> {
  const projection = releases.map((release) => ({ identity: releaseIdentity(release), artifacts: release.artifacts.map(({ target, size, sha256 }) => ({ target, size, sha256 })) }));
  const bytes = new TextEncoder().encode(JSON.stringify(projection));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function planLocalRelease(store: string, id: string, version: string, kind: "plugin" | "sidecar"): Promise<LocalInstallPlan> {
  const root = await localRoot(store, id, version, kind);
  let rootRead = false;
  const get: ReleaseMetadataGet = async (url) => {
    if (!rootRead && url === root.reference.url) { rootRead = true; return { status: 200, body: root.body }; }
    const match = /^https:\/\/github[.]com\/[^/]+\/([^/]+)\/releases\/download\/v([^/]+)\/release[.]json$/.exec(url);
    if (match) {
      const kind = match[1].startsWith("soksak-plugin-") ? "plugin" : "sidecar";
      const local = await readLocal(store, { id: match[1], version: match[2] }, kind);
      if (local.found) return { status: 200, body: local.body ?? "" };
    }
    return publicReleaseMetadataGet(url);
  };
  let releases: ReleaseDocument[];
  if (kind === "plugin") releases = await loadReleaseClosure(root.reference, get);
  else {
    const parsed = parseReleaseManifest(JSON.parse(root.body));
    if (!parsed.ok || parsed.value.kind !== "sidecar") throw new Error(`local Sidecar release is invalid: ${id}@${version}`);
    releases = [parsed.value];
  }
  return { digest: await digestPlan(releases), store, id, version, releases };
}

export const planLocalPlugin = (store: string, id: string, version: string) => planLocalRelease(store, id, version, "plugin");
export const planLocalSidecar = async (store: string, id: string, version: string) => {
  await requireSidecarCompatibleWithInstalledPlugins(id, version);
  return planLocalRelease(store, id, version, "sidecar");
};

export async function installLocalPlugin(store: string, id: string, version: string, expectedPlanDigest: string): Promise<RegistryInstallRuntimeResult> {
  if (!beginPluginInstall(id)) return { ok: false, code: "INSTALL_IN_PROGRESS", message: `Plugin installation is already running: ${id}` };
  const report = (progress: { phase: "resolving" | "staging" | "committing" | "installed" | "failed"; completed: number; total: number; componentId?: string; error?: string }) => {
    const value = { pluginId: id, ...progress };
    setPluginInstallProgress(value);
    publishActivity("plugin.install.progress", "core", value);
  };
  try {
    const plan = await planLocalPlugin(store, id, version);
    if (plan.digest !== expectedPlanDigest) { report({ phase: "failed", completed: 0, total: plan.releases.length, error: "local release closure changed after planning" }); return { ok: false, code: "LOCAL_INSTALL_PLAN_CHANGED", message: "local release closure changed after planning" }; }
    const root = plan.releases[0];
    if (!root || root.kind !== "plugin" || root.id !== id || root.version !== version) { report({ phase: "failed", completed: 0, total: plan.releases.length, error: "local Plugin root is invalid" }); return { ok: false, code: "LOCAL_INSTALL_ROOT_INVALID", message: "local Plugin root is invalid" }; }
    const rootReference = await localRoot(store, id, version, "plugin");
    const result = await installCertifiedRegistryRelease({ sourceId: "local", localStore: store, root: rootReference.reference, releases: plan.releases, onProgress: (progress) => report(progress) });
    if (result.ok) { await reconcileEnvironmentRevision(result.revision); report({ phase: "installed", completed: plan.releases.length, total: plan.releases.length }); }
    else report({ phase: "failed", completed: 0, total: plan.releases.length, error: result.message });
    return result;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    report({ phase: "failed", completed: 0, total: 0, error: message });
    return { ok: false, code: "LOCAL_RELEASE_INVALID", message, errors: [message] };
  }
}

export async function installLocalSidecar(store: string, id: string, version: string, expectedPlanDigest: string): Promise<RegistryInstallRuntimeResult> {
  try { await requireSidecarCompatibleWithInstalledPlugins(id, version); }
  catch (cause) {
    if (cause instanceof DependencyVersionConflict) return { ok: false, code: cause.code, message: cause.message, errors: [JSON.stringify(cause.conflict)] };
    throw cause;
  }
  const status = await invoke<{ open: Array<{ name: string }>; recorded: Array<{ name: string }> }>("sidecar_status");
  if ([...status.open, ...status.recorded].some((entry) => entry.name === id)) return { ok: false, code: "SIDECAR_IN_USE", message: `Sidecar ${id} is running or recorded; stop it explicitly before installation` };
  const plan = await planLocalSidecar(store, id, version);
  if (plan.digest !== expectedPlanDigest) return { ok: false, code: "LOCAL_INSTALL_PLAN_CHANGED", message: "local release closure changed after planning" };
  const root = await localRoot(store, id, version, "sidecar");
  const result = await installCertifiedRegistryRelease({ sourceId: "local", localStore: store, root: { ...root.reference, kind: "sidecar" }, releases: plan.releases });
  if (result.ok) await reconcileEnvironmentRevision(result.revision);
  return result;
}
