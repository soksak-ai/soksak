// Plugin loader — module loading is separate from lifecycle. Each code generation is evaluated in
// a disposable child realm so deactivation can reclaim its ESM graph.
//   - activatePlugin: verified manifest + module → active instance. Every registration is collected
//     by the tracker automatically — no leak on deactivation (§0-4).
//   - The entry module accepts both forms: legacy ({activate,deactivate}) and SDK static
//     ({controller,commands,views}). Registrations from the static form pass the same gate
//     (gateContribution declared-only) and the same tracker.
//     Legacy acceptance is removed once every 1st-party unit release uses the static form (corridor
//     end gate).

import { moduleState } from "../lib/moduleState";
import type { RestoreKind } from "./restoreDeclaration";
import {
  buildPluginApi,
  type Disposable,
  type PluginApiDeps,
  type PluginContext,
} from "./api";
import { useProgramRegistry } from "./programRegistry";
import {
  C2_ENFORCEMENT,
  missingRegistrations,
  partitionTransparency,
  transparencyViolations,
  type TransparencyMode,
  type TransparencyRule,
} from "./conformance";
import {
  registerBusBridge,
  registerServiceProxies,
  type ServiceProxyDeps,
} from "./serviceProxy";
import { busOn } from "./bus";
import { invoke as frameworkInvoke } from "../framework";
import { bootFactPayload } from "../lib/bootFact";
import { enforceEngineNeeds } from "./engineNeeds";
import { engineProvision } from "../framework";
import { useSettings } from "../state/settings";
import { tmsg } from "../i18n";
import type { PluginManifest } from "./spec";
import { loadPluginModule } from "./pluginModuleRealm";

// Minimum deps for proxy composition — a subset of PluginApiDeps plus locale (label fallback resolution).
function serviceProxyDeps(deps: PluginApiDeps): ServiceProxyDeps {
  return {
    invoke: deps.invoke,
    registerCommand: deps.registerCommand,
    unregisterCommand: deps.unregisterCommand,
    locale: () => useSettings.getState().language,
  };
}

// Registers the service proxy and the bus bridge together (PS11, PS15). Lifetime = active lifetime
// (the tracker collects it).
function wireService(manifest: PluginManifest, deps: PluginApiDeps, tracker: { wrap: (d: () => void) => void }, markRegistered: (bare: string) => void): void {
  tracker.wrap(registerServiceProxies(manifest, serviceProxyDeps(deps), markRegistered));
  if (manifest.service) {
    tracker.wrap(registerBusBridge(manifest, { invoke: deps.invoke, busOn }));
  }
}

export const importPluginModule = loadPluginModule;

interface EntryFns {
  activate: (ctx: PluginContext) => void | Promise<void>;
  deactivate?: () => void | Promise<void>;
}

// Provider shape of the SDK static module contract (plugins/spec SoksakPluginModule).
interface StaticViewProvider {
  // What this view needs to come back (SESSION.md S1-5). Required of a static view for the same
  // reason as any other: the core cannot judge a restore of a view that declared nothing.
  restores: RestoreKind;
  mount(context: unknown): void | Promise<void>;
  update?(context: unknown): void | Promise<void>;
  unmount?(context: unknown): void | Promise<void>;
}
interface StaticModule {
  controller?: {
    activate?: (ctx: PluginContext) => void | Promise<void>;
    deactivate?: () => void | Promise<void>;
  };
  commands?: Record<
    string,
    (params: Record<string, unknown>, context: unknown) => unknown
  >;
  views?: Record<string, StaticViewProvider>;
}

// Adapter from a static view provider (new mount({root,...}) signature) to a viewRegistry provider
// (old mount(el,ctx)). Teardown is signalled by a per-instance AbortSignal. root=DOM root,
// workspaceRoot=workspace path (renamed from the old ctx.root); the remaining PluginViewContext fields
// (restore, paneId, setBadge, …) pass through unchanged — the B3 restore seam is preserved.
function adaptStaticView(
  provider: StaticViewProvider,
  appOf: () => PluginContext["app"],
) {
  const aborts = new Map<HTMLElement, AbortController>();
  const staticCtx = (
    el: HTMLElement,
    vctx: Record<string, unknown> | undefined,
    signal: AbortSignal,
  ) => ({
    ...(vctx ?? {}),
    root: el,
    workspaceRoot: (vctx?.root as string | null | undefined) ?? null,
    app: appOf(),
    signal,
  });
  return {
    restores: provider.restores,
    mount(el: HTMLElement, vctx: unknown) {
      aborts.get(el)?.abort();
      const ac = new AbortController();
      aborts.set(el, ac);
      void provider.mount(
        staticCtx(el, vctx as Record<string, unknown>, ac.signal),
      );
    },
    update: provider.update
      ? (el: HTMLElement, vctx: unknown) => {
          const ac = aborts.get(el);
          void provider.update!(
            staticCtx(
              el,
              vctx as Record<string, unknown>,
              (ac ?? new AbortController()).signal,
            ),
          );
        }
      : undefined,
    unmount(el: HTMLElement) {
      const ac = aborts.get(el);
      ac?.abort();
      aborts.delete(el);
      void provider.unmount?.({
        root: el,
        app: appOf(),
        signal: ac?.signal,
      });
    },
  };
}

