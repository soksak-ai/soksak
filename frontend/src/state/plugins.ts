// Plugin store — the single store for scan/install/consent/activation state (symmetric with the theme store).
//   - Validation: parseManifest (single truth for the spec) is all-or-nothing — bad entries surface as rejected.
//   - Consent (§0-5): a human consent record is required before activation. A version/permission change requires re-consent.
//   - Active instances (module/Disposable — not serializable) are kept in loader's Map; this file holds only
//     serializable runtime state (the shape plugin.list returns unchanged).

import { moduleState } from "../lib/moduleState";
import { create } from "zustand";
import { invoke, unitFileUrl } from "../framework";
import { bootFactPayload } from "../lib/bootFact";
import { createCoreSync } from "./coreSync";
import type { CoreStoreDeps } from "./coreStore";
import {
  parseManifest,
  scanHostChromeViolations,
  semverGte,
  type LibraryDep,
  type PluginManifest,
  type PluginPermission,
} from "../plugins/spec";
import {
  activateContractPlugin,
  activatePlugin,
  deactivateAll,
  deactivateById,
  importPluginModule,
  isActive,
  setActive,
} from "../plugins/loader";
import { syncServiceLedger } from "../plugins/serviceProxy";
import { defaultPluginDeps } from "../plugins/deps";
import {
  activationChain,
  cascadeRemovalSet,
  transitiveDependents,
  activationLevels,
  type DepNode,
} from "../plugins/dependencyGraph";
import { publishActivity } from "./activityFeed";
import { err, ok, type CmdResult } from "./sessions";
import { tmsg } from "../i18n";

// Installed/dev runtime → dependency graph nodes (from manifest dependencies). Consumed by the resolver.
function pluginDepNodes(plugins: Record<string, PluginRuntime>): DepNode[] {
  return Object.values(plugins).map((p) => ({
    id: p.manifest.id,
    version: p.manifest.version,
    dependencies: p.manifest.dependencies ?? {},
  }));
}
import { installCommandFor, detectPlatform } from "../plugins/programRegistry";
import {
  reconcilePlan,
  parseProbeVersion,
  type ReachExec,
  type Observed,
} from "../plugins/runtimeDep";

export interface PluginRuntime {
  manifest: PluginManifest;
  dir: string;
  source: "installed" | "dev";
  status: "disabled" | "enabled" | "error";
  error?: string;
}

export interface UnitDevSource {
  kind: "plugin" | "sidecar" | "kit";
  id: string;
  source: string;
}

export interface RejectedPlugin {
  dir: string;
  errors: string[];
}

export interface ConsentRecord {
  version: string;
  permissions: PluginPermission[];
}

interface PluginScanEntry {
  dir: string;
  dir_name: string;
  manifest: string | null;
  // Raw .soksak.json — the official install state.
  state: string | null;
  error: string | null;
}

interface PluginsState {
  appVersion: string; // filled by initPluginHost ("0.0.0" = unverified)
  release: boolean; // release core identity — selects the app updater channel. Independent of whether unit development is allowed.
  plugins: Record<string, PluginRuntime>;
  rejected: RejectedPlugin[];
  consents: Record<string, ConsentRecord>; // persisted to localStorage
  enabledIds: string[]; // persisted to localStorage — re-activation targets on restart
  reload: () => Promise<void>;
  // Reload by id — re-reads that plugin's manifest from disk and enables it with fresh code.
  reloadOne: (id: string) => Promise<CmdResult<{ id: string; status: string }>>;
  // cascade:true removes transitive dependents too. Omitted while dependents exist is blocked with CASCADE_REQUIRED.
  remove: (
    id: string,
    opts?: { cascade?: boolean },
  ) => Promise<CmdResult<{ id: string; removed?: string[] }>>;
  enable: (id: string) => Promise<CmdResult<{ id: string; status: string }>>;
  disable: (id: string) => Promise<CmdResult<{ id: string; status: string }>>;
  // Consent record — called by the UI (consent modal) only. Not exposed as a command (§0-5).
  grantConsent: (id: string) => boolean;
  // Revoke consent — a safe permission-reducing operation (back to re-consent required). Deactivates if active. Command exposure allowed.
  revokeConsent: (id: string) => Promise<CmdResult<{ id: string }>>;
  devLoad: (path: string, expectedId?: string) => Promise<CmdResult<{ id: string; dir: string }>>;
  // bind ledger sync (PS9) — derived from enabled ∧ service manifests and pushed to the core (idempotent).
  syncLedger: () => Promise<void>;
}

const KEY = "soksak.plugins";

type PluginsBlob = {
  consents: Record<string, ConsentRecord>;
  enabledIds: string[];
};
const EMPTY_PLUGINS: PluginsBlob = { consents: {}, enabledIds: [] };

