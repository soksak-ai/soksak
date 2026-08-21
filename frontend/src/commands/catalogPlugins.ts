// plugin.* commands — plugin management (list/install/update/remove/enable/disable/reload/dev).
// Consent (§0-5) is a human act only: remote enable without recorded consent is refused with
// CONSENT_REQUIRED, and no consent-granting command exists (UI consent modal only).
// plugin.view.* placement commands are registered in M_P5 (right sidebar).

import { invoke } from "../framework";
import { pendingConsentChain, usePlugins, type PluginRuntime } from "../state/plugins";
import { allGroups, useSessions } from "../state/sessions";
import { hasSidebarView as hasSidebarViewKey } from "../state/sidebarLayout";
import { getRegisteredView, registeredViewIds } from "../plugins/viewRegistry";
import { registeredIconSetIds } from "../ui/icons/registry";
import { getRegisteredProgram, listPrograms, useProgramRegistry } from "../plugins/programRegistry";
import { localize, tmsg, key} from "../i18n";
import {
  configDefaults,
  configSettingOf,
  validateSettingValue,
} from "../plugins/spec";
import { usePluginSettings } from "../state/pluginSettings";
import { useRegistry } from "../state/registry";
import { currentWindowLabel } from "../lib/webviewLabels";
import {
  depSummary,
  versionIssues,
  type DepNode,
} from "../plugins/dependencyGraph";
import { executedCommandNames, unresolvedCommandCalls } from "../plugins/conformance";
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
import { awaitViewMounted } from "../plugins/viewFocus";