// Static module → EntryFns composition. Every registration passes the existing api gate
// (gateContribution declared-only) and the tracker collects it — the static form does not change the
// verification or lifetime rules.
function staticEntry(mod: StaticModule): EntryFns {
  return {
    activate: async (ctx) => {
      for (const [id, provider] of Object.entries(mod.views ?? {})) {
        if (!ctx.app.ui) {
          throw new Error(tmsg("plugin.static.viewsNeedUi", { id }));
        }
        ctx.app.ui.registerView(id, adaptStaticView(provider, () => ctx.app));
      }
      for (const [name, handler] of Object.entries(mod.commands ?? {})) {
        if (!ctx.app.commands) {
          throw new Error(tmsg("plugin.static.commandsNeedCommands", { name }));
        }
        // The manifest is the authority for display spec (title, danger) (PS3) — this is handler
        // binding only.
        const decl = ctx.manifest.contributes.commands.find(
          (c) => c.name === name,
        );
        const title = decl?.title;
        const description =
          typeof title === "string"
            ? title
            : (title?.en ?? (title ? Object.values(title)[0] : name));
        ctx.app.commands.register(name, {
          description: description ?? name,
          // In the static form the params spec prose is on the plugin side (the handler) — without
          // skipping registry validate, every parameter not declared in the spec dies as
          // INVALID_PARAMS.
          paramsAuthority: "handler",
          // Standard answer (MESSAGE-PROTOCOL §3): a static handler puts message in the envelope —
          // the sentence delivered through data becomes the answer, and without it this degrades to
          // the manifest title.
          message: (d) =>
            typeof (d as { message?: unknown }).message === "string"
              ? (d as { message: string }).message
              : (description ?? name),
          handler: async (params, cctx) =>
            (await handler(params, {
              app: ctx.app,
              invocation: {
                origin: (cctx as { origin?: unknown } | undefined)?.origin,
                parent: (cctx as { parent?: unknown } | undefined)?.parent,
                execute: (cctx as { execute?: unknown } | undefined)?.execute,
              },
            })) as object,
        });
      }
      await mod.controller?.activate?.(ctx);
    },
    deactivate: async () => {
      await mod.controller?.deactivate?.();
    },
  };
}

/**
 * Records in the ledger how long this plugin's activation took.
 *
 * Emitted under the same kind as boot stamps (`boot.step`) — when boot is slow it reads on one axis,
 * with no need to reconcile two lists by hand. A publish failure is swallowed: instrumentation that
 * kills boot ruins what it measures.
 */
function publishActivateCost(id: string, tookMs: number): void {
  void frameworkInvoke("activity_publish", {
    kind: "boot.step",
    source: "boot",
    payload: bootFactPayload(`plugin-activate:${id}`, { tookMs: Math.round(tookMs) }),
  }).catch(() => {});
}

// Entry module shape resolution: default export object first, named export as fallback.
// Legacy ({activate}) first, static ({controller|commands|views}) as fallback — both forms accepted
// (corridor).
function resolveEntry(module: unknown): EntryFns | null {
  const candidates: unknown[] = [];
  if (module && typeof module === "object") {
    candidates.push((module as { default?: unknown }).default, module);
  }
  for (const c of candidates) {
    if (
      c &&
      typeof c === "object" &&
      typeof (c as { activate?: unknown }).activate === "function"
    ) {
      const obj = c as {
        activate: EntryFns["activate"];
        deactivate?: EntryFns["deactivate"];
      };
      return {
        activate: obj.activate,
        deactivate:
          typeof obj.deactivate === "function" ? obj.deactivate : undefined,
      };
    }
  }
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const mod = c as StaticModule;
    const hasStatic =
      (mod.controller && typeof mod.controller === "object") ||
      (mod.commands && typeof mod.commands === "object") ||
      (mod.views && typeof mod.views === "object");
    if (hasStatic) return staticEntry(mod);
  }
  return null;
}