// app.data authority + ls sync cache (coreSync) — consents/enabledIds consistent across windows (with ls alone,
// windows went stale and re-consent/re-enable got confused). set on authority arrival (activation itself stays in reload's reconcile — the existing model).
const pluginsSync = createCoreSync<PluginsBlob>({
  key: "plugins",
  lsKey: KEY,
  fallback: EMPTY_PLUGINS,
  apply: (v) =>
    usePlugins.setState({
      consents: v?.consents ?? {},
      enabledIds: Array.isArray(v?.enabledIds) ? v.enabledIds : [],
    }),
});
export const initPluginsPersistence = (deps: CoreStoreDeps): (() => void) =>
  pluginsSync.init(deps);

function loadPersisted(): PluginsBlob {
  const v = pluginsSync.loadSync();
  return {
    consents: v?.consents ?? {},
    enabledIds: Array.isArray(v?.enabledIds) ? v.enabledIds : [],
  };
}

function samePermissions(
  a: PluginPermission[],
  b: PluginPermission[],
): boolean {
  return (
    a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",")
  );
}

export function consentValid(
  consent: ConsentRecord | undefined,
  manifest: PluginManifest,
): boolean {
  return (
    !!consent &&
    consent.version === manifest.version &&
    samePermissions(consent.permissions, manifest.permissions)
  );
}

// Unmet consent chain for activation — id plus transitive dependencies still needing consent, in topological order (dependencies first).
// A dependency (core) can hold strong permissions (process etc.), so the UI opens a consent dialog per entry in
// this order (no half consent §0-2). dev sources are exempt from the gate (§0-5). Already-consented and dev entries are excluded.
export function pendingConsentChain(
  id: string,
  plugins: Record<string, PluginRuntime>,
  consents: Record<string, ConsentRecord>,
): string[] {
  return activationChain(id, pluginDepNodes(plugins)).filter((cid) => {
    const p = plugins[cid];
    return p && p.source !== "dev" && !consentValid(consents[cid], p.manifest);
  });
}

// CONSENT_REQUIRED message — states only the action this case needs, in plain prose, not the mechanism.
// When the only target is itself, name that alone; when dependencies are involved, list every target needing consent in order
// (the consent screen shows the dependency and permission detail — the message does not teach it).
export function consentRequiredMessage(id: string, pending: string[]): string {
  if (pending.length === 1 && pending[0] === id) return tmsg("plugin.consent.required", { id });
  return tmsg("plugin.consent.requiredChain", { id, pending: pending.join(", ") });
}

// Program ensure (§2.6) — guarantees prerequisite binaries at activation time. Checks the user's
// login shell PATH (shell_which) and, when one is missing, publishes the fact and the exact command
// that installs it (no hiding — the command shown on the consent screen).
//
// It opened a terminal tab and ran the command there until 2026-08-16, resolving a contract id the
// core spelled out. Where a command runs is not the core's decision, and a plugin's own spec is not
// the core's to name (PLUGIN-CONTRACT P5). The fact goes into the activity stream, which every
// window, plugin and CLI reads; whoever wants to run it can, and a person who reads it can too.
// Failures go to the console only (§0-4 — plugin activation itself is not blocked).
async function ensureProgramBinaries(manifest: PluginManifest): Promise<void> {
  for (const prog of manifest.contributes.programs) {
    if (!prog.ensure) continue;
    const install = installCommandFor(prog);
    if (!install) continue; // no install command for this platform
    try {
      const found = await invoke<boolean>("shell_which", {
        bin: prog.ensure.bin,
      });
      if (found) continue;
      publishActivity("program.missing", "plugins", {
        plugin: manifest.id,
        program: prog.id,
        bin: prog.ensure.bin,
        install,
        message: tmsg("plugin.program.missing", { bin: prog.ensure.bin, install }),
      });
    } catch (e) {
      console.error(`ensure failed (${manifest.id}/${prog.id}):`, e);
    }
  }
}

// Transitive collection of library dependencies (§libraries) — libraries of this manifest plus transitive plugin deps.
// Enabling a plugin that depends on the plugin owning a library (e.g. core) still guarantees that CLI.
// Deduplicated by bin (never install the same CLI twice). plugins key = install directory name = plugin id.
export function transitiveLibraries(
  manifest: PluginManifest,
  plugins: Record<string, PluginRuntime>,
): LibraryDep[] {
  const seenBin = new Set<string>();
  const seenPlugin = new Set<string>();
  const out: LibraryDep[] = [];
  const visit = (m: PluginManifest) => {
    if (seenPlugin.has(m.id)) return; // cycle guard
    seenPlugin.add(m.id);
    for (const lib of m.libraries ?? []) {
      if (!seenBin.has(lib.bin)) {
        seenBin.add(lib.bin);
        out.push(lib);
      }
    }
    for (const depId of Object.keys(m.dependencies ?? {})) {
      const dep = plugins[depId];
      if (dep) visit(dep.manifest);
    }
  };
  visit(manifest);
  return out;
}

