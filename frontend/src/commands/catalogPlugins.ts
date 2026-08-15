// plugin.* commands — plugin management (list/install/update/remove/enable/disable/reload/dev).
// Consent (§0-5) is a human act only: remote enable without recorded consent is refused with
// CONSENT_REQUIRED, and no consent-granting command exists (UI consent modal only).
// plugin.view.* placement commands are registered in M_P5 (right sidebar).

import { invoke } from "../framework";
import { pendingConsentChain, usePlugins, type PluginRuntime } from "../state/plugins";
import { allGroups, useSessions } from "../state/sessions";
import { hasSidebarView as hasSidebarViewKey } from "../state/sidebarLayout";
import { getRegisteredView, registeredViewIds } from "../plugins/viewRegistry";
import { registeredFileViewerIds } from "../plugins/fileViewerRegistry";
import { registeredIconSetIds } from "../ui/icons/registry";
import { getRegisteredProgram, listPrograms, useProgramRegistry } from "../plugins/programRegistry";
import { localize, tmsg } from "../i18n";
import {
  VIEW_PLACEMENTS,
  configDefaults,
  configSettingOf,
  parseContractRequirement,
  validateSettingValue,
  type ViewPlacement,
} from "../plugins/spec";
import { usePluginSettings } from "../state/pluginSettings";
import { useRegistry } from "../state/registry";
import { currentWindowLabel } from "../lib/webviewLabels";
import {
  depSummary,
  versionIssues,
  type DepNode,
} from "../plugins/dependencyGraph";
import {
  allContracts,
  implementersOf,
  implementersOfId,
  manifestImplements,
  rawImplements,
  type ImplementsNode,
} from "../plugins/contractDiscovery";
import { implementsViolations, executedCommandNames, unresolvedCommandCalls } from "../plugins/conformance";
import { register, catalogJson, setUnknownCommandResolver, type CommandHint } from "./registry";
import { notFound } from "./refuse";
import { collectExposed } from "./catalogDom";
import { pluginCommandName } from "../plugins/spec";
import { commandsMissingMessage } from "../plugins/api";
import {
  missingRegistrations,
  nodeConformance,
  transparencyViolations,
  viewStatusConformance,
  type TransparencyViolation,
  type ViewStatusObservation,
} from "../plugins/conformance";
import { useUi } from "../state/ui";
import { consentSummary } from "../plugins/consentSummary";
import {
  OFFICIAL_REGISTRY_ID,
  parseRegistryDescriptor,
  resolveRegistryUnit,
  type QualifiedRegistryEntry,
} from "../plugins/registry";
import {
  installQualifiedRegistryEntry,
  updateCertifiedRegistryPlugin,
} from "../plugins/registryInstallService";
import { publishActivity } from "../state/activityFeed";

// Installed/dev runtime → dependency graph node (based on manifest dependencies).
function depNodes(): DepNode[] {
  return Object.values(usePlugins.getState().plugins).map((p) => ({
    id: p.manifest.id,
    version: p.manifest.version,
    dependencies: p.manifest.dependencies ?? {},
  }));
}

// Installed/dev runtime → contract discovery node (based on manifest implements). The runtime
// registration surface of the L2 contract pin (C3) — discovery queries run against these nodes only
// (no implementer discrimination).
function implementsNodes(): ImplementsNode[] {
  return Object.values(usePlugins.getState().plugins).map((p) => ({
    id: p.manifest.id,
    implements: manifestImplements(p.manifest),
  }));
}

const invalid = (what: string) => ({
  ok: false as const,
  code: "INVALID_PARAMS" as const,
  message: what,
});

// plugin.list response item (serializable — no handlers or modules included).
function serializeRuntime(p: PluginRuntime) {
  return {
    id: p.manifest.id,
    name: p.manifest.name,
    version: p.manifest.version,
    description: p.manifest.description,
    source: p.source,
    status: p.status,
    error: p.error,
    permissions: p.manifest.permissions,
    views: p.manifest.contributes.views.map((v) => ({
      id: v.id,
      title: v.title,
      placements: v.placements,
    })),
    commands: p.manifest.contributes.commands.map((c) => c.name),
    // A contract implementation declaration is a fact of the manifest. Without emitting it there is
    // nowhere to query "who implements this contract", and consumers end up with a hand-written table
    // of plugin ids — that table diverges silently.
    implements: manifestImplements(p.manifest),
    dir: p.dir,
  };
}

