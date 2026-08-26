// Plugin service proxy — registers bind:"service" commands into the registry, synthesized from
// manifest data alone (PS3, PS11; normative docs/PLUGIN-SERVICE.md). No handler is hand-written —
// every one is a synthesis forwarding to service_dispatch (the core ServiceManager). Execution
// truth is ServiceManager alone: socket and schedule go straight to route(), only window-originated
// calls pass through this proxy into the same place.
// Proxy lifetime = plugin active lifetime (window loader, once) — independent of service restart
// (no re-registration).
import type { CommandSpec, ParamSpec } from "../commands/registry";
import {
  pluginCommandName,
  resolveText,
  serviceOps,
  type ContributedSchedule,
  type ExactReference,
  type PluginManifest,
} from "./spec";
import type { ContractRequirement } from "./spec";
import { runtimePluginRequirements } from "./runtimeDependencies";

export interface ServiceProxyDeps {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  registerCommand: (name: string, spec: CommandSpec) => void;
  unregisterCommand: (name: string) => boolean;
  locale: () => string;
}

// Synthesized spec — maps a manifest command declaration (ServiceCommandFields) to a registry
// CommandSpec. Only this synthesis sets envelope:"service" (PS7 — a seam not opened to plugin JS).
export function synthesizeServiceSpec(
  manifest: PluginManifest,
  name: string,
  deps: ServiceProxyDeps,
): CommandSpec | null {
  const declared = manifest.contributes.commands.find((c) => c.name === name);
  if (!declared || declared.bind !== "service") return null;
  const full = pluginCommandName(manifest.id, name);
  return {
    description: declared.description ?? "",
    ...(declared.triggers ? { triggers: declared.triggers } : {}),
    params: (declared.params ?? {}) as Record<string, ParamSpec>,
    title: declared.title,
    returns: declared.returns ?? "object",
    ...(declared.danger ? { danger: declared.danger } : {}),
    envelope: "service",
    // Fallback when the wire message is absent = the human label (MESSAGE-PROTOCOL §3 degradation rule).
    message: () => resolveText(declared.title, deps.locale()),
    handler: async (params, ctx) =>
      (await deps.invoke("service_dispatch", {
        method: full,
        params,
        parent: ctx?.parent,
        origin: ctx?.origin,
      })) as Record<string, unknown>,
  } as CommandSpec;
}

// Registers every bind:"service" command and returns a bulk unregister function (tracker.wrap
// convention). markRegistered marks the synthesized proxy as actual in the declared≡actual
// inventory (conformance) — the proxy is the registration, so it is not misreported as
// declared-but-not-registered.
export function registerServiceProxies(
  manifest: PluginManifest,
  deps: ServiceProxyDeps,
  markRegistered?: (bareName: string) => void,
): () => void {
  const names: string[] = [];
  for (const c of manifest.contributes.commands) {
    if (c.bind !== "service") continue;
    const spec = synthesizeServiceSpec(manifest, c.name, deps);
    if (!spec) continue;
    const full = pluginCommandName(manifest.id, c.name);
    deps.registerCommand(full, spec);
    markRegistered?.(c.name);
    names.push(full);
  }
  return () => {
    for (const full of names.splice(0).reverse()) deps.unregisterCommand(full);
  };
}

// ── bus→service bridge (PS15) ──────────────────────────────────────────────────
// Collects the bus topics a service declared in hello subscribe[] from this window's bus and
// sends them to the core (service_bus_push). The core dedups by seq and pushes once to the
// subscribing service. When several windows react to the same change and publish the same topic,
// the dedupKey in the publish payload (a logical revision supplied by the plugin) removes the
// cross-window duplicates — without it every publish goes up and the service absorbs them
// (a subscription is a trigger).
export interface BusBridgeDeps {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  busOn: (topic: string, fn: (payload: unknown) => void) => () => void;
}