// Library dependency reconcile — converges transitive libraries to the 4-tuple at activation (no hiding, §0-4 non-blocking).
//   observe (binary_integrity present/partial/broken + working/version via observe.probe)
//   → pure decision (reconcilePlan: classifyHealth/accept/nextAction + reach selection)
//   → reach (command=visible install / fetch=download_verify / vendor=verify_and_link, sha256 verified).
// PARTIAL/BROKEN reach after cleanup_stale — the root fix for yesterday's EEXIST. Failures go to the console only (activation is not blocked).
// spawnInstall is a parameter — never grab useSessions internally (testable structure, J4).
async function reconcileDependencies(
  manifest: PluginManifest,
  plugins: Record<string, PluginRuntime>,
  spawnInstall: (command: string) => void,
): Promise<void> {
  const libs = transitiveLibraries(manifest, plugins);
  const platform = detectPlatform();
  const pluginDir = plugins[manifest.id]?.dir;
  // Resolve the npm global dir — when known, observe precisely with binary_integrity (present/partial/broken); otherwise shell_which fallback.
  let npm: { bin_dir: string; lib_dir: string } | null = null;
  try {
    npm = await invoke<{ bin_dir: string; lib_dir: string }>("npm_global_dirs");
  } catch {
    npm = null;
  }
  for (const lib of libs) {
    try {
      const observed = await observeDep(lib, npm);
      const step = reconcilePlan(lib, observed, platform);
      if (step.action === "noop" || !step.reach) continue;
      if (step.action === "cleanup-then-reach" && npm) {
        // PARTIAL/BROKEN — reach after clearing stale files (the root fix for yesterday's EEXIST). Whitelisted paths only.
        await invoke("cleanup_stale", {
          path: `${npm.bin_dir}/${lib.bin}`,
          allowedRoots: [npm.bin_dir, `${npm.lib_dir}/node_modules`],
        }).catch((e) => console.error(`cleanup failed (${lib.bin}):`, e));
      }
      await execReach(step.reach, lib, npm, pluginDir, spawnInstall);
    } catch (e) {
      console.error(`library reconcile failed (${manifest.id}/${lib.bin}):`, e);
    }
  }
}

// Observe — with the npm dir known, binary_integrity (present/partial/broken); otherwise shell_which (present) only.
// When present and observe.probe is declared, run it (probe) to observe working/version (present != working).
// Without observe.probe, present approximates working (legacy dep — no working predicate).
async function observeDep(
  lib: LibraryDep,
  npm: { bin_dir: string; lib_dir: string } | null,
): Promise<Observed> {
  if (!npm) {
    const present = await invoke<boolean>("shell_which", { bin: lib.bin }).catch(() => false);
    if (!present || !lib.observe) {
      return { present, working: present, partial: false, broken: false };
    }
    const p = await probeDep(lib.bin, lib.observe); // name → Command searches PATH
    return { present, working: p.ok, partial: false, broken: false, version: p.version };
  }
  const it = await invoke<{ present: boolean; partial: boolean; broken: boolean }>(
    "binary_integrity",
    { binPath: `${npm.bin_dir}/${lib.bin}`, libPath: `${npm.lib_dir}/node_modules/${lib.name}` },
  );
  if (!it.present || !lib.observe) {
    return { present: it.present, working: it.present, partial: it.partial, broken: it.broken };
  }
  const p = await probeDep(`${npm.bin_dir}/${lib.bin}`, lib.observe);
  return { present: it.present, working: p.ok, partial: it.partial, broken: it.broken, version: p.version };
}

// Run observe.probe — probe argv[0] is the bin (replaced with the absolute binPath), the rest are arguments.
// exit 0 = working. The version is extracted from stdout by the pure parseProbeVersion with versionRe.
async function probeDep(
  binPath: string,
  observe: NonNullable<LibraryDep["observe"]>,
): Promise<{ ok: boolean; version?: string }> {
  const args = observe.probe.slice(1);
  const r = await invoke<{ ok: boolean; stdout: string }>("probe_binary", {
    bin: binPath,
    args,
  }).catch(() => ({ ok: false, stdout: "" }));
  return { ok: r.ok, version: parseProbeVersion(r.stdout, observe.versionRe) };
}

// Run reach — command=visible terminal install, fetch=download_verify (download + sha256), vendor=verify_and_link (bundle + sha256).
async function execReach(
  reach: ReachExec,
  lib: LibraryDep,
  npm: { bin_dir: string; lib_dir: string } | null,
  pluginDir: string | undefined,
  spawnInstall: (command: string) => void,
): Promise<void> {
  if (reach.kind === "command") {
    spawnInstall(`${reach.command}; echo "[soksak] ${tmsg("plugin.library.installDone", { bin: lib.bin })}"`);
    return;
  }
  if (!npm) {
    console.error(`npm dir unresolved — skipping ${lib.bin} ${reach.kind} reach`);
    return;
  }
  const dest = `${npm.bin_dir}/${lib.bin}`;
  if (reach.kind === "fetch") {
    await invoke("download_verify", { url: reach.url, dest, sha256: reach.sha256 });
  } else {
    if (!pluginDir) {
      console.error(`plugin dir unresolved — skipping ${lib.bin} vendor reach`);
      return;
    }
    await invoke("verify_and_link", {
      src: `${pluginDir}/${reach.vendorPath}`,
      dest,
      sha256: reach.sha256,
    });
  }
}