export interface ActivePlugin {
  manifest: PluginManifest;
  dir: string;
  deactivate: () => Promise<void>;
}

// Warns about register-gated contributions that were declared but not registered (zero concealment).
// The declared→actual direction of declared≡actual. Activation is not blocked (§0-4) — diagnostic
// exposure is plugin.conformance (follow-up).
function reportDeclaredButNotRegistered(
  manifest: PluginManifest,
  registered: {
    commands: Set<string>;
    views: Set<string>;
    iconSets: Set<string>;
  },
): void {
  const c = manifest.contributes;
  const gaps = (
    [
      ["commands", c.commands.map((x) => x.name), registered.commands],
      ["views", c.views.map((x) => x.id), registered.views],
      ["iconSets", c.iconSets.map((x) => x.id), registered.iconSets],
    ] as const
  )
    .map(([kind, declared, reg]) => ({
      kind,
      missing: missingRegistrations(declared, [...reg]),
    }))
    .filter((g) => g.missing.length > 0);
  if (gaps.length > 0) {
    console.warn(
      `[plugin:${manifest.id}] declared-but-not-registered: ${gaps
        .map((g) => `${g.kind}=[${g.missing.join(",")}]`)
        .join(", ")}`,
    );
  }
}

// Activation-boundary enforcement of the manifest static rules
// (command-surface, view-nodes, content-view-status) among the three transparency rules of
// composition law C2. Single truth for the judgment = spec package transparency.ts (consumed through
// conformance — no mirror). A blocking rule violation refuses activation (throw); a warn rule
// violation warns (zero concealment). Single truth for the modes = C2_ENFORCEMENT.
// The view-status rule can be judged only after mount (viewStatusConformance, declared≡reported) —
// its enforcement point is not here.
export function enforceTransparency(
  manifest: PluginManifest,
  enforcement: Readonly<Record<TransparencyRule, TransparencyMode>> = C2_ENFORCEMENT,
): void {
  const violations = transparencyViolations(manifest.contributes);
  const { blocking, warn } = partitionTransparency(violations, enforcement);
  for (const v of warn) {
    console.warn(`[plugin:${manifest.id}] C2 ${v.rule}: ${v.detail}`);
  }
  if (blocking.length > 0) {
    throw new Error(
      tmsg("plugin.transparency.c2Violation", {
        id: manifest.id,
        violations: blocking.map((v) => `${v.rule} — ${v.detail}`).join("; "),
      }),
    );
  }
}