// Installed/dev runtime → dependency graph node (based on manifest dependencies).
function depNodes(): DepNode[] {
  return Object.values(usePlugins.getState().plugins).map((p) => ({
    id: p.manifest.id,
    version: p.manifest.version,
    dependencies: p.manifest.dependencies ?? {},
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
    implements: p.manifest.implements ?? [],
    consumes: p.manifest.consumes ?? [],
    views: p.manifest.contributes.views.map((v) => ({
      id: v.id,
      title: v.title,
      surfaces: v.surfaces,
    })),
    commands: p.manifest.contributes.commands.map((c) => c.name),
    dir: p.dir,
  };
}

export function registerPluginCatalog(): void {
  register("program.list", {
    description: key("cmd.program.list.desc"),
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
        ? { note: "control-plane window loads no plugins — query a workspace window (w-*) or pass --window" }
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
    description: key("cmd.program.wait.desc"),
    triggers: { ko: "프로그램 준비 대기 플러그인 등록 이벤트" },
    params: {
      id: { type: "string", description: key("cmd.program.wait.param.id"), required: true },
      timeoutMs: {
        type: "number",
        description: key("cmd.program.wait.param.timeoutMs"),
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

  register("tab.mount.wait", {
    description: key("cmd.tab.mount.wait.desc"),
    triggers: { ko: "탭 마운트 준비 대기 복원 탭 준비" },
    params: {
      tab: { type: "string", description: key("cmd.tab.mount.wait.param.tab"), required: true },
      timeoutMs: {
        type: "number",
        description: key("cmd.tab.mount.wait.param.timeoutMs"),
        default: 20_000,
      },
    },
    returns: "{ tabId, mounted:true }",
    errors: ["INVALID_PARAMS", "TIMEOUT"],
    message: (data) => tmsg("msg.tab.mount.wait", { tab: String(data.tabId) }),
    examples: [`tab.mount.wait '{"tab":"tab-abc123","timeoutMs":20000}'`],
    handler: async (params) => {
      const tab = String(params.tab ?? "");
      const timeoutMs = params.timeoutMs === undefined ? 20_000 : Number(params.timeoutMs);
      if (!tab || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
        return invalid(tmsg("msg.tab.mount.wait.paramsInvalid"));
      }
      if (!await awaitViewMounted(tab, timeoutMs)) {
        return { ok: false as const, code: "TIMEOUT" as const, message: tmsg("msg.tab.mount.wait.timeout", { tab }) };
      }
      return { tabId: tab, mounted: true };
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
      { cmd: "window.workspaces", why: tmsg("hint.error.pluginControlPlane") },
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

  // The manager hung off the right sidebar's icon rail until 2026-08-17. The rail went with the
  // region rule (A2a) and the manager went to a modal — with nothing calling it, which left install,
  // consent, enable, update and the refusal reasons unreachable from anywhere. A surface the core
  // mounts and nothing opens is a surface that is gone.
  register("plugin.manager", {
    description: key("cmd.plugin.manager.desc"),
    triggers: { ko: "플러그인 관리 설치 마켓 열기 닫기" },
    params: {
      open: { type: "boolean", description: key("cmd.plugin.manager.param.open") },
    },
    returns: "{ open }",
    message: (d) => (d.open ? tmsg("msg.plugin.manager.opened") : tmsg("msg.plugin.manager.closed")),
    examples: ["plugin.manager", 'plugin.manager \'{"open":false}\''],
    handler: (p) => {
      const open = typeof p.open === "boolean" ? p.open : !useUi.getState().pluginManagerOpen;
      useUi.getState().setPluginManagerOpen(open);
      return { open };
    },
  });

  register("plugin.list", {
    description: key("cmd.plugin.list.desc"),
    triggers: { ko: "플러그인 목록 설치된 확장 상태" },
    params: {},
    returns: "{ plugins: [{id, name, version, status, permissions, implements, consumes, …}], rejected: [{dir, errors}] }",
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
          ? { note: "control-plane window loads no plugins — query a workspace window (w-*) or pass --window" }
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
    description: key("cmd.registry.list.desc"),
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
    description: key("cmd.registry.add.desc"),
    triggers: { ko: "레지스트리 추가 공개 비공개 신뢰키 vault" },
    params: {
      descriptor: {
        type: "json",
        required: true,
        description: key("cmd.registry.add.param.descriptor"),
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
    description: key("cmd.registry.remove.desc"),
    triggers: { ko: "레지스트리 제거 삭제" },
    params: {
      registryId: { type: "string", required: true, description: key("cmd.registry.remove.param.registryId") },
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
    description: key("cmd.registry.refresh.desc"),
    triggers: { ko: "레지스트리 새로고침 서명 검증 인증" },
    params: {
      registryId: { type: "string", description: key("cmd.registry.refresh.param.registryId") },
      force: { type: "boolean", description: key("cmd.registry.refresh.param.force"), default: true },
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
    description: key("cmd.registry.status.desc"),
    triggers: { ko: "레지스트리 상태 오류 이벤트 인증" },
    params: {
      registryId: { type: "string", description: key("cmd.registry.status.param.registryId") },
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
    description: key("cmd.plugin.catalog.desc"),
    triggers: { ko: "플러그인 카탈로그 레지스트리 설치 가능 목록 마켓 검색" },
    params: {
      registryId: {
        type: "string",
        description: key("cmd.plugin.catalog.param.registryId"),
      },
      refresh: {
        type: "boolean",
        description: key("cmd.plugin.catalog.param.refresh"),
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
    description: key("cmd.command.docs.desc"),
    triggers: { ko: "명령 사용법 도움말 목록 코어 플러그인 미설치" },
    params: {
      name: {
        type: "string",
        description: key("cmd.command.docs.param.name"),
        required: false,
      },
      refresh: {
        type: "boolean",
        description: key("cmd.command.docs.param.refresh"),
      },
      lang: {
        type: "string",
        enum: ["en", "ko"],
        description: key("cmd.command.docs.param.lang"),
      },
    },
    returns:
      "{ command: spec } when name is given; otherwise { core: [spec], plugins: { [pluginId]: [spec] }, registry: [...] }",
    message: (d) =>
      d.command
        ? tmsg("msg.command.docs.one", { name: String((d.command as { name?: unknown }).name ?? "") })
        : tmsg("msg.command.docs", {
            core: ((d.core as unknown[]) ?? []).length,
            registry: ((d.registry as unknown[]) ?? []).length,
          }),
    examples: ["command.docs", 'command.docs \'{"name":"window.snapshot"}\'', 'command.docs \'{"lang":"ko"}\''],
    handler: async (p) => {
      const reg = useRegistry.getState();
      await reg.refresh(p.refresh === true).catch(() => {});
      const st = useRegistry.getState();
      const installed = usePlugins.getState().plugins;
      const all = catalogJson() as { name: string }[];
      const requested = typeof p.name === "string" ? p.name.trim() : "";
      if (requested) {
        const command = all.find((entry) => entry.name === requested);
        if (!command) {
          return { ok: false as const, code: "UNKNOWN_COMMAND", message: tmsg("msg.command.unknown", { name: requested }) };
        }
        return { command };
      }
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
    description: key("cmd.plugin.install.desc"),
    triggers: { ko: "플러그인 설치 추가 install" },
    params: {
      source: {
        type: "string",
        description: key("cmd.plugin.install.param.source"),
      },
      registryId: { type: "string", description: key("cmd.plugin.install.param.registryId") },
      unitId: { type: "string", description: key("cmd.plugin.install.param.unitId") },
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
    description: key("cmd.plugin.update.desc"),
    triggers: { ko: "플러그인 업데이트 갱신 최신화" },
    params: {
      id: { type: "string", description: key("cmd.plugin.update.param.id"), required: true },
      registryId: { type: "string", description: key("cmd.plugin.update.param.registryId") },
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
    description: key("cmd.plugin.remove.desc"),
    triggers: { ko: "플러그인 제거 삭제 uninstall" },
    params: {
      id: { type: "string", description: key("cmd.plugin.remove.param.id"), required: true },
      cascade: {
        type: "boolean",
        description: key("cmd.plugin.remove.param.cascade"),
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
    description: key("cmd.plugin.deps.desc"),
    triggers: { ko: "플러그인 의존성 의존 그래프" },
    params: {
      id: { type: "string", description: key("cmd.plugin.deps.param.id") },
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
        if (!summary) return notFound("msg.plugin.notFoundId", { id: String(p.id) });
        return { ok: true as const, summary };
      }
      return { ok: true as const, issues: versionIssues(nodes) };
    },
  });


  register("plugin.enable", {
    description: key("cmd.plugin.enable.desc"),
    triggers: { ko: "플러그인 활성화 켜기 enable" },
    params: {
      id: { type: "string", description: key("cmd.plugin.enable.param.id"), required: true },
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
    description: key("cmd.plugin.disable.desc"),
    triggers: { ko: "플러그인 비활성화 끄기 disable" },
    params: {
      id: { type: "string", description: key("cmd.plugin.disable.param.id"), required: true },
    },
    returns: "{ id, status }",
    message: (d) => tmsg("msg.plugin.disable", { id: String(d.id) }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['plugin.disable \'{"id":"soksak-plugin-<id>"}\''],
    danger: "destructive",
    handler: (p) => usePlugins.getState().disable(resolveShortId(String(p.id)) ?? String(p.id)),
  });

  register("plugin.consent.summary", {
    description: key("cmd.plugin.consent.summary.desc"),
    triggers: { ko: "플러그인 동의 요약 권한 확인" },
    params: { id: { type: "string", description: key("cmd.plugin.consent.summary.param.id"), required: true } },
    returns: "{ id, version, permissions, contributes, dependencies:{plugins,libraries} }",
    message: (d) => tmsg("msg.plugin.consent.summary", { id: String(d.id) }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['plugin.consent.summary \'{"id":"soksak-plugin-<id>"}\''],
    handler: (p) => {
      const s = usePlugins.getState();
      const plug = s.plugins[resolveShortId(String(p.id)) ?? String(p.id)];
      if (!plug) return notFound("msg.plugin.notFoundId", { id: String(p.id) });
      return consentSummary(plug.manifest, s.plugins);
    },
  });

  register("plugin.consent.revoke", {
    description: key("cmd.plugin.consent.revoke.desc"),
    triggers: { ko: "동의 철회 취소 revoke 권한 제거" },
    params: { id: { type: "string", description: key("cmd.plugin.consent.revoke.param.id"), required: true } },
    returns: "{ id }",
    message: (d) => tmsg("msg.plugin.consent.revoke", { id: String(d.id) }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['plugin.consent.revoke \'{"id":"soksak-plugin-<id>"}\''],
    danger: "destructive",
    handler: (p) => usePlugins.getState().revokeConsent(resolveShortId(String(p.id)) ?? String(p.id)),
  });

  register("plugin.consent.grant", {
    description: key("cmd.plugin.consent.grant.desc"),
    triggers: { ko: "동의 승인 허가 grant 권한 부여 부여" },
    params: { id: { type: "string", description: key("cmd.plugin.consent.grant.param.id"), required: true } },
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
      if (!s.plugins[pid]) return notFound("msg.plugin.notFoundId", { id: pid });
      const granted = s.grantConsent(pid);
      return { id: pid, granted };
    },
  });

  register("plugin.consent.chain", {
    description: key("cmd.plugin.consent.chain.desc"),
    triggers: { ko: "동의 체인 미동의 순서 활성화 전" },
    params: { id: { type: "string", description: key("cmd.plugin.consent.chain.param.id"), required: true } },
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
      if (!s.plugins[pid]) return notFound("msg.plugin.notFoundId", { id: pid });
      return { id: pid, pending: pendingConsentChain(pid, s.plugins, s.consents) };
    },
  });

  register("plugin.consent.preview", {
    description: key("cmd.plugin.consent.preview.desc"),
    triggers: { ko: "동의 모달 미리보기 확인 권한 검사" },
    params: {
      id: {
        type: "string",
        description: key("cmd.plugin.consent.preview.param.id"),
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
      if (!usePlugins.getState().plugins[id]) return notFound("msg.plugin.notFoundId", { id });
      useUi.getState().setConsentPreview(id);
      return { id, shown: true };
    },
  });

  // Workspace axis resolution — the settings storage key is root (persistent identity) while the axis
  // the answer names is id. They are different facts, so both are returned and the response splits
  // them into projectId and workspaceRoot. Omitted means the active workspace.
  const workspaceScope = (
    projectId?: string,
  ): { id: string; root: string } | null => {
    const s = useSessions.getState();
    const id = projectId ?? s.activeId;
    const found = s.workspaces.find((t) => t.id === id);
    return found?.root ? { id: found.id, root: found.root } : null;
  };

  register("plugin.settings.schema", {
    description: key("cmd.plugin.settings.schema.desc"),
    triggers: { ko: "플러그인 설정 스키마 구성 항목" },
    params: { id: { type: "string", description: key("cmd.plugin.settings.schema.param.id"), required: true } },
    returns: "{ id, configuration: ConfigSetting[] }",
    message: (d) => tmsg("msg.plugin.settings.schema", { n: ((d.configuration as unknown[]) ?? []).length }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['plugin.settings.schema \'{"id":"soksak-plugin-<id>"}\''],
    handler: (p) => {
      const plug = usePlugins.getState().plugins[p.id as string];
      if (!plug) return notFound("msg.plugin.notFoundId", { id: String(p.id) });
      return { id: p.id, configuration: plug.manifest.configuration ?? [] };
    },
  });

  register("plugin.settings.get", {
    description: key("cmd.plugin.settings.get.desc"),
    triggers: { ko: "플러그인 설정 조회 읽기 값 확인" },
    params: {
      id: { type: "string", description: key("cmd.plugin.settings.get.param.id"), required: true },
      key: { type: "string", description: key("cmd.plugin.settings.get.param.key") },
      scope: { type: "string", description: key("cmd.plugin.settings.get.param.scope"), enum: ["effective", "global", "workspace"] },
      workspace: { type: "string", description: key("cmd.plugin.settings.get.param.workspace") },
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
      if (!plug) return notFound("msg.plugin.notFoundId", { id: String(p.id) });
      const scope = (p.scope as string | undefined) ?? "effective";
      const target = workspaceScope(p.workspace as string | undefined);
      const root = target?.root;
      const ps = usePluginSettings.getState();
      const defs = configDefaults(plug.manifest);
      const one = (key: string) => {
        if (scope === "global") return ps.getGlobal(p.id as string, key);
        if (scope === "workspace") return root ? ps.getWorkspace(root, p.id as string, key) : undefined;
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
    description: key("cmd.plugin.settings.set.desc"),
    triggers: { ko: "플러그인 설정 변경 저장 set 값 지정" },
    params: {
      id: { type: "string", description: key("cmd.plugin.settings.set.param.id"), required: true },
      key: { type: "string", description: key("cmd.plugin.settings.set.param.key"), required: true },
      value: { type: "json", description: key("cmd.plugin.settings.set.param.value"), required: true },
      scope: { type: "string", description: key("cmd.plugin.settings.set.param.scope"), enum: ["global", "workspace"] },
      workspace: { type: "string", description: key("cmd.plugin.settings.set.param.workspace") },
    },
    returns: "{ id, scope, key, value, projectId?, workspaceRoot? }",
    message: (d) => tmsg("msg.plugin.settings.set", { key: String(d.key), value: String(d.value) }),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: [
      'plugin.settings.set \'{"id":"soksak-plugin-<id>","key":"defaultAgent","value":"codex"}\'',
      'plugin.settings.set \'{"id":"soksak-plugin-<id>","key":"defaultAgent","value":"gemini","scope":"workspace"}\'',
    ],
    handler: (p) => {
      const plug = usePlugins.getState().plugins[p.id as string];
      if (!plug) return notFound("msg.plugin.notFoundId", { id: String(p.id) });
      const setting = configSettingOf(plug.manifest, p.key as string);
      if (!setting) return invalid(tmsg("msg.plugin.settings.keyUndeclared", { key: String(p.key) }));
      const v = validateSettingValue(setting, p.value);
      if (!v.ok) return invalid(v.error);
      const scope = (p.scope as string | undefined) ?? "global";
      const ps = usePluginSettings.getState();
      if (scope === "workspace") {
        const target = workspaceScope(p.workspace as string | undefined);
        if (!target) return invalid(tmsg("msg.plugin.settings.workspaceRootUnresolved"));
        ps.setWorkspace(target.root, p.id as string, p.key as string, v.value);
        return {
          id: p.id,
          scope,
          key: p.key,
          value: v.value,
          projectId: target.id,
          workspaceRoot: target.root,
        };
      }
      ps.setGlobal(p.id as string, p.key as string, v.value);
      return { id: p.id, scope, key: p.key, value: v.value };
    },
  });

  register("plugin.settings.reset", {
    description: key("cmd.plugin.settings.reset.desc"),
    triggers: { ko: "플러그인 설정 초기화 리셋 기본값" },
    params: {
      id: { type: "string", description: key("cmd.plugin.settings.reset.param.id"), required: true },
      key: { type: "string", description: key("cmd.plugin.settings.reset.param.key") },
      scope: { type: "string", description: key("cmd.plugin.settings.reset.param.scope"), enum: ["global", "workspace"] },
      workspace: { type: "string", description: key("cmd.plugin.settings.reset.param.workspace") },
    },
    returns: "{ id, scope, key, projectId?, workspaceRoot? }",
    message: (d) =>
      d.key
        ? tmsg("msg.plugin.settings.reset.one", { key: String(d.key) })
        : tmsg("msg.plugin.settings.reset.all"),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: ['plugin.settings.reset \'{"id":"soksak-plugin-<id>","key":"defaultAgent"}\''],
    handler: (p) => {
      const plug = usePlugins.getState().plugins[p.id as string];
      if (!plug) return notFound("msg.plugin.notFoundId", { id: String(p.id) });
      const scope = (p.scope as string | undefined) ?? "global";
      const ps = usePluginSettings.getState();
      const key = p.key as string | undefined;
      if (scope === "workspace") {
        const target = workspaceScope(p.workspace as string | undefined);
        if (!target) return invalid(tmsg("msg.plugin.settings.workspaceRootUnresolved"));
        ps.resetWorkspace(target.root, p.id as string, key);
        return {
          id: p.id,
          scope,
          key: key ?? null,
          projectId: target.id,
          workspaceRoot: target.root,
        };
      }
      ps.resetGlobal(p.id as string, key);
      return { id: p.id, scope, key: key ?? null };
    },
  });

  register("plugin.settings.open", {
    description: key("cmd.plugin.settings.open.desc"),
    triggers: { ko: "설정 열기 환경설정 모달 플러그인 설정 패널" },
    params: {
      id: { type: "string", description: key("cmd.plugin.settings.open.param.id") },
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
        return notFound("msg.plugin.notFoundId", { id: section });
      }
      useUi.getState().setSettingsSection(section);
      return { section };
    },
  });

  register("plugin.reload", {
    description: key("cmd.plugin.reload.desc"),
    triggers: { ko: "플러그인 재적재 리로드 새로고침" },
    params: {
      id: {
        type: "string",
        description: key("cmd.plugin.reload.param.id"),
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
        if (!usePlugins.getState().plugins[id]) return notFound("msg.plugin.notFoundId", { id });
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
    description: key("cmd.plugin.view.open.desc"),
    triggers: { ko: "플러그인 뷰 열기 사이드바 칸 탭 보기" },
    params: {
      viewKey: {
        type: "string",
        description: key("cmd.plugin.view.open.param.viewKey"),
        required: true,
      },
      workspace: { type: "string", description: key("cmd.plugin.view.open.param.workspace") },
    },
    returns: "{ viewKey, projectId, paneId, tabId, existing }",
    message: (d) => tmsg("msg.plugin.view.open", { view: String(d.viewKey) }),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: [
      'plugin.view.open \'{"viewKey":"soksak-plugin-<id>.<view>"}\'',
      'plugin.view.open \'{"viewKey":"soksak-plugin-<id>.<view>","placement":"center"}\'',
    ],
    handler: (p) => {
      const s = useSessions.getState();
      const projectId = (p.workspace as string | undefined) ?? s.activeId;
      const workspace = s.workspaces.find((t) => t.id === projectId);
      if (!workspace) return notFound("msg.workspace.notFoundId", { id: projectId });
      const key = p.viewKey as string;
      const reg = getRegisteredView(key);
      if (!reg) {
        return notFound("msg.plugin.view.notRegistered", { key });
      }
      // Opening is for a tab view. A `side` view is drawn through `sections.*` instead — a set is
      // arranged and then stood in a place — and this command refused it with `notOpenable` every
      // time, a parameter whose values were one that worked and several that did not.
      if (!reg.decl.surfaces.includes("tab")) {
        return invalid(tmsg("msg.plugin.view.notATabView", {
          key,
          surfaces: reg.decl.surfaces.join(", "),
        }));
      }
      const r = s.openPluginView(
        projectId,
        reg.pluginId,
        reg.decl.id,
        localize(reg.decl.title),
      );
      if (!r.ok) return r;
      return {
        viewKey: key,
        projectId,
        paneId: r.groupId,
        tabId: r.viewId,
        existing: r.existing,
      };
    },
  });

  register("plugin.view.close", {
    description: key("cmd.plugin.view.close.desc"),
    triggers: { ko: "플러그인 뷰 닫기 사이드바 탭 제거" },
    params: {
      viewKey: {
        type: "string",
        description: key("cmd.plugin.view.close.param.viewKey"),
        required: true,
      },
      workspace: { type: "string", description: key("cmd.plugin.view.close.param.workspace") },
    },
    returns: "{ viewKey, projectId, closed: [placement list], tabIds: [closed content tab ids] }",
    message: (d) => tmsg("msg.plugin.view.close", { view: String(d.viewKey), n: ((d.closed as unknown[]) ?? []).length }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['plugin.view.close \'{"viewKey":"soksak-plugin-<id>.<view>"}\''],
    handler: (p) => {
      const s = useSessions.getState();
      const projectId = (p.workspace as string | undefined) ?? s.activeId;
      const workspace = s.workspaces.find((t) => t.id === projectId);
      if (!workspace) return notFound("msg.workspace.notFoundId", { id: projectId });
      const key = p.viewKey as string;
      const closed: string[] = [];
      const tabIds: string[] = [];
      // A region's sidebar is registry-driven (the layout only places) — an individual close
      // reports membership only. The actual removal is handled by reconcileSidebar when the plugin
      // is disabled or unregistered. Both regions answer the same way: the right held one active
      // view of its own until 2026-08-16 and had to be closed separately.
      for (const region of ["left", "right"] as const) {
        if (hasSidebarViewKey(workspace.sidebarLayouts[region], key)) {
          closed.push(`sidebar-${region}`);
        }
      }
      // content placement: closes every tab of this plugin view across all spaces.
      for (const space of workspace.spaces) {
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


  register("plugin.dev.create", {
    description: key("cmd.plugin.dev.create.desc"),
    triggers: { ko: "플러그인 개발 새로 만들기 스캐폴드 scaffold 생성" },
    params: {
      id: { type: "string", description: key("cmd.plugin.dev.create.param.id"), required: true },
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
    description: key("cmd.plugin.conformance.desc"),
    triggers: { ko: "플러그인 정합성 선언 실제 conformance" },
    params: { id: { type: "string", required: true, description: key("cmd.plugin.conformance.param.id") } },
    returns:
      "{ id, commands/views/fileViewers/iconSets: { declared, registered, missing }, nodes: { declared, wired, missing, orphan }, implements: { declared, violations }, c2: { violations: [{ rule, detail }], viewStatus: { mounted, reported, unreported, undeclared: [{ viewId, view, code }] } }, calls: { literals, dynamic, unresolved } }",
    message: (d) => tmsg("msg.plugin.conformance", { id: String(d.id) }),
    examples: ["plugin.conformance soksak-plugin-<id>"],
    handler: async (p) => {
      const id = p.id as string;
      const plug = usePlugins.getState().plugins[id];
      if (!plug) return notFound("msg.plugin.notFoundId", { id });
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
      const declaredIcons = c.iconSets.map((x) => x.id);
      const regViews = registeredViewIds(id);
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
      for (const t of useSessions.getState().workspaces)
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