export function registerPluginCatalog(): void {
  register("program.list", {
    description:
      "List all programs available in the new-tab menu. Every entry is plugin-registered; nothing is built-in. Use to discover launchable programs and their menu category paths.",
    triggers: { ko: "프로그램 목록 앱 메뉴 새탭" },
    params: {},
    returns: "{ programs: [{ id, title, path?, kind, pluginId }] }",
    message: (d) =>
      d.note
        ? tmsg("msg.list.controlPlane")
        : tmsg("msg.program.list", { n: ((d.programs as unknown[]) ?? []).length }),
    examples: ["program.list"],
    handler: () => ({
      // The control plane (main) loads no plugins — the response explains itself so an empty list is
      // not misread as "not installed".
      ...(currentWindowLabel() === "main"
        ? { note: "control-plane window loads no plugins — query a project window (w-*) or pass --window" }
        : {}),
      programs: listPrograms().map((p) => ({
        id: p.decl.id,
        title: p.decl.title,
        ...(p.decl.path ? { path: p.decl.path } : {}),
        kind: p.decl.kind,
        ...(p.decl.command ? { command: p.decl.command } : {}),
        ...(p.decl.ensure ? { ensure: p.decl.ensure } : {}),
        pluginId: p.pluginId,
      })),
    }),
  });

  register("program.wait", {
    description:
      "Wait for one declared program to enter the live registry. This is an event subscription, not a polling loop; use it at boot boundaries before opening a plugin-owned view.",
    triggers: { ko: "프로그램 준비 대기 플러그인 등록 이벤트" },
    params: {
      id: { type: "string", description: "Program id to await", required: true },
      timeoutMs: {
        type: "number",
        description: "Finite deadline in milliseconds (1..60000, default 20000)",
        default: 20_000,
      },
    },
    returns: "{ id, pluginId, kind }",
    errors: ["INVALID_PARAMS", "TIMEOUT"],
    message: (d) => tmsg("msg.program.wait", { id: String(d.id) }),
    examples: ['program.wait \'{"id":"browser","timeoutMs":20000}\''],
    handler: async (p) => {
      const id = String(p.id ?? "");
      const timeoutMs = p.timeoutMs === undefined ? 20_000 : Number(p.timeoutMs);
      if (!id || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
        return { ok: false as const, code: "INVALID_PARAMS", message: tmsg("msg.program.wait.paramsInvalid") };
      }
      const result = (found: NonNullable<ReturnType<typeof getRegisteredProgram>>) => ({
        id: found.decl.id,
        pluginId: found.pluginId,
        kind: found.decl.kind,
      });
      const existing = getRegisteredProgram(id);
      if (existing) return result(existing);

      return new Promise<ReturnType<typeof result> | { ok: false; code: "TIMEOUT"; message: string }>((resolve) => {
        let settled = false;
        const finish = (value: ReturnType<typeof result> | { ok: false; code: "TIMEOUT"; message: string }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          resolve(value);
        };
        const unsubscribe = useProgramRegistry.subscribe((state) => {
          const found = state.programs[id];
          if (found) finish(result(found));
        });
        const timer = setTimeout(
          () => finish({ ok: false, code: "TIMEOUT", message: tmsg("msg.program.wait.timeout", { id }) }),
          timeoutMs,
        );
        // An event registered just before subscribe is not lost either.
        const raced = getRegisteredProgram(id);
        if (raced) finish(result(raced));
      });
    },
  });

  // Plugin short name resolution — single truth for the base-form syntax. "<name>" ≡
  // "soksak-plugin-<name>". Resolves to the installed id when an install exists, otherwise to a
  // registry entry. null when neither is found.
  const resolveShortId = (raw: string): string | null => {
    const cands = raw.startsWith("soksak-plugin-") ? [raw] : [`soksak-plugin-${raw}`, raw];
    const installed = usePlugins.getState().plugins;
    const entries = useRegistry.getState().entries;
    for (const c of cands) {
      if (installed[c] || entries.some((e) => e.id === c)) return c;
    }
    return null;
  };
  const shortName = (id: string): string => id.replace(/^soksak-plugin-/, "");
  const qualifiedInstallCommand = (entry: Pick<QualifiedRegistryEntry, "registryId" | "unitId">): string =>
    `plugin.install '${JSON.stringify({ registryId: entry.registryId, unitId: entry.unitId })}'`;

  const installResolution = (raw: string, registryId?: string) => {
    const unitIds = raw.startsWith("soksak-plugin-") ? [raw] : [`soksak-plugin-${raw}`, raw];
    for (const unitId of unitIds) {
      const resolved = resolveRegistryUnit(useRegistry.getState().units, {
        registryId,
        unitId,
        kind: "plugin",
      });
      if (resolved.ok || resolved.reason !== "not_found") return resolved;
    }
    return resolveRegistryUnit(useRegistry.getState().units, {
      registryId,
      unitId: unitIds[0],
      kind: "plugin",
    });
  };

  // Qualified plugin command names expose the owning unit id. The registry may suggest
  // installing that unit, but it cannot copy or claim the owner's command declarations.
  setUnknownCommandResolver((name): CommandHint[] => {
    const entries = useRegistry.getState().units.filter((entry) => entry.kind === "plugin");
    const installed = usePlugins.getState().plugins;
    // The control plane (main) loads no plugins — an unknown plugin command here is a window problem,
    // not an install problem. Install guidance is a misdiagnosis (measured: an external agent
    // retried repeatedly).
    const controlPlane = currentWindowLabel() === "main";
    const controlPlaneHint = (): CommandHint[] => [
      { cmd: "window.projects", why: tmsg("hint.error.pluginControlPlane") },
    ];
    // Form (1): plugin.<plugin id>.<command> — decided directly from the id.
    const m = /^plugin\.(soksak-plugin-[a-z0-9-]+)\.(.+)$/.exec(name);
    if (m) {
      const [, pid, sub] = m;
      const matching = entries.filter((e) => e.unitId === pid);
      const runtime = installed[pid];
      if (runtime && runtime.status !== "enabled") {
        return [{ cmd: `plugin.enable ${shortName(pid)}`, why: tmsg("hint.error.pluginDisabled", { plugin: pid }) }];
      }
      if (matching.length && controlPlane) return controlPlaneHint();
      if (!runtime && matching.length) {
        return matching.slice(0, 3).map((entry) => ({
          cmd:
            matching.length === 1 && entry.registryId === OFFICIAL_REGISTRY_ID
              ? `plugin.install ${shortName(pid)}`
              : qualifiedInstallCommand(entry),
          why: tmsg("hint.error.pluginNotInstalled", { plugin: pid, command: sub }),
        }));
      }
      return [];
    }
    return [];
  });

  register("plugin.list", {
    description:
      "List all installed and dev plugins with their runtime status, permissions, and rejection reasons. rejected holds one entry per directory whose manifest failed validation (dir = plugin folder, errors = the specific validation failures). Use to check which plugins exist and whether any failed to load.",
    triggers: { ko: "플러그인 목록 설치된 확장 상태" },
    params: {},
    returns: "{ plugins: [{id, name, version, status, permissions, …}], rejected: [{dir, errors}] }",
    message: (d) =>
      d.note
        ? tmsg("msg.list.controlPlane")
        : tmsg("msg.plugin.list", { n: ((d.plugins as unknown[]) ?? []).length }),
    examples: ["plugin.list"],
    handler: () => {
      const s = usePlugins.getState();
      return {
        // The control plane (main) loads no plugins — the response explains the reason for the empty
        // list itself.
        ...(currentWindowLabel() === "main"
          ? { note: "control-plane window loads no plugins — query a project window (w-*) or pass --window" }
          : {}),
        plugins: Object.values(s.plugins).map(serializeRuntime),
        rejected: s.rejected,
      };
    },
  });

  const serializeRegistrySource = (registryId: string) => {
    const source = useRegistry.getState().registries[registryId];
    if (!source) return null;
    return {
      ...source.descriptor,
      status: source.status,
      fetchedOnce: source.fetchedOnce,
      unitCount: source.entries.length,
      lastFetchedAt: source.lastFetchedAt ?? null,
      error: source.error ?? null,
    };
  };

  register("registry.list", {
    description:
      "List configured official, public, and private registry descriptors with pinned public-key metadata and per-registry status. A private credential is represented only by its core-derived opaque slot reference; secret values are never returned.",
    triggers: { ko: "레지스트리 목록 공개 비공개 신뢰키 상태" },
    params: {},
    returns:
      "{ registries: [{id,name,indexUrl,visibility,trustedPublicKey,credentialRef?,status,unitCount,lastFetchedAt,error}] }",
    message: (d) => tmsg("msg.registry.list", { n: ((d.registries as unknown[]) ?? []).length }),
    errors: [],
    examples: ["registry.list"],
    handler: () => ({
      registries: useRegistry.getState().descriptors
        .map((descriptor) => serializeRegistrySource(descriptor.id))
        .filter(Boolean),
    }),
  });

  register("registry.add", {
    description:
      "Add a public or private registry descriptor. The descriptor is strict: a credential-free HTTPS index URL and pinned Ed25519 public key. For private registries the core derives one vault credential slot from registry id; descriptors cannot select a namespace/key, and raw tokens, headers, passwords, URL userinfo, queries, and fragments are rejected.",
    triggers: { ko: "레지스트리 추가 공개 비공개 신뢰키 vault" },
    params: {
      descriptor: {
        type: "json",
        required: true,
        description:
          "{id,name,indexUrl,visibility:'public'|'private',trustedPublicKey:{algorithm:'ed25519',keyId,value}}; private credentialRef is core-derived read-only metadata",
      },
    },
    returns: "{ registryId }",
    message: (d) => tmsg("msg.registry.add", { id: String(d.registryId) }),
    errors: ["INVALID_PARAMS", "ALREADY_EXISTS"],
    examples: [
      `registry.add '${JSON.stringify({
        descriptor: {
          id: "community",
          name: "Community",
          indexUrl: "https://registry.example/index.json",
          visibility: "public",
          trustedPublicKey: { algorithm: "ed25519", keyId: "publisher-1", value: "<base64-32-byte-public-key>" },
        },
      })}'`,
    ],
    handler: (p) => {
      const descriptor = parseRegistryDescriptor(p.descriptor);
      if (!descriptor) {
        return { ok: false, code: "INVALID_PARAMS", message: "invalid registry descriptor" };
      }
      const result = useRegistry.getState().add(descriptor);
      if (result.ok) publishActivity("registry.added", "core", { registryId: result.registryId });
      return result;
    },
  });

  register("registry.remove", {
    description:
      "Remove a user-added registry descriptor and its cached units. The built-in official registry is immutable and cannot be removed.",
    triggers: { ko: "레지스트리 제거 삭제" },
    params: {
      registryId: { type: "string", required: true, description: "Registry descriptor id" },
    },
    returns: "{ registryId }",
    message: (d) => tmsg("msg.registry.remove", { id: String(d.registryId) }),
    errors: ["INVALID_PARAMS", "TARGET_NOT_FOUND"],
    examples: ['registry.remove \'{"registryId":"community"}\''],
    danger: "destructive",
    handler: (p) => {
      const result = useRegistry.getState().remove(String(p.registryId));
      if (result.ok) publishActivity("registry.removed", "core", { registryId: result.registryId });
      return result;
    },
  });

  register("registry.refresh", {
    description:
      "Fetch and verify one registry or all registries. Only an index signed by the descriptor-pinned Ed25519 key becomes live; unsigned or mismatched indexes remain uncertified and cached units are not replaced.",
    triggers: { ko: "레지스트리 새로고침 서명 검증 인증" },
    params: {
      registryId: { type: "string", description: "Registry id; omit to refresh all" },
      force: { type: "boolean", description: "Refetch even when this session already fetched", default: true },
    },
    returns: "{ results: [{registryId,status,error?,skipped?}] }",
    message: (d) => tmsg("msg.registry.refresh", { n: ((d.results as unknown[]) ?? []).length }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["registry.refresh", 'registry.refresh \'{"registryId":"community"}\''],
    handler: async (p) => {
      const registryId = typeof p.registryId === "string" ? p.registryId : undefined;
      if (registryId && !useRegistry.getState().registries[registryId]) {
        return { ok: false, code: "TARGET_NOT_FOUND", message: `registry not found: ${registryId}` };
      }
      const results = await useRegistry.getState().refresh(p.force !== false, registryId);
      for (const result of results) {
        publishActivity("registry.refreshed", "core", {
          registryId: result.registryId,
          status: result.status,
          ...(result.error ? { error: result.error } : {}),
        });
      }
      return { results };
    },
  });

  register("registry.status", {
    description:
      "Read per-registry fetch, certification, error, last-fetch, and recent lifecycle-event state without performing network I/O.",
    triggers: { ko: "레지스트리 상태 오류 이벤트 인증" },
    params: {
      registryId: { type: "string", description: "Registry id; omit for all" },
    },
    returns: "{ registries: [descriptor+status], events: [{seq,at,type,registryId,detail?}] }",
    message: (d) => tmsg("msg.registry.status", { n: ((d.registries as unknown[]) ?? []).length }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["registry.status", 'registry.status \'{"registryId":"official"}\''],
    handler: (p) => {
      const registryId = typeof p.registryId === "string" ? p.registryId : undefined;
      if (registryId && !useRegistry.getState().registries[registryId]) {
        return { ok: false, code: "TARGET_NOT_FOUND", message: `registry not found: ${registryId}` };
      }
      const state = useRegistry.getState();
      const descriptors = registryId
        ? state.descriptors.filter((descriptor) => descriptor.id === registryId)
        : state.descriptors;
      return {
        registries: descriptors.map((descriptor) => serializeRegistrySource(descriptor.id)).filter(Boolean),
        events: state.events.filter((event) => !registryId || event.registryId === registryId),
      };
    },
  });

  register("plugin.catalog", {
    description:
      "List authenticated plugin release references from configured registries, merged with local install state. Unit-owned display metadata and commands become available only after release verification.",
    triggers: { ko: "플러그인 카탈로그 레지스트리 설치 가능 목록 마켓 검색" },
    params: {
      registryId: {
        type: "string",
        description: "Limit results and refresh to one registry id",
      },
      refresh: {
        type: "boolean",
        description: "Refetch the signed live registry before listing (default: certified session state)",
      },
    },
    returns:
      "{ status, registries, plugins: [{registryId,unitId,id,kind,version,manifest,reports,installed,runtimeStatus?}] }",
    message: (d) =>
      tmsg("msg.plugin.catalog", { n: ((d.plugins as unknown[]) ?? []).length }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["plugin.catalog", 'plugin.catalog \'{"refresh":true}\''],
    hint: (d) => {
      // Offers the first not-installed entry as an install example — omitted when everything is
      // installed.
      const plugins = (d.plugins as (QualifiedRegistryEntry & { installed: boolean })[] | undefined) ?? [];
      const notInstalled = plugins.find((p) => !p.installed);
      if (!notInstalled) return [];
      return [
        {
          cmd: qualifiedInstallCommand(notInstalled),
          why: tmsg("hint.plugin.installNext"),
        },
      ];
    },
    handler: async (p) => {
      const reg = useRegistry.getState();
      const registryId = typeof p.registryId === "string" ? p.registryId : undefined;
      if (registryId && !reg.registries[registryId]) {
        return { ok: false, code: "TARGET_NOT_FOUND", message: `registry not found: ${registryId}` };
      }
      await reg.refresh(p.refresh === true, registryId).catch(() => {});
      const st = useRegistry.getState();
      const installed = usePlugins.getState().plugins;
      const units = st.units.filter((entry) =>
        entry.kind === "plugin" && (!registryId || entry.registryId === registryId)
      );
      return {
        status: st.status,
        registries: st.descriptors
          .filter((descriptor) => !registryId || descriptor.id === registryId)
          .map((descriptor) => serializeRegistrySource(descriptor.id)),
        plugins: units.map((e) => ({
          registryId: e.registryId,
          unitId: e.unitId,
          id: e.id,
          kind: e.kind,
          version: e.version,
          manifest: e.manifest,
          reports: e.reports,
          installed: e.id in installed,
          runtimeStatus: installed[e.id]?.status ?? null,
        })),
      };
    },
  });

  register("command.docs", {
    description:
      "The whole executable command surface in one call: core command specs, installed plugin command specs, and authenticated release references for units that are not installed. A registry never supplies unit command declarations.",
    triggers: { ko: "전체 명령 문서 레퍼런스 매뉴얼 한눈에 코어 플러그인 미설치" },
    params: {
      refresh: {
        type: "boolean",
        description: "Refetch signed live registries before answering",
      },
      lang: {
        type: "string",
        enum: ["en", "ko"],
        description: "Language for human-facing text (default: en)",
      },
    },
    returns:
      "{ core: [spec], plugins: { [pluginId]: [spec] }, registry: [{registryId,unitId,id,kind,version,manifest,reports,installed}] }",
    message: (d) =>
      tmsg("msg.command.docs", {
        core: ((d.core as unknown[]) ?? []).length,
        registry: ((d.registry as unknown[]) ?? []).length,
      }),
    examples: ["command.docs", "docs", 'command.docs \'{"lang":"ko"}\''],
    handler: async (p) => {
      const reg = useRegistry.getState();
      await reg.refresh(p.refresh === true).catch(() => {});
      const st = useRegistry.getState();
      const installed = usePlugins.getState().plugins;
      const all = catalogJson() as { name: string }[];
      const core: unknown[] = [];
      const plugins: Record<string, unknown[]> = {};
      for (const c of all) {
        const rest = c.name.startsWith("plugin.") ? c.name.slice("plugin.".length) : null;
        const pid = rest?.startsWith("soksak-plugin-") ? rest.slice(0, rest.indexOf(".", "soksak-plugin-".length)) : null;
        if (pid) (plugins[pid] ??= []).push(c);
        else core.push(c);
      }
      return {
        core,
        plugins,
        registry: st.units.map((e) => ({
          registryId: e.registryId,
          unitId: e.unitId,
          id: e.id,
          kind: e.kind,
          version: e.version,
          manifest: e.manifest,
          reports: e.reports,
          installed: e.id in installed,
        })),
      };
    },
  });

  register("plugin.install", {
    description:
      "Install one authenticated plugin release and its complete plugin/sidecar/kit dependency closure from one registry. Git URLs, branches, package registries, and local paths are not installation sources.",
    triggers: { ko: "플러그인 설치 추가 install" },
    params: {
      source: {
        type: "string",
        description: 'Official registry short name (for example "activity")',
      },
      registryId: { type: "string", description: "Registry id for a qualified catalog install" },
      unitId: { type: "string", description: "Unit id for a qualified catalog install" },
    },
    primary: "source",
    returns: "{ id, generation }",
    message: (d) => tmsg("msg.plugin.install", { id: String(d.id) }),
    errors: ["INVALID_PARAMS", "TARGET_NOT_FOUND", "AMBIGUOUS_TARGET", "INTERNAL"],
    examples: [
      "plugin.install activity",
      'plugin.install \'{"registryId":"community","unitId":"soksak-plugin-<id>"}\'',
    ],
    danger: "destructive",
    hint: (d) => {
      // Failure: name not found — offer catalog browsing. Success: offer the next step, enable (B4).
      if (d.code === "TARGET_NOT_FOUND")
        return [{ cmd: "plugin.catalog", why: tmsg("hint.plugin.catalogBrowse") }];
      if (d.code) return [];
      return [
        { cmd: `plugin.enable ${shortName(String(d.id))}`, why: tmsg("hint.plugin.enableNext") },
      ];
    },
    handler: async (p) => {
      const registryId = typeof p.registryId === "string" ? p.registryId : undefined;
      const explicitUnitId = typeof p.unitId === "string" ? p.unitId : undefined;
      if ((registryId && !explicitUnitId) || (explicitUnitId && !registryId)) {
        return {
          ok: false,
          code: "INVALID_PARAMS",
          message: "registryId and unitId must be provided together",
        };
      }
      if (explicitUnitId && p.source !== undefined) {
        return {
          ok: false,
          code: "INVALID_PARAMS",
          message: "source cannot be combined with registryId/unitId",
        };
      }
      const raw = explicitUnitId ?? (typeof p.source === "string" ? p.source : "");
      if (!raw) {
        return { ok: false, code: "INVALID_PARAMS", message: "source or registryId/unitId is required" };
      }
      if (explicitUnitId || /^[a-z0-9][a-z0-9-]*$/.test(raw)) {
        const resolved = explicitUnitId
          ? resolveRegistryUnit(useRegistry.getState().units, {
              registryId,
              unitId: explicitUnitId,
              kind: "plugin",
            })
          : installResolution(raw, registryId);
        if (!resolved.ok) {
          if (resolved.reason === "ambiguous") {
            return {
              ok: false,
              code: "AMBIGUOUS_TARGET",
              message: `unit exists in multiple registries: ${raw}`,
              candidates: resolved.candidates,
            };
          }
          if (resolved.reason === "qualification_required") {
            return {
              ok: false,
              code: "INVALID_PARAMS",
              message: `registryId is required for non-official unit: ${raw}`,
              candidates: resolved.candidates,
            };
          }
          return {
            ok: false,
            code: "TARGET_NOT_FOUND",
            message: tmsg("msg.plugin.install.unknownName", { name: raw }),
          };
        }
        return await installQualifiedRegistryEntry(resolved.entry);
      }
      return {
        ok: false,
        code: "INVALID_PARAMS",
        message: "plugin installation accepts only a registry unit identity",
      };
    },
  });

  register("plugin.update", {
    description:
      "Replace an installed plugin and its complete dependency closure with the greatest authenticated release from its registry. Re-consent is required when the verified manifest changes permissions.",
    triggers: { ko: "플러그인 업데이트 갱신 최신화" },
    params: {
      id: { type: "string", description: "Plugin id", required: true },
      registryId: { type: "string", description: "Origin registry id when the unit id exists in multiple registries" },
    },
    // The owner determines the answer — it is the same from any window (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ id, version, generation }",
    message: (d) => tmsg("msg.plugin.update", { id: String(d.id), version: String(d.version) }),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS", "INTERNAL"],
    examples: ['plugin.update \'{"id":"soksak-plugin-<id>"}\''],
    danger: "destructive",
    handler: async (p) => {
      const id = resolveShortId(String(p.id)) ?? String(p.id);
      return await updateCertifiedRegistryPlugin(
        id,
        typeof p.registryId === "string" ? p.registryId : undefined,
      );
    },
  });

  register("plugin.remove", {
    description:
      "Remove a plugin and its directory. Plugin-owned data (plugins-data) is preserved. Blocked with CASCADE_REQUIRED if dependents exist unless cascade:true is passed to remove them transitively.",
    triggers: { ko: "플러그인 제거 삭제 uninstall" },
    params: {
      id: { type: "string", description: "Plugin id", required: true },
      cascade: {
        type: "boolean",
        description: "When true, also removes all transitive dependents. Omit to block if any dependents exist.",
      },
    },
    returns: "{ id, removed: [removed ids …] }",
    message: (d) => tmsg("msg.plugin.remove", { n: ((d.removed as unknown[]) ?? []).length }),
    errors: ["TARGET_NOT_FOUND", "CASCADE_REQUIRED", "INTERNAL"],
    examples: [
      'plugin.remove \'{"id":"soksak-plugin-<id>"}\'',
      'plugin.remove \'{"id":"soksak-plugin-<id>","cascade":true}\'',
    ],
    danger: "destructive",
    handler: (p) =>
      usePlugins.getState().remove(resolveShortId(String(p.id)) ?? String(p.id), { cascade: p.cascade as boolean | undefined }),
  });

  register("plugin.deps", {
    description:
      "Inspect the plugin dependency graph. With an id, returns that plugin's dependencies, dependents, reference count, and cascade impact. Without an id, returns all version integrity issues across installed plugins.",
    triggers: { ko: "플러그인 의존성 의존 그래프" },
    params: {
      id: { type: "string", description: "Plugin id. Omit to list all version integrity issues." },
    },
    returns: "{ summary?, issues? }",
    message: (d) =>
      d.summary
        ? tmsg("msg.plugin.deps.summary")
        : tmsg("msg.plugin.deps.issues", { n: ((d.issues as unknown[]) ?? []).length }),
    errors: ["TARGET_NOT_FOUND"],
    examples: [
      "plugin.deps",
      'plugin.deps \'{"id":"soksak-plugin-<id>"}\'',
    ],
    handler: (p) => {
      const nodes = depNodes();
      if (p.id) {
        const summary = depSummary(resolveShortId(String(p.id)) ?? String(p.id), nodes);
        if (!summary) return notFound(tmsg("msg.plugin.notFoundId", { id: String(p.id) }));
        return { ok: true as const, summary };
      }
      return { ok: true as const, issues: versionIssues(nodes) };
    },
  });

  register("plugin.implementers", {
    description:
      "Find plugins whose exact {id, version} provider declaration implements a domain contract. Pass id alone to discover every implementer regardless of version; add range to filter by SemVer. Omit both to list exact provider evidence. Domain ids never embed a version.",
    triggers: { ko: "플러그인 계약 구현체 발견 구현 스펙 컨트랙트" },
    params: {
      id: {
        type: "string",
        description: "Version-free public domain contract id.",
      },
      range: {
        type: "string",
        description: "Supported SemVer range. Optional — omit to discover every version.",
      },
    },
    returns:
      "{ contract, implementers: [{id, version, status}] } (contract given) | { contracts: [{contract, implementers}] } (omitted)",
    message: (d) =>
      d.requirement !== undefined
        ? tmsg("msg.plugin.implementers", {
            n: ((d.implementers as unknown[]) ?? []).length,
            contract: JSON.stringify(d.requirement),
          })
        : tmsg("msg.plugin.implementers.all", {
            n: ((d.contracts as unknown[]) ?? []).length,
          }),
    errors: ["INVALID_PARAMS"],
    examples: [
      "plugin.implementers",
      'plugin.implementers \'{"id":"soksak-spec-plugin-git","range":"0.0.1"}\'',
    ],
    handler: (p) => {
      const nodes = implementsNodes();
      const hasId = p.id !== undefined;
      const hasRange = p.range !== undefined;
      // The control plane (main) loads no plugins — the response explains the reason for the empty
      // result itself.
      const note =
        currentWindowLabel() === "main"
          ? { note: "control-plane window loads no plugins — query a project window (w-*) or pass --window" }
          : {};
      if (!hasId && !hasRange) return { ...note, contracts: allContracts(nodes) };
      const installed = usePlugins.getState().plugins;
      const toImplementer = (id: string) => ({
        id,
        version: installed[id].manifest.version,
        status: installed[id].status,
      });
      // id alone = identity discovery — the call boundary enforces version compatibility through the
      // manifest, so range matching is skipped.
      if (hasId && !hasRange) {
        const id = String(p.id);
        return { ...note, requirement: { id }, implementers: implementersOfId(id, nodes).map(toImplementer) };
      }
      const requirementErrors: string[] = [];
      const requirement = parseContractRequirement(
        { id: p.id, range: p.range },
        "plugin.implementers",
        requirementErrors,
      );
      if (!requirement) return invalid(requirementErrors.join("; "));
      return {
        ...note,
        requirement,
        implementers: implementersOf(requirement, nodes).map(toImplementer),
      };
    },
  });

  register("plugin.enable", {
    description:
      "Activate a plugin so its code begins executing. Returns CONSENT_REQUIRED if the user has not yet consented via the UI consent modal — remote enable without recorded consent is always blocked.",
    triggers: { ko: "플러그인 활성화 켜기 enable" },
    params: {
      id: { type: "string", description: "Plugin id", required: true },
    },
    returns: "{ id, status }",
    message: (d) => tmsg("msg.plugin.enable", { id: String(d.id) }),
    errors: ["TARGET_NOT_FOUND", "CONSENT_REQUIRED", "INTERNAL"],
    examples: ["plugin.enable <name>", 'plugin.enable \'{"id":"soksak-plugin-<id>"}\''],
    danger: "inject",
    hint: (d) => {
      // CONSENT_REQUIRED holds the pending-consent chain in data.pendingConsent (in topological
      // order — the first entry is the one to consent to first). Read structured data only — never
      // parse the human sentence (message). Falls back to the standard guidance when it is absent.
      if (d.code !== "CONSENT_REQUIRED") return [];
      const pending = (d.data as { pendingConsent?: unknown } | undefined)?.pendingConsent;
      const first = Array.isArray(pending) && typeof pending[0] === "string" ? pending[0] : null;
      if (!first) return [];
      return [
        {
          cmd: `plugin.consent.preview '{"id":"${first}"}'`,
          why: tmsg("hint.plugin.consentPreviewNext", { id: first }),
        },
      ];
    },
    handler: (p) => {
      const id = resolveShortId(String(p.id)) ?? String(p.id);
      return usePlugins.getState().enable(id);
    },
  });

  register("plugin.disable", {
    description:
      "Deactivate a plugin and revoke all of its registered commands, views, and extensions (spec §0-4). Use when you want to stop a plugin without removing it.",
    triggers: { ko: "플러그인 비활성화 끄기 disable" },
    params: {
      id: { type: "string", description: "Plugin id", required: true },
    },
    returns: "{ id, status }",
    message: (d) => tmsg("msg.plugin.disable", { id: String(d.id) }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['plugin.disable \'{"id":"soksak-plugin-<id>"}\''],
    danger: "destructive",
    handler: (p) => usePlugins.getState().disable(resolveShortId(String(p.id)) ?? String(p.id)),
  });

  register("plugin.consent.summary", {
    description:
      "Fetch the consent display data for a plugin — permissions, contribution counts, and dependency tree (plugins + libraries). Same single source used by the consent modal. Use to inspect what the user will be asked to consent to.",
    triggers: { ko: "플러그인 동의 요약 권한 확인" },
    params: { id: { type: "string", description: "Plugin id", required: true } },
    returns: "{ id, version, permissions, contributes, dependencies:{plugins,libraries} }",
    message: (d) => tmsg("msg.plugin.consent.summary", { id: String(d.id) }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['plugin.consent.summary \'{"id":"soksak-plugin-<id>"}\''],
    handler: (p) => {
      const s = usePlugins.getState();
      const plug = s.plugins[resolveShortId(String(p.id)) ?? String(p.id)];
      if (!plug) return notFound(tmsg("msg.plugin.notFoundId", { id: String(p.id) }));
      return consentSummary(plug.manifest, s.plugins);
    },
  });

  register("plugin.consent.revoke", {
    description:
      "Revoke a recorded consent, putting the plugin back into a re-consent-required state. If active, the plugin and all transitive dependents are disabled first. Safe because it only reduces permissions.",
    triggers: { ko: "동의 철회 취소 revoke 권한 제거" },
    params: { id: { type: "string", description: "Plugin id", required: true } },
    returns: "{ id }",
    message: (d) => tmsg("msg.plugin.consent.revoke", { id: String(d.id) }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['plugin.consent.revoke \'{"id":"soksak-plugin-<id>"}\''],
    danger: "destructive",
    handler: (p) => usePlugins.getState().revokeConsent(resolveShortId(String(p.id)) ?? String(p.id)),
  });

  register("plugin.consent.grant", {
    description:
      "Grant consent for a plugin's requested permissions — the CLI/headless equivalent of approving the consent modal. Records consent (manifest version + permissions) so the plugin can then be enabled without opening the webview. Review first with plugin.consent.summary. Dev-sourced plugins bypass consent and do not need this. Danger-gated: granting permissions is a deliberate, security-sensitive act.",
    triggers: { ko: "동의 승인 허가 grant 권한 부여 부여" },
    params: { id: { type: "string", description: "Plugin id", required: true } },
    returns: "{ id, granted }",
    message: (d) =>
      d.granted
        ? tmsg("msg.plugin.consent.grant", { id: String(d.id) })
        : tmsg("msg.plugin.consent.grant.failed", { id: String(d.id) }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['plugin.consent.grant \'{"id":"soksak-plugin-<id>"}\''],
    danger: "destructive",
    handler: (p) => {
      const s = usePlugins.getState();
      const pid = resolveShortId(String(p.id)) ?? String(p.id);
      if (!s.plugins[pid]) return notFound(tmsg("msg.plugin.notFoundId", { id: pid }));
      const granted = s.grantConsent(pid);
      return { id: pid, granted };
    },
  });

  register("plugin.consent.chain", {
    description:
      "Return the ordered list of plugins still needing consent before the target plugin can be activated (dependencies first). Dev-sourced and already-consented plugins are excluded. An empty pending array means the plugin can be activated immediately.",
    triggers: { ko: "동의 체인 미동의 순서 활성화 전" },
    params: { id: { type: "string", description: "Plugin id", required: true } },
    returns: "{ id, pending }",
    message: (d) =>
      ((d.pending as unknown[]) ?? []).length === 0
        ? tmsg("msg.plugin.consent.chain.ready", { id: String(d.id) })
        : tmsg("msg.plugin.consent.chain.pending", { n: ((d.pending as unknown[]) ?? []).length }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['plugin.consent.chain \'{"id":"soksak-plugin-<id>"}\''],
    handler: (p) => {
      const s = usePlugins.getState();
      const pid = resolveShortId(String(p.id)) ?? String(p.id);
      if (!s.plugins[pid]) return notFound(tmsg("msg.plugin.notFoundId", { id: pid }));
      return { id: pid, pending: pendingConsentChain(pid, s.plugins, s.consents) };
    },
  });

  register("plugin.consent.preview", {
    description:
      "Open the consent modal for inspection without activating the plugin. Use when a human wants to review permissions, contributions, and dependencies before deciding to consent. Idempotent — call again or pass an empty id to close.",
    triggers: { ko: "동의 모달 미리보기 확인 권한 검사" },
    params: {
      id: {
        type: "string",
        description: "Plugin id. Empty string or omit to close the modal.",
      },
    },
    returns: "{ id, shown }",
    message: (d) =>
      d.shown
        ? tmsg("msg.plugin.consent.preview.shown")
        : tmsg("msg.plugin.consent.preview.closed"),
    errors: ["TARGET_NOT_FOUND"],
    examples: [
      'plugin.consent.preview \'{"id":"soksak-plugin-<id>"}\'',
      'plugin.consent.preview \'{"id":""}\'  # close',
    ],
    handler: (p) => {
      const id = (p.id as string | undefined) ?? "";
      if (!id) {
        useUi.getState().setConsentPreview(null);
        return { id: "", shown: false };
      }
      if (!usePlugins.getState().plugins[id]) return notFound(tmsg("msg.plugin.notFoundId", { id }));
      useUi.getState().setConsentPreview(id);
      return { id, shown: true };
    },
  });

  // Project axis resolution — the settings storage key is root (persistent identity) while the axis
  // the answer names is id. They are different facts, so both are returned and the response splits
  // them into projectId and projectRoot. Omitted means the active project.
  const projectScope = (
    projectId?: string,
  ): { id: string; root: string } | null => {
    const s = useSessions.getState();
    const id = projectId ?? s.activeId;
    const found = s.projects.find((t) => t.id === id);
    return found?.root ? { id: found.id, root: found.root } : null;
  };

  register("plugin.settings.schema", {
    description:
      "Return the plugin's settings schema from its manifest configuration block. This is the single source of truth from which both UI and CLI derive setting fields and validation rules.",
    triggers: { ko: "플러그인 설정 스키마 구성 항목" },
    params: { id: { type: "string", description: "Plugin id", required: true } },
    returns: "{ id, configuration: ConfigSetting[] }",
    message: (d) => tmsg("msg.plugin.settings.schema", { n: ((d.configuration as unknown[]) ?? []).length }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['plugin.settings.schema \'{"id":"soksak-plugin-<id>"}\''],
    handler: (p) => {
      const plug = usePlugins.getState().plugins[p.id as string];
      if (!plug) return notFound(tmsg("msg.plugin.notFoundId", { id: String(p.id) }));
      return { id: p.id, configuration: plug.manifest.configuration ?? [] };
    },
  });

  register("plugin.settings.get", {
    description:
      "Read plugin setting values at a given scope. Scope 'effective' (default) merges global defaults with project overrides. Omit key to retrieve all settings at once.",
    triggers: { ko: "플러그인 설정 조회 읽기 값 확인" },
    params: {
      id: { type: "string", description: "Plugin id", required: true },
      key: { type: "string", description: "Setting key. Omit to return all settings." },
      scope: { type: "string", description: "effective (default, merges global+project) | global | project", enum: ["effective", "global", "project"] },
      project: { type: "string", description: "Project id. Defaults to active project. Applies to project and effective scopes." },
    },
    returns: "{ id, scope, projectId, values } or { id, scope, projectId, key, value }",
    message: (d) =>
      d.key !== undefined
        ? tmsg("msg.plugin.settings.get.one", { key: String(d.key), value: String(d.value) })
        : tmsg("msg.plugin.settings.get.all", { n: Object.keys((d.values as Record<string, unknown>) ?? {}).length }),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: [
      'plugin.settings.get \'{"id":"soksak-plugin-<id>"}\'',
      'plugin.settings.get \'{"id":"soksak-plugin-<id>","key":"defaultAgent","scope":"global"}\'',
    ],
    handler: (p) => {
      const plug = usePlugins.getState().plugins[p.id as string];
      if (!plug) return notFound(tmsg("msg.plugin.notFoundId", { id: String(p.id) }));
      const scope = (p.scope as string | undefined) ?? "effective";
      const target = projectScope(p.project as string | undefined);
      const root = target?.root;
      const ps = usePluginSettings.getState();
      const defs = configDefaults(plug.manifest);
      const one = (key: string) => {
        if (scope === "global") return ps.getGlobal(p.id as string, key);
        if (scope === "project") return root ? ps.getProject(root, p.id as string, key) : undefined;
        return ps.effective(p.id as string, key, defs[key], root);
      };
      const key = p.key as string | undefined;
      const projectId = target?.id ?? null;
      if (key !== undefined) {
        if (!(key in defs)) return invalid(tmsg("msg.plugin.settings.keyMissing", { key }));
        return { id: p.id, scope, projectId, key, value: one(key) ?? null };
      }
      const values: Record<string, unknown> = {};
      for (const k of Object.keys(defs)) values[k] = one(k) ?? null;
      return { id: p.id, scope, projectId, values };
    },
  });

  register("plugin.settings.set", {
    description:
      "Write a plugin setting value after schema validation. Scope defaults to global; use project to override per-project. Validation failures are rejected without saving.",
    triggers: { ko: "플러그인 설정 변경 저장 set 값 지정" },
    params: {
      id: { type: "string", description: "Plugin id", required: true },
      key: { type: "string", description: "Setting key", required: true },
      value: { type: "json", description: "Value to set (boolean | number | string — must match schema type)", required: true },
      scope: { type: "string", description: "global (default) | project", enum: ["global", "project"] },
      project: { type: "string", description: "Project id. Defaults to active project. Applies when scope=project." },
    },
    returns: "{ id, scope, key, value, projectId?, projectRoot? }",
    message: (d) => tmsg("msg.plugin.settings.set", { key: String(d.key), value: String(d.value) }),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: [
      'plugin.settings.set \'{"id":"soksak-plugin-<id>","key":"defaultAgent","value":"codex"}\'',
      'plugin.settings.set \'{"id":"soksak-plugin-<id>","key":"defaultAgent","value":"gemini","scope":"project"}\'',
    ],
    handler: (p) => {
      const plug = usePlugins.getState().plugins[p.id as string];
      if (!plug) return notFound(tmsg("msg.plugin.notFoundId", { id: String(p.id) }));
      const setting = configSettingOf(plug.manifest, p.key as string);
      if (!setting) return invalid(tmsg("msg.plugin.settings.keyUndeclared", { key: String(p.key) }));
      const v = validateSettingValue(setting, p.value);
      if (!v.ok) return invalid(v.error);
      const scope = (p.scope as string | undefined) ?? "global";
      const ps = usePluginSettings.getState();
      if (scope === "project") {
        const target = projectScope(p.project as string | undefined);
        if (!target) return invalid(tmsg("msg.plugin.settings.projectRootUnresolved"));
        ps.setProject(target.root, p.id as string, p.key as string, v.value);
        return {
          id: p.id,
          scope,
          key: p.key,
          value: v.value,
          projectId: target.id,
          projectRoot: target.root,
        };
      }
      ps.setGlobal(p.id as string, p.key as string, v.value);
      return { id: p.id, scope, key: p.key, value: v.value };
    },
  });

  register("plugin.settings.reset", {
    description:
      "Remove a setting override and restore the default value. Scope defaults to global. Omit key to reset all settings at once.",
    triggers: { ko: "플러그인 설정 초기화 리셋 기본값" },
    params: {
      id: { type: "string", description: "Plugin id", required: true },
      key: { type: "string", description: "Setting key. Omit to reset all settings." },
      scope: { type: "string", description: "global (default) | project", enum: ["global", "project"] },
      project: { type: "string", description: "Project id. Defaults to active project. Applies when scope=project." },
    },
    returns: "{ id, scope, key, projectId?, projectRoot? }",
    message: (d) =>
      d.key
        ? tmsg("msg.plugin.settings.reset.one", { key: String(d.key) })
        : tmsg("msg.plugin.settings.reset.all"),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: ['plugin.settings.reset \'{"id":"soksak-plugin-<id>","key":"defaultAgent"}\''],
    handler: (p) => {
      const plug = usePlugins.getState().plugins[p.id as string];
      if (!plug) return notFound(tmsg("msg.plugin.notFoundId", { id: String(p.id) }));
      const scope = (p.scope as string | undefined) ?? "global";
      const ps = usePluginSettings.getState();
      const key = p.key as string | undefined;
      if (scope === "project") {
        const target = projectScope(p.project as string | undefined);
        if (!target) return invalid(tmsg("msg.plugin.settings.projectRootUnresolved"));
        ps.resetProject(target.root, p.id as string, key);
        return {
          id: p.id,
          scope,
          key: key ?? null,
          projectId: target.id,
          projectRoot: target.root,
        };
      }
      ps.resetGlobal(p.id as string, key);
      return { id: p.id, scope, key: key ?? null };
    },
  });

  register("plugin.settings.open", {
    description:
      "Open the unified settings modal. With a plugin id, navigates directly to that plugin's settings section. Omit id for the general preferences section. Pass an empty string to close the modal. Idempotent.",
    triggers: { ko: "설정 열기 환경설정 모달 플러그인 설정 패널" },
    params: {
      id: { type: "string", description: "Plugin id (omit for general preferences, empty string to close)" },
    },
    returns: "{ section }",
    message: (d) =>
      d.section
        ? tmsg("msg.plugin.settings.open.section", { section: String(d.section) })
        : tmsg("msg.plugin.settings.open.closed"),
    errors: ["TARGET_NOT_FOUND"],
    examples: [
      "plugin.settings.open",
      'plugin.settings.open \'{"id":"soksak-plugin-<id>"}\'',
    ],
    handler: (p) => {
      const raw = p.id as string | undefined;
      if (raw === "") {
        useUi.getState().setSettingsSection(null);
        return { section: null };
      }
      const section = raw ?? "general";
      if (section !== "general" && !usePlugins.getState().plugins[section]) {
        return notFound(tmsg("msg.plugin.notFoundId", { id: section }));
      }
      useUi.getState().setSettingsSection(section);
      return { section };
    },
  });

  register("plugin.reload", {
    description:
      "Rescan the plugins directory and reactivate every plugin whose consent is still valid; the response reports which manifests were rejected during the rescan and why. With id, reload only that one plugin instead: its plugin.json is read from disk again and re-validated, then the plugin is disabled and re-enabled (same consent gate as plugin.enable) without rescanning the directory or touching any other plugin. A manifest that no longer validates is refused with its reason instead of activating fresh code against a stale declaration. Use after manually editing plugin files or adding new plugin folders.",
    triggers: { ko: "플러그인 재적재 리로드 새로고침" },
    params: {
      id: {
        type: "string",
        description: "Plugin id to reload individually. Omit to rescan the plugins directory and reactivate every plugin.",
      },
    },
    returns:
      "{ reloaded, rejected: [{id, reason}] } (id omitted — full rescan; rejected lists directories whose manifest failed validation) | { id, status } (id given — that plugin only; a failure reason is in the response message)",
    message: (d) => (d.id ? tmsg("msg.plugin.reload", { n: 1 }) : tmsg("msg.plugin.reload", { n: Number(d.reloaded) })),
    errors: ["TARGET_NOT_FOUND", "CONSENT_REQUIRED"],
    examples: ["plugin.reload", 'plugin.reload \'{"id":"soksak-plugin-<id>"}\''],
    handler: async (p) => {
      if (p.id) {
        const id = resolveShortId(String(p.id)) ?? String(p.id);
        if (!usePlugins.getState().plugins[id]) return notFound(tmsg("msg.plugin.notFoundId", { id }));
        return usePlugins.getState().reloadOne(id);
      }
      await usePlugins.getState().reload();
      const s = usePlugins.getState();
      return {
        reloaded: Object.keys(s.plugins).length,
        rejected: s.rejected.map((r) => ({ id: r.dir, reason: r.errors.join("; ") })),
      };
    },
  });

  register("plugin.view.open", {
    description:
      "Open a plugin view in the specified placement. Defaults to the view's declared defaultPlacement when placement is omitted. View implementation and placement are orthogonal (spec §0-6).",
    triggers: { ko: "플러그인 뷰 열기 사이드바 칸 탭 보기" },
    params: {
      viewKey: {
        type: "string",
        description: 'Global view key in the form "<pluginId>.<viewId>"',
        required: true,
      },
      placement: {
        type: "string",
        description: "Where to place the view. Defaults to the view's defaultPlacement.",
        enum: VIEW_PLACEMENTS,
      },
      project: { type: "string", description: "Project id. Defaults to the active project." },
    },
    returns:
      "{ viewKey, placement, projectId } (sidebar placements) | { viewKey, placement, projectId, paneId, tabId, existing } (content placement)",
    message: (d) => tmsg("msg.plugin.view.open", { view: String(d.viewKey), placement: String(d.placement) }),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: [
      'plugin.view.open \'{"viewKey":"soksak-plugin-<id>.<view>"}\'',
      'plugin.view.open \'{"viewKey":"soksak-plugin-<id>.<view>","placement":"content"}\'',
    ],
    handler: (p) => {
      const s = useSessions.getState();
      const projectId = (p.project as string | undefined) ?? s.activeId;
      const project = s.projects.find((t) => t.id === projectId);
      if (!project) return notFound(tmsg("msg.project.notFoundId", { id: projectId }));
      const key = p.viewKey as string;
      const reg = getRegisteredView(key);
      if (!reg) {
        return notFound(tmsg("msg.plugin.view.notRegistered", { key }));
      }
      const placement =
        (p.placement as ViewPlacement | undefined) ?? reg.decl.defaultPlacement;
      if (!reg.decl.placements.includes(placement)) {
        return invalid(
          tmsg("msg.plugin.view.placementUnsupported", {
            key,
            placement,
            supported: reg.decl.placements.join(", "),
          }),
        );
      }
      // A rail view appears only as the declaration projection of the content feature it is attached
      // to (left rail = projection only). A resident surface is the right rail's job and is not an
      // open target until that renderer exists.
      if (placement === "rail") {
        return invalid(
        return invalid(tmsg("msg.plugin.view.railNotOpenable", { key }));
        );
      }
      if (placement === "rail-footer") {
        return invalid(
        return invalid(tmsg("msg.plugin.view.railFooterNotOpenable", { key }));
        );
      }
      // content: as a tab of the pane — drag, split, and close behave like any other tab.
      const r = s.openPluginView(
        projectId,
        reg.pluginId,
        reg.decl.id,
        localize(reg.decl.title),
      );
      if (!r.ok) return r;
      return {
        viewKey: key,
        placement,
        projectId,
        paneId: r.groupId,
        tabId: r.viewId,
        existing: r.existing,
      };
    },
  });

  register("plugin.view.close", {
    description:
      "Close a plugin view. Sidebar placements are deselected and revert to the file tree. Content placements close the tab in every pane where the view is open.",
    triggers: { ko: "플러그인 뷰 닫기 사이드바 탭 제거" },
    params: {
      viewKey: {
        type: "string",
        description: 'Global view key in the form "<pluginId>.<viewId>"',
        required: true,
      },
      project: { type: "string", description: "Project id. Defaults to the active project." },
    },
    returns: "{ viewKey, projectId, closed: [placement list], tabIds: [closed content tab ids] }",
    message: (d) => tmsg("msg.plugin.view.close", { view: String(d.viewKey), n: ((d.closed as unknown[]) ?? []).length }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['plugin.view.close \'{"viewKey":"soksak-plugin-<id>.<view>"}\''],
    handler: (p) => {
      const s = useSessions.getState();
      const projectId = (p.project as string | undefined) ?? s.activeId;
      const project = s.projects.find((t) => t.id === projectId);
      if (!project) return notFound(tmsg("msg.project.notFoundId", { id: projectId }));
      const key = p.viewKey as string;
      const closed: string[] = [];
      const tabIds: string[] = [];
      if (project.rightView === key) {
        s.setRightView(projectId, null);
        closed.push("sidebar-right");
      }
      // The left sidebar is registry-driven (the layout only places) — an individual close reports
      // membership only. The actual removal is handled by reconcileSidebar when the plugin is
      // disabled or unregistered.
      if (hasSidebarViewKey(project.leftLayout, key)) {
        closed.push("sidebar-left");
      }
      // content placement: closes every tab of this plugin view across all spaces.
      for (const space of project.spaces) {
        for (const g of allGroups(space.layout)) {
          for (const v of g.tabs) {
            if (
              v.kind === "plugin" &&
              `${v.pluginId}.${v.view}` === key
            ) {
              const r = s.closeView(projectId, v.id);
              if (r.ok) {
                closed.push("content");
                tabIds.push(v.id);
              }
            }
          }
        }
      }
      return { viewKey: key, projectId, closed, tabIds };
    },
  });


  register("plugin.dev.load", {
    description:
      "Select an existing absolute plugin workspace as this identity home's development source, validate its plugin.json, and load it without replacing a separate official installation. Development (dev) identity only — debug and release homes verify published installs (home-lane rule). Dev-sourced plugins bypass the consent gate (spec §0-5 exception).",
    triggers: { ko: "플러그인 개발 로드 dev 임시 적재" },
    params: {
      path: { type: "string", description: "Absolute path to the plugin directory", required: true },
    },
    returns: "{ id, dir }",
    message: (d) => tmsg("msg.plugin.dev.load", { id: String(d.id) }),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: ['plugin.dev.load \'{"path":"/path/to/my-plugin"}\''],
    danger: "inject",
    handler: async (p) => {
      // Home lane enforcement: dev source loading is dev-identity only — debug and release homes
      // verify published installs.
      // (The front boundary of the same principle as the core unit_dev gate — the command registry
      // is the only entry.)
      const env = (await invoke("app_environment")) as { coreBuild?: string };
      if (env?.coreBuild !== "dev") {
        return {
          ok: false,
          code: "INVALID_PARAMS",
          message: tmsg("msg.plugin.dev.load.devOnly", { build: env?.coreBuild ?? "?" }),
        };
      }
      return usePlugins.getState().devLoad(p.path as string);
    },
  });

  register("plugin.dev.create", {
    description:
      "Scaffold a new plugin in the current identity home's workspaces/plugins/<id> directory, register that absolute directory as its development source, initialize Git, and reload plugins. Available in every build, not only development builds.",
    triggers: { ko: "플러그인 개발 새로 만들기 스캐폴드 scaffold 생성" },
    params: {
      id: { type: "string", description: "Plugin id (must match ^[a-z0-9][a-z0-9-]*$)", required: true },
    },
    returns: "{ ok, dir, pluginId }",
    message: (d) => tmsg("msg.plugin.dev.create", { id: String(d.pluginId) }),
    errors: ["INVALID_PARAMS"],
    examples: ['plugin.dev.create \'{"id":"soksak-plugin-<id>"}\''],
    danger: "inject",
    handler: async (p) => {
      const r = await invoke<{ dir: string; dir_name: string }>("plugin_scaffold", {
        id: p.id as string,
      });
      await usePlugins.getState().reload();
      return { ok: true, dir: r.dir, pluginId: r.dir_name };
    },
  });

  // The in-app runtime surface of declared≡actual (M5). The publish-time schema gate is
  // soksak-validate (headless, plugins/spec) — separate. This queries, over the e2e socket, whether
  // the declared commands and nodes are actually registered and exposed.
  register("plugin.conformance", {
    description:
      "Report a plugin's declared-vs-actual conformance: manifest declarations vs what is actually registered/exposed at runtime, across every register-gated contribution (commands/views/fileViewers/iconSets) plus DOM nodes. Read-only diagnosis. The publish-time schema gate is soksak-validate (headless, plugins/spec); this is the in-app runtime surface.",
    triggers: { ko: "플러그인 정합성 선언 실제 conformance" },
    params: { id: { type: "string", required: true, description: tmsg("cmd.plugin.conformance.param.id") } },
    returns:
      "{ id, commands/views/fileViewers/iconSets: { declared, registered, missing }, nodes: { declared, wired, missing, orphan }, implements: { declared, violations }, c2: { violations: [{ rule, detail }], viewStatus: { mounted, reported, unreported, undeclared: [{ viewId, view, code }] } }, calls: { literals, dynamic, unresolved } }",
    message: (d) => tmsg("msg.plugin.conformance", { id: String(d.id) }),
    examples: ["plugin.conformance soksak-plugin-<id>"],
    handler: async (p) => {
      const id = p.id as string;
      const plug = usePlugins.getState().plugins[id];
      if (!plug) return notFound(tmsg("msg.plugin.notFoundId", { id }));
      const c = plug.manifest.contributes;
      // commands: declared (contributes.commands) vs actually registered (the plugin.<id>. prefix in
      // catalogJson).
      const declaredCmds = c.commands.map((x) => x.name);
      const prefix = pluginCommandName(id, "");
      const registeredCmds = catalogJson()
        .map((e) => e.name)
        .filter((n) => n.startsWith(prefix))
        .map((n) => n.slice(prefix.length));
      // nodes: declared (contributes.nodes) vs actually wired (this plugin's view nodes in
      // collectExposed).
      //   address = win/<win>/<region>/view/<id>.<viewId>/node/<path> → "/view/<id>." selects this
      //   plugin's nodes only.
      const declaredNodes = c.nodes.map((x) => x.id);
      const wired = collectExposed()
        .filter((n) => n.address.includes(`/view/${id}.`))
        .map((n) => n.nodePath);
      // views/fileViewers/iconSets: declared (contributes) vs actual registry registration
      // (register-gated).
      //   actual = this plugin's registrations in each registry (not a call log). gateContribution
      //   blocks undeclared, so actual ⊆ declared — only missing (declared but not registered) is
      //   possible, and there is no orphan.
      const declaredViews = c.views.map((x) => x.id);
      const declaredFv = c.fileViewers.map((x) => x.id);
      const declaredIcons = c.iconSets.map((x) => x.id);
      const regViews = registeredViewIds(id);
      const regFv = registeredFileViewerIds(id);
      const regIcons = registeredIconSetIds(id);
      // ── Runtime judgment surface of composition law C2 (three transparency rules) ──────────────
      // The three static rules are judged from the manifest; view-status can be judged only on a
      // mounted content view — this command is the sole enforcement point of the view-status rule.
      // The judgment is declared≡reported (viewStatusConformance):
      //   declared (contributes.views[].status) but not reported → view-status violation,
      //   reported outside the declaration (absent, [], or a code not in the list) →
      //   content-view-status missing-declaration warning (runtime measurement — the static judgment
      //   sees only a missing declaration, and a missing code shows up here only).
      // Only content-placed views are carried in the sessions layout (setStatus is a no-op for the
      // sidebar), so everything caught here is a content view.
      const observed: ViewStatusObservation[] = [];
      for (const t of useSessions.getState().projects)
        for (const ca of t.spaces)
          for (const g of allGroups(ca.layout))
            for (const v of g.tabs)
              if (v.kind === "plugin" && v.pluginId === id)
                observed.push({ viewId: v.id, view: v.view, code: v.status?.code ?? null });
      const mounted = observed.map((v) => v.viewId);
      const reported = observed.filter((v) => v.code !== null).map((v) => v.viewId);
      const { unreported, undeclared } = viewStatusConformance(c.views, observed);
      const c2Violations: TransparencyViolation[] = [
        ...transparencyViolations(c),
      ];
      // unreported is information, not a violation — on the status axis null means nothing to report
      // (normal), and a null in an instantaneous observation only means a transient (connecting and
      // the like) was faster than the observation window. The single violation is a code reported
      // outside the declaration (undeclared) — that is all of declared≡reported a machine can judge.
      if (undeclared.length > 0) {
        c2Violations.push({
          rule: "view-status",
          detail: `reported status code absent from the declaration: ${undeclared
            .map((u) => `${u.viewId}(${u.view})=${u.code}`)
            .join(", ")} — declare it in contributes.views[].status`,
        });
      }
      return {
        id,
        commands: {
          declared: declaredCmds,
          registered: registeredCmds,
          missing: missingRegistrations(declaredCmds, registeredCmds),
          // message standard (§3): commands that supply no answer of their own and degrade to a
          // label (must be filled in before publishing).
          messagesMissing: registeredCmds.filter((n) =>
            commandsMissingMessage.has(pluginCommandName(id, n)),
          ),
        },
        views: {
          declared: declaredViews,
          registered: regViews,
          missing: missingRegistrations(declaredViews, regViews),
        },
        fileViewers: {
          declared: declaredFv,
          registered: regFv,
          missing: missingRegistrations(declaredFv, regFv),
        },
        iconSets: {
          declared: declaredIcons,
          registered: regIcons,
          missing: missingRegistrations(declaredIcons, regIcons),
        },
        nodes: {
          declared: declaredNodes,
          wired,
          ...nodeConformance(declaredNodes, wired),
        },
        // implements (C3 L2): verifying the surfaces a contract requires is the contract owner's job
        // — the core reports only the validity of the declaration (shape, syntax, duplication),
        // generically. Implementer lookup is plugin.implementers.
        implements: {
          declared: manifestImplements(plug.manifest),
          violations: implementsViolations(rawImplements(plug.manifest)),
        },
        // This plugin's judgment for the three C2 transparency rules — the three static rules plus
        // runtime (view-status, declared≡reported).
        // The headless static scan is scripts/gates/c2-transparency-scan.mjs; declared≡reported is
        // seen on this surface only.
        c2: {
          violations: c2Violations,
          viewStatus: { mounted, reported, unreported, undeclared },
        },
        // Resolution of the names being called — the other half of declared≡actual. Looking only at
        // what is registered lets a plugin that calls a name the core renamed or dropped die quietly
        // (measured: after the browser was dropped, plugins calling browser.eval stayed dead).
        // Assembled calls (dynamic) cannot be seen statically, so they are counted and exposed.
        calls: await callConformance(plug),
      };
    },
  });
}

// Collects the command names the bundle calls and judges whether they resolve. known = the core
// catalog + **the declarations of every installed plugin** (a declaration remains even when its
// target is disabled) — so what is caught here is only a name that exists nowhere. A contract plugin
// with no entry has no code to call, so its judgment is empty.
async function callConformance(plug: {
  dir: string;
  manifest: { entry: string | null };
}): Promise<{ literals: string[]; dynamic: number; unresolved: string[] }> {
  const entry = plug.manifest.entry;
  if (!entry) return { literals: [], dynamic: 0, unresolved: [] };
  let bundle: string;
  try {
    const data = await invoke<{ content: string }>("read_text_file", {
      path: `${plug.dir}/${entry}`,
    });
    bundle = data.content;
  } catch {
    return { literals: [], dynamic: 0, unresolved: [] };
  }
  const scan = executedCommandNames(bundle);
  const known = new Set<string>(catalogJson().map((e) => e.name));
  for (const other of Object.values(usePlugins.getState().plugins)) {
    for (const cmd of other.manifest.contributes.commands) {
      known.add(pluginCommandName(other.manifest.id, cmd.name));
    }
  }
  return { ...scan, unresolved: unresolvedCommandCalls(scan.literals, known) };
}