export function registerBusBridge(
  manifest: PluginManifest,
  deps: BusBridgeDeps,
): () => void {
  const svc = manifest.service;
  const offs: Array<() => void> = [];
  for (const sub of svc?.subscribe ?? []) {
    // Declaration form is "bus:<topic>" (service.ts SUBSCRIBE_RE) — the actual bus-axis topic drops the prefix.
    const busTopic = sub.startsWith("bus:") ? sub.slice("bus:".length) : sub;
    offs.push(
      deps.busOn(busTopic, (payload) => {
        const dedupKey =
          payload && typeof payload === "object" && typeof (payload as { dedupKey?: unknown }).dedupKey === "string"
            ? (payload as { dedupKey: string }).dedupKey
            : undefined;
        void deps.invoke("service_bus_push", {
          topic: sub,
          payload: payload ?? {},
          ...(dedupKey !== undefined ? { dedupKey } : {}),
        });
      }),
    );
  }
  return () => {
    for (const off of offs.splice(0).reverse()) off();
  };
}

// ── bind ledger derivation (PS9) ───────────────────────────────────────────────
// The ledger is derived: the source is the manifest (the verdict of the single judge
// parseManifest) plus the enabled/consent state. Only the already-judged subset is extracted here
// and sent down to the core (service_ledger_sync).

interface LedgerSchedule {
  name: string;
  command: string;
  params?: Record<string, unknown>;
  trigger: ContributedSchedule["trigger"];
  timeoutMs?: number;
  zombieBackstopMs?: number;
}

export interface LedgerServiceBinding {
  plugin: string;
  sidecar: ExactReference;
  interface: ContractRequirement;
  ops: string[];
  subscribe: string[];
  schedules: LedgerSchedule[];
  secrets: string[];
  // A "secrets" permission declaration → the core injects the ns env: vault keys into the spawn env
  // dynamically and drain-restarts on a vault change (PS9, PS10). Derived from the permission —
  // the manifest does not restate it.
  vaultEnv: boolean;
  dependencies: string[];
}

export interface BindLedger {
  version: 1;
  services: LedgerServiceBinding[];
}

export function buildServiceBinding(manifest: PluginManifest): LedgerServiceBinding | null {
  const svc = manifest.service;
  if (!svc) return null;
  const sidecar = manifest.runtimeDependencies?.sidecars?.[0];
  if (!sidecar) throw new Error("validated service manifest has no runtime sidecar release");
  return {
    plugin: manifest.id,
    sidecar,
    interface: svc.interface,
    ops: serviceOps(manifest),
    subscribe: svc.subscribe,
    schedules: (manifest.contributes.schedules ?? []).map((s) => ({
      name: s.name,
      command: s.command,
      ...(s.params ? { params: s.params } : {}),
      trigger: s.trigger,
      ...(s.timeoutMs !== undefined ? { timeoutMs: s.timeoutMs } : {}),
      ...(s.zombieBackstopMs !== undefined ? { zombieBackstopMs: s.zombieBackstopMs } : {}),
    })),
    secrets: [],
    // "secrets" permission → target of env: vault key injection (PS9). Explicit secret name declaration is unused in v1 (empty array).
    vaultEnv: (manifest.permissions ?? []).includes("secrets"),
    // Allowed targets of brokered outbound calls (PS13, C3) — manifest dependencies (plugin↔plugin).
    dependencies: Object.keys(runtimePluginRequirements(manifest)),
  };
}

export function buildBindLedger(manifests: PluginManifest[]): BindLedger {
  const services = manifests
    .map(buildServiceBinding)
    .filter((b): b is LedgerServiceBinding => b !== null)
    .sort((a, b) => a.plugin.localeCompare(b.plugin)); // Deterministic serialization — the premise of idempotent content comparison.
  return { version: 1, services };
}

// Derives the ledger from the enabled manifest set and syncs it to the core. The result is the
// same from any window (idempotent) — the core no-ops when the content is identical.
export async function syncServiceLedger(
  manifests: PluginManifest[],
  invoke: ServiceProxyDeps["invoke"],
): Promise<void> {
  await invoke("service_ledger_sync", { ledger: buildBindLedger(manifests) });
}