function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

// The store is outside the module boundary — if hot swap replaces it, registration, subscription and view state all
// become new, while the filling side treats them as already filled and never refills (empty forever).
/** One load step — the machine answers where the time goes.
 *
 * Measured 2026-08-08: 760ms between `painted` and the first plugin activation, with no split point inside it.
 * With only the total, "boot stutters" can be reported by eye alone.
 */
/** Bundles prefetched in this load — activation uses these first. */
const prefetchedSources = new Map<string, string>();

function reloadStep(step: string): void {
  void invoke("activity_publish", {
    kind: "boot.step",
    source: "boot",
    payload: bootFactPayload(`plugins:${step}`),
  }).catch(() => {});
}

export const usePlugins = moduleState("state/plugins#store", () =>
  create<PluginsState>((set, get) => {
  const persisted = loadPersisted();

  const persist = () => {
    const s = get();
    pluginsSync.save({ consents: s.consents, enabledIds: s.enabledIds });
  };

  const setRuntime = (id: string, patch: Partial<PluginRuntime>) => {
    set((s) => {
      const cur = s.plugins[id];
      if (!cur) return s;
      return { plugins: { ...s.plugins, [id]: { ...cur, ...patch } } };
    });
  };

  // Raw manifest → runtime (validation passed) or a rejected reason.
  const parseRuntime = (
    rawText: string,
    dir: string,
    dirName: string,
    source: "installed" | "dev",
    rejected: RejectedPlugin[],
  ): PluginRuntime | null => {
    let raw: unknown;
    try {
      raw = JSON.parse(rawText);
    } catch (e) {
      rejected.push({ dir, errors: [tmsg("plugin.manifest.parseFailed", { error: String(e) })] });
      return null;
    }
    const { manifest, validation } = parseManifest(raw, dirName);
    if (!manifest) {
      rejected.push({ dir, errors: validation.errors });
      return null;
    }
    const appVersion = get().appVersion;
    if (manifest.minAppVersion) {
      if (appVersion === "0.0.0") {
        console.warn(
          `app version unverified — skipping the minAppVersion(${manifest.minAppVersion}) check for ${manifest.id}`,
        );
      } else if (semverGte(appVersion, manifest.minAppVersion) === false) {
        rejected.push({
          dir,
          errors: [
            tmsg("plugin.manifest.appVersionTooLow", {
              required: manifest.minAppVersion,
              current: appVersion,
            }),
          ],
        });
        return null;
      }
    }
    return { manifest, dir, source, status: "disabled" };
  };

  // Load entry → activate → keep the instance. Failure throws (the caller records status).
  const activateRuntime = async (p: PluginRuntime): Promise<void> => {
    // Pure contract plugin (PS4, docs/PLUGIN-SERVICE.md) — activates without an entry. No code load and no chrome
    // scan (parseManifest enforces zero code-requiring contributions) — gate + data contributions + service proxy.
    if (p.manifest.entry === null) {
      const instance = await activateContractPlugin(
        p.manifest,
        p.dir,
        defaultPluginDeps(get().appVersion),
      );
      setActive(p.manifest.id, instance);
      return;
    }
    // Use the prefetched bundle when there is one — fetch only when absent (single reload / dev source swap path).
    const readStart = performance.now();
    const prefetched = prefetchedSources.get(p.manifest.id);
    const data = prefetched !== undefined
      ? { content: prefetched }
      : { content: await (await fetch(await unitFileUrl(`${p.dir}/${p.manifest.entry}`))).text() };
    if (prefetched === undefined) {
      reloadStep(`read:${p.manifest.id}:${Math.round(performance.now() - readStart)}ms:${data.content.length}b`);
    }
    // Chrome standard gate — bundle CSS overriding host chrome selectors/variables breaks tab alignment. Obvious static
    // violations are rejected (no silent failure). Applied only to plugins with sidebar/content views — viewless plugins do not touch chrome.
    if (p.manifest.contributes.views.length > 0) {
      const violations = scanHostChromeViolations(data.content);
      if (violations.length > 0) {
        throw new Error(
          tmsg("plugin.chrome.violation", {
            id: p.manifest.id,
            violations: violations.join(", "),
          }),
        );
      }
    }
    const moduleAt = performance.now();
    const module = await importPluginModule(data.content);
    reloadStep(`module:${p.manifest.id}:${Math.round(performance.now() - moduleAt)}ms`);
    const instance = await activatePlugin(
      module,
      p.manifest,
      p.dir,
      defaultPluginDeps(get().appVersion),
      data.content,
    );
    setActive(p.manifest.id, instance);
  };

  // Single removal — dev from the list only, installed from disk as well. Clears consent/enabled. The unit of cascade.
  // No reload here (the cascade caller runs one at the end of the loop) — so the graph does not shift mid-loop.
  const removeSingle = async (id: string): Promise<CmdResult<{ id: string }>> => {
    const p = get().plugins[id];
    if (!p) return err("TARGET_NOT_FOUND", tmsg("plugin.notFound", { id }));
    if (p.source === "dev") {
      if (isActive(id)) await deactivateById(id);
      try {
        // The workspace is the user's source, so it is not deleted. Only the selection is cleared, so the next reload
        // does not bring it back, and a separate official install takes over when one exists.
        await invoke("unit_source_remove", { kind: "plugin", id });
      } catch (e) {
        return err("INTERNAL", tmsg("plugin.dev.deselectFailed", { error: String(e) }));
      }
      set((s) => {
        const plugins = { ...s.plugins };
        delete plugins[id];
        return { plugins, enabledIds: s.enabledIds.filter((x) => x !== id) };
      });
      persist();
      return ok({ id });
    }
    if (isActive(id)) await get().disable(id);
    await invoke("plugin_remove", { id });
    set((s) => {
      const consents = { ...s.consents };
      delete consents[id];
      return { consents, enabledIds: s.enabledIds.filter((x) => x !== id) };
    });
    persist();
    return ok({ id });
  };

  return {
    appVersion: "0.0.0",
    release: false,
    plugins: {},
    rejected: [],
    consents: persisted.consents,
    enabledIds: persisted.enabledIds,

    // bind ledger sync (PS9, docs/PLUGIN-SERVICE.md) — derived from manifests that are enabled and declare
    // service, then pushed to the core. Same result from any window (the core no-ops when the content is identical).
    // Once after each state transition (reload/enable/disable/revoke) — event-driven, zero polling.
    syncLedger: async () => {
      try {
        const manifests = Object.values(get().plugins)
          .filter((p) => p.status === "enabled" && p.manifest.service !== undefined)
          .map((p) => p.manifest);
        await syncServiceLedger(manifests, (cmd, args) => invoke(cmd, args));
      } catch (e) {
        console.error("[service] bind ledger sync failed:", e);
      }
    },

    reload: async () => {
      // Full restart: deactivate every active instance and rescan — no partial state (§0-3).
      await deactivateAll();
      reloadStep("deactivated");
      const entries = await invoke<PluginScanEntry[]>("plugin_scan");
      reloadStep(`scanned:${entries.length}`);
      const rejected: RejectedPlugin[] = [];
      const next: Record<string, PluginRuntime> = {};

      for (const e of entries) {
        if (e.manifest == null) {
          // A folder with neither a manifest nor .soksak.json (install/dev state) is not a plugin at all —
          // it is a core tool (validation CLI etc.) or a stray folder under the plugin folder. Skip it quietly (not an error).
          // State present but manifest missing is a genuinely broken install, so surface it as rejected (no silence).
          if (e.state == null) continue;
          rejected.push({ dir: e.dir, errors: [e.error ?? tmsg("plugin.manifest.missing")] });
          continue;
        }
        const rt = parseRuntime(e.manifest, e.dir, e.dir_name, "installed", rejected);
        if (rt) next[rt.manifest.id] = rt;
      }

      // A declared development source is separate from the install and explicitly overrides the official install of the same id.
      // config is canonical, so all three environments restore the same way after an app restart.
      const developmentUnits =
        (await invoke<UnitDevSource[]>("unit_source_list")) ?? [];
      reloadStep(`units:${developmentUnits.length}`);
      for (const unit of developmentUnits) {
        if (unit.kind !== "plugin") continue;
        try {
          const data = await invoke<{ content: string }>("read_text_file", {
            path: `${unit.source}/plugin.json`,
          });
          const rt = parseRuntime(
            data.content,
            unit.source,
            unit.id,
            "dev",
            rejected,
          );
          // The development source masks the same-named install. On failure, drop the installed candidate for that
          // id too, so it does not silently fall back to the official install.
          if (!rt) delete next[unit.id];
          if (rt) next[rt.manifest.id] = rt;
        } catch (e2) {
          delete next[unit.id];
          rejected.push({
            dir: unit.source,
            errors: [tmsg("plugin.dev.readFailed", { error: String(e2) })],
          });
        }
      }

      set({ plugins: next, rejected });

      // Re-activate the enabled list whose consent is valid. Failure shows in status (§0-4 — no silence).
      // Walk the gates (template, consent) first, then raise the activation targets concurrently per dependency
      // level — so IPC reads and in-plugin waits overlap, against 2.4s total for 46 sequential (measured). Levels
      // (activationLevels) guarantee "dependencies first", and failure isolation stays per-plugin try (§0-4).
      const ready: string[] = [];
      for (const id of get().enabledIds) {
        const p = get().plugins[id];
        if (!p) continue;
        // Templates are never activated (the enable gate keeps them out of enabledIds; this guards the case
        // where an install turned into a template).
        if (p.manifest.template) {
          setRuntime(id, { status: "disabled", error: undefined });
          continue;
        }
        // Consent gate — covers transitive dependencies too (a dependency's terms change makes dependents re-consent).
        // dev sources are exempt (§0-5 exception — same rule as enable).
        const pending = pendingConsentChain(id, get().plugins, get().consents);
        if (pending.length > 0) {
          setRuntime(id, {
            status: "disabled",
            error: tmsg("plugin.consent.reconsentRequired", { pending: pending.join(", ") }),
          });
          continue;
        }
        ready.push(id);
      }
      // The webview fetches bundles directly.
      //
      // The wait equals the bytes moved. Measured 2026-08-08: batching 34 reads into one call left 818ms
      // unchanged — the cost was volume, not round trips (about 15MB of 23.8MB crossed the process boundary as
      // strings). The engine reads the same files through its own resource load path, which has no serialization.
      //
      // Failures stay per file — one missing file leaves the rest loaded. Reading "could not read" as "no
      // content" kills the whole plugin, so unread files are not stored.
      const prefetchAt = performance.now();
      const wanted = ready
        .map((id) => get().plugins[id])
        .filter((p): p is PluginRuntime => !!p && p.manifest.entry !== null)
        .map((p) => ({ id: p.manifest.id, path: `${p.dir}/${p.manifest.entry}` }));
      // Read and not read are different shapes. Representing an unread file as empty content kills the whole
      // plugin, and that death reads as "the bundle was empty".
      type Bundle = { id: string; content: string } | { id: string; why: string };
      const fetched: Bundle[] = await Promise.all(
        wanted.map(async (w): Promise<Bundle> => {
          try {
            const res = await fetch(await unitFileUrl(w.path));
            if (!res.ok) return { id: w.id, why: `HTTP ${res.status}` };
            return { id: w.id, content: await res.text() };
          } catch (error) {
            return { id: w.id, why: error instanceof Error ? error.message : String(error) };
          }
        }),
      );
      const sources = prefetchedSources;
      sources.clear();
      for (const row of fetched) {
        if ("content" in row) sources.set(row.id, row.content);
      }
      // Unread files are recorded with the reason. With only a 0, a blocked channel and a missing file are
      // indistinguishable, and activation quietly proceeds reading each bundle one by one, slower.
      const failed = fetched.filter((row): row is { id: string; why: string } => "why" in row);
      const firstFailure = failed[0];
      if (firstFailure) {
        reloadStep(`prefetch-failed:${failed.length}:${firstFailure.why.slice(0, 80)}`);
      }
      reloadStep(`prefetched:${sources.size}/${wanted.length}:${Math.round(performance.now() - prefetchAt)}ms`);
      // Instrumentation (boot.step) — the boot bottleneck is per-plugin activation time (restore is 300ms).
      const bootT0 = performance.now();
      const perPlugin: Array<[string, number]> = [];
      for (const level of activationLevels(ready, pluginDepNodes(get().plugins))) {
        await Promise.all(
          level.map(async (id) => {
            const p = get().plugins[id];
            if (!p) return;
            try {
              const t = performance.now();
              await activateRuntime(p);
              perPlugin.push([id, Math.round(performance.now() - t)]);
              setRuntime(id, { status: "enabled", error: undefined });
            } catch (e) {
              setRuntime(id, {
                status: "error",
                error: e instanceof Error && e.stack ? e.stack : String(e),
              });
            }
          }),
        );
      }
      {
        const total = Math.round(performance.now() - bootT0);
        const top = [...perPlugin].sort((x, y) => y[1] - x[1]).slice(0, 12);
        void invoke("activity_publish", {
          kind: "boot.step",
          source: "boot",
          payload: bootFactPayload("plugin-activate", {
            ms: total,
            top: top.map(([id, ms]) => `${id}:${ms}`),
            origin: "internal",
          }),
        }).catch(() => {});
      }
      await get().syncLedger();
    },

    remove: async (id, opts) => {
      const p = get().plugins[id];
      if (!p) return err("TARGET_NOT_FOUND", tmsg("plugin.notFound", { id }));
      // Transitive dependent check — what loses its reference once this plugin is gone. Blocked without cascade consent.
      const nodes = pluginDepNodes(get().plugins);
      const dependents = transitiveDependents(id, nodes);
      if (dependents.length > 0 && !opts?.cascade) {
        return err(
          "CASCADE_REQUIRED",
          tmsg("plugin.remove.cascadeRequired", {
            id,
            dependents: dependents.join(", "),
          }),
        );
      }
      // Removal order — farthest (leaf) dependents first, the target last. Safe with dev mixed in (removeSingle branches).
      const order = opts?.cascade ? cascadeRemovalSet(id, nodes) : [id];
      const removed: string[] = [];
      for (const rid of order) {
        const res = await removeSingle(rid);
        if (!res.ok) return res; // partial progress — return the structured reason (no silence)
        removed.push(rid);
      }
      // Both installed removal and development deselection rescan once. The latter must return immediately to the
      // separately kept official install, and the workspace itself is not deleted.
      await get().reload();
      return ok({ id, removed });
    },

    enable: async (id) => {
      const p = get().plugins[id];
      if (!p) return err("TARGET_NOT_FOUND", tmsg("plugin.notFound", { id }));
      // Templates (read-only) are not activation targets — the UI hides the toggle, and the command path
      // (sok/MCP) is blocked too (a single gate).
      if (p.manifest.template) {
        return err("INVALID_PARAMS", tmsg("plugin.template.notEnableable", { id }));
      }
      if (p.status === "enabled" && isActive(id)) {
        return ok({ id, status: "enabled" }); // idempotent
      }
      // Consent gate — checks transitive dependencies too (the user must see a dependency's strong permissions).
      // dev sources are exempt (§0-5 exception — the load command is the gate). With an unconsented chain, return that
      // list so the UI opens consent dialogs in dependency-first order (no half consent).
      const pending = pendingConsentChain(id, get().plugins, get().consents);
      if (pending.length > 0) {
        return err("CONSENT_REQUIRED", consentRequiredMessage(id, pending), {
          pendingConsent: pending,
        });
      }
      // Activate dependencies first (cascade) — in activationChain order, only inactive and consented ones. Dependencies are ready first.
      const chain = activationChain(id, pluginDepNodes(get().plugins));
      for (const cid of chain) {
        const cp = get().plugins[cid];
        if (!cp) continue; // uninstalled dependency (install flow is separate) — skipped
        if (cp.status === "enabled" && isActive(cid)) continue; // already active
        try {
          await activateRuntime(cp);
        } catch (e) {
          setRuntime(cid, { status: "error", error: String(e) });
          throw e; // the command layer converts it to INTERNAL; the UI shows it as status.
        }
        setRuntime(cid, { status: "enabled", error: undefined });
        if (!get().enabledIds.includes(cid)) {
          set((s) => ({ enabledIds: [...s.enabledIds, cid] }));
        }
        // Program and library ensure (§2.6) — at activation time, exactly the command shown on the consent screen.
        void ensureProgramBinaries(cp.manifest);
        void reconcileDependencies(cp.manifest, get().plugins, (command) => {
          // Same rule as ensureProgramBinaries: the fact and the command, published. Where it runs
          // is not decided here.
          publishActivity("library.missing", "plugins", {
            plugin: cid,
            install: command,
            message: tmsg("plugin.library.missing", { install: command }),
          });
        });
      }
      persist();
      await get().syncLedger();
      return ok({ id, status: "enabled" });
    },

    disable: async (id) => {
      const p = get().plugins[id];
      if (!p) return err("TARGET_NOT_FOUND", tmsg("plugin.notFound", { id }));
      await deactivateById(id);
      setRuntime(id, { status: "disabled", error: undefined });
      set((s) => ({ enabledIds: s.enabledIds.filter((x) => x !== id) }));
      persist();
      await get().syncLedger();
      return ok({ id, status: "disabled" });
    },

    grantConsent: (id) => {
      const p = get().plugins[id];
      if (!p) return false;
      set((s) => ({
        consents: {
          ...s.consents,
          [id]: {
            version: p.manifest.version,
            permissions: [...p.manifest.permissions],
          },
        },
      }));
      persist();
      return true;
    },

    // Revoke consent — removes the consent record (back to re-consent required). Deactivates if active, and also
    // deactivates dependents using this plugin as a dependency (an unconsented dependency must not leave dependents up — transitive consistency). Safe: permissions shrink.
    revokeConsent: async (id) => {
      const p = get().plugins[id];
      if (!p) return err("TARGET_NOT_FOUND", tmsg("plugin.notFound", { id }));
      // Deactivate itself plus transitive dependents (farthest first) — losing a dependency's consent puts dependents back into the re-consent flow.
      const affected = [...transitiveDependents(id, pluginDepNodes(get().plugins)), id];
      for (const aid of affected) {
        if (isActive(aid)) await deactivateById(aid);
        setRuntime(aid, { status: "disabled", error: undefined });
      }
      set((s) => {
        const consents = { ...s.consents };
        delete consents[id];
        return {
          consents,
          enabledIds: s.enabledIds.filter((x) => !affected.includes(x)),
        };
      });
      persist();
      await get().syncLedger();
      return ok({ id });
    },

    // Reload one plugin — re-reads the manifest from disk. Enabling fresh code against a cached declaration makes
    // the commands that code newly registers get rejected as "undeclared command", and the author then suspects
    // memory instead of the file (measured). A bad file answers with the rejection reason instead of quietly enabling the old declaration.
    reloadOne: async (id) => {
      const p = get().plugins[id];
      if (!p) return err("TARGET_NOT_FOUND", tmsg("plugin.notFound", { id }));
      let content: string;
      try {
        const data = await invoke<{ content: string }>("read_text_file", {
          path: `${p.dir}/plugin.json`,
        });
        content = data.content;
      } catch (e) {
        return err("TARGET_NOT_FOUND", tmsg("plugin.manifest.readFailed", { error: String(e) }));
      }
      const rejected: RejectedPlugin[] = [];
      // A development checkout's folder name is not identity. As with first selection and full reload, use the
      // existing unit id from config as the expected value for validation.
      const expectedDirName = p.source === "dev" ? id : basename(p.dir);
      const fresh = parseRuntime(content, p.dir, expectedDirName, p.source, rejected);
      if (!fresh) {
        set({ rejected: [...get().rejected.filter((x) => x.dir !== p.dir), ...rejected] });
        return err(
          "INVALID_PARAMS",
          tmsg("plugin.manifest.validationFailed", {
            errors: rejected[0]?.errors.join("; ") ?? "",
          }),
        );
      }
      // A changed id on disk is a different plugin — this path does not swap it (that is the full rescan's job).
      if (fresh.manifest.id !== id) {
        return err(
          "INVALID_PARAMS",
          tmsg("plugin.manifest.idChanged", { id, freshId: fresh.manifest.id }),
        );
      }
      set((s) => ({
        plugins: { ...s.plugins, [id]: { ...fresh, status: p.status } },
        rejected: s.rejected.filter((x) => x.dir !== p.dir),
      }));
      await get().disable(id);
      return get().enable(id);
    },

    devLoad: async (path, expectedId) => {
      let selectedPath: string;
      try {
        selectedPath =
          (await invoke<string>("unit_source_validate", { source: path })) ?? path;
      } catch (e) {
        return err("INVALID_PARAMS", tmsg("plugin.dev.pathRejected", { error: String(e) }));
      }
      let content: string;
      try {
        const data = await invoke<{ content: string }>("read_text_file", {
          path: `${selectedPath}/plugin.json`,
        });
        content = data.content;
      } catch (e) {
        return err("TARGET_NOT_FOUND", tmsg("plugin.manifest.readFailed", { error: String(e) }));
      }
      const rejected: RejectedPlugin[] = [];
      // An external checkout's folder name may not be the unit id. A development source is an absolute path
      // declaration and identity comes from plugin.json, so basename is not used as a guessing rule.
      let declaredId = "";
      try {
        const raw = JSON.parse(content) as { id?: unknown };
        if (typeof raw.id === "string") declaredId = raw.id;
      } catch {
        // parseRuntime records the exact parse error for the same raw text in rejected.
      }
      const rt = parseRuntime(content, selectedPath, declaredId, "dev", rejected);
      if (!rt) {
        return err(
          "INVALID_PARAMS",
          tmsg("plugin.manifest.validationFailed", {
            errors: rejected[0]?.errors.join("; ") ?? "",
          }),
        );
      }
      const id = rt.manifest.id;
      if (expectedId !== undefined && id !== expectedId) {
        return err(
          "INVALID_PARAMS",
          tmsg("plugin.dev.idMismatch", { expected: expectedId, actual: id }),
        );
      }
      try {
        // Selection state comes from the identity home config, not the manifest version or the folder location.
        await invoke("unit_source_set", { kind: "plugin", id, source: selectedPath });
      } catch (e) {
        return err("INVALID_PARAMS", tmsg("plugin.dev.registerFailed", { error: String(e) }));
      }
      const wasEnabled = get().enabledIds.includes(id);
      if (isActive(id)) await deactivateById(id);
      set((s) => ({ plugins: { ...s.plugins, [id]: rt } }));
      // Previously enabled means automatic re-activation with fresh code — removes the dev loop (load→enable) gate.
      // dev sources are consent-exempt (§0-5), so consent standing is the same. Templates are not activation targets (same guard as reload).
      // A first-seen id (outside enabledIds) stays disabled — the first dev.load behaves as now.
      if (wasEnabled && !rt.manifest.template) {
        try {
          await activateRuntime(rt);
          setRuntime(id, { status: "enabled", error: undefined });
        } catch (e) {
          setRuntime(id, {
            status: "error",
            error: e instanceof Error && e.stack ? e.stack : String(e),
          });
        }
      }
      return ok({ id, dir: selectedPath });
    },
  };
}),
);