// Module + manifest → active instance. On activate failure, every registration is reclaimed, then throw.
export async function activatePlugin(
  module: unknown,
  manifest: PluginManifest,
  dir: string,
  deps: PluginApiDeps,
  entrySource?: string,
  disposeModuleRealm?: () => void,
): Promise<ActivePlugin> {
  let moduleRealmDisposed = false;
  const disposeRealm = () => {
    if (moduleRealmDisposed) return;
    moduleRealmDisposed = true;
    disposeModuleRealm?.();
  };
  const entry = resolveEntry(module);
  if (!entry) {
    disposeRealm();
    throw new Error(tmsg("plugin.entry.noActivate"));
  }

  // Stops here when this framework cannot satisfy a requirement — the only place that compares the
  // contract (engineNeeds) with the provision (engineProvision). Without this gate the surface loads
  // and the screen shows only "engine surface creation failed" (measured 2026-07-31, Electron).
  enforceEngineNeeds(manifest, engineProvision);
  // [C2] Three transparency rules — the manifest static rules run before registration (a blocking
  // violation creates nothing).
  enforceTransparency(manifest);
  const { api, tracker, registered } = buildPluginApi(manifest, dir, deps, entrySource);

  // Declarative contributions apply automatically: programs need data only (no code binding) — the
  // whole behavior is in the manifest, so the consent screen states it as is (§0-2).
  for (const p of manifest.contributes.programs) {
    tracker.wrap(useProgramRegistry.getState().register(manifest.id, p));
  }
  // bind:"service" command proxy + bus bridge (PS3, PS11, PS15, docs/PLUGIN-SERVICE.md).
  // Lifetime = active lifetime (independent of service restarts — no re-registration, the registry
  // duplicate-throw stays in force).
  wireService(manifest, deps, tracker, (bare) => registered.commands.add(bare));

  const subscriptions: Disposable[] = [];
  const ctx: PluginContext = { app: api, manifest, dir, subscriptions };

  const disposeSubscriptions = async () => {
    for (const d of subscriptions.splice(0).reverse()) {
      try {
        await d.dispose();
      } catch (e) {
        console.error(`plugin subscription dispose failed (${manifest.id}):`, e);
      }
    }
  };

  // Rename data ns migration (defense against the fallout of a destructive id rename) — before
  // activate, data under the old id moves to the new id so the plugin's data access covers that
  // history. The core handles it idempotently (only the declared from→to).
  // A collision (data on both sides) is a loud log and does not block activation — the plugin keeps
  // running on the new ns, and the failure to merge the old data is reported (not silent).
  if (manifest.renamedFrom) {
    try {
      await deps.invoke("data_migrate_ns", {
        fromNs: manifest.renamedFrom,
        toNs: manifest.id,
      });
    } catch (e) {
      console.error(
        `[plugin:${manifest.id}] rename data migration failed (renamedFrom=${manifest.renamedFrom}): ${e}`,
      );
    }
  }

  // Records how long activation took, with the name.
  //
  // The core waits for this call — a plugin's commands and views exist only after registration
  // finishes. What happens inside is the plugin's business, so when a plugin reads storage or goes
  // over the network in activate, all of that time lands here. With no place to measure it, who did
  // it cannot be named, and what cannot be named nobody fixes (measured 2026-08-08: with no view open
  // at all, one plugin restored its own document in activate and spent 429ms).
  //
  // It is not blocked — what work registration needs is for that plugin to determine. It is answered
  // as a value instead.
  const activateAt = performance.now();
  try {
    await entry.activate(ctx);
  } catch (e) {
    await disposeSubscriptions();
    tracker.disposeAll();
    disposeRealm();
    throw new Error(tmsg("plugin.activate.failed", { id: manifest.id, error: String(e) }));
  } finally {
    publishActivateCost(manifest.id, performance.now() - activateAt);
  }

  // [conformance] Post-activate inventory — the declared→actual direction of declared≡actual.
  reportDeclaredButNotRegistered(manifest, registered);

  let deactivated = false;
  return {
    manifest,
    dir,
    deactivate: async () => {
      if (deactivated) return; // Idempotent.
      deactivated = true;
      try {
        try {
          await entry.deactivate?.();
        } catch (e) {
          // §0-4: a plugin's cleanup failure does not block host cleanup either.
          console.error(`deactivate failed (${manifest.id}):`, e);
        }
        await disposeSubscriptions();
        tracker.disposeAll();
      } finally {
        disposeRealm();
      }
    },
  };
}

// Pure contract plugin activation (PS4 — entry: null). Builds an active instance from gates, data
// contributions, and service proxies alone, with no code loading. The legality conditions (every
// command bind:"service", 0 code-requiring contributions) were already enforced by parseManifest —
// they are not re-judged here (single judge).
export async function activateContractPlugin(
  manifest: PluginManifest,
  dir: string,
  deps: PluginApiDeps,
): Promise<ActivePlugin> {
  // [C2]/[C3] — enforced at the same boundary whether or not there is an entry (the transparency
  // gate applies unchanged, PS4).
  enforceTransparency(manifest);

  const { tracker, registered } = buildPluginApi(manifest, dir, deps);
  for (const p of manifest.contributes.programs) {
    tracker.wrap(useProgramRegistry.getState().register(manifest.id, p));
  }
  wireService(manifest, deps, tracker, (bare) => registered.commands.add(bare));
  reportDeclaredButNotRegistered(manifest, registered);

  let deactivated = false;
  return {
    manifest,
    dir,
    deactivate: async () => {
      if (deactivated) return; // Idempotent.
      deactivated = true;
      tracker.disposeAll();
    },
  };
}

// ── Active instance storage (non-serializable objects — outside the store) ───────────────────

const active = moduleState(
  "plugins/loader#active",
  () => new Map<string, ActivePlugin>(),
);

export function isActive(id: string): boolean {
  return active.has(id);
}

export function setActive(id: string, instance: ActivePlugin): void {
  active.set(id, instance);
}

export async function deactivateById(id: string): Promise<boolean> {
  const instance = active.get(id);
  if (!instance) return false;
  active.delete(id);
  await instance.deactivate();
  return true;
}

export async function deactivateAll(): Promise<void> {
  const ids = [...active.keys()];
  for (const id of ids) {
    await deactivateById(id);
  }
}
