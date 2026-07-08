// plugin.* 명령 — 플러그인 관리(목록/설치/갱신/제거/활성/비활성/재적재/dev).
// 동의(§0-5)는 사람만: 원격 enable 은 기록된 동의 없으면 CONSENT_REQUIRED 로 거부되고,
// 동의 부여 명령 자체가 존재하지 않는다(UI 동의 모달 전용).
// plugin.view.* 배치 명령은 M_P5(우측 사이드바)에서 등록된다.

import { invoke } from "@tauri-apps/api/core";
import { pendingConsentChain, usePlugins, type PluginRuntime } from "../state/plugins";
import { allGroups, useSessions } from "../state/sessions";
import { hasSidebarView as hasSidebarViewKey } from "../state/sidebarLayout";
import { getRegisteredView, registeredViewIds } from "../plugins/viewRegistry";
import { registeredFileViewerIds } from "../plugins/fileViewerRegistry";
import { registeredIconSetIds } from "../ui/icons/registry";
import { listPrograms } from "../plugins/programRegistry";
import { localize, tmsg } from "../i18n";
import {
  VIEW_PLACEMENTS,
  configDefaults,
  configSettingOf,
  resolveText,
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
import { register, catalogJson, setUnknownCommandResolver, type CommandHint } from "./registry";
import { collectExposed } from "./catalogDom";
import { pluginCommandName } from "../plugins/spec";
import { commandsMissingMessage } from "../plugins/api";
import { missingRegistrations, nodeConformance } from "../plugins/conformance";
import { useUi } from "../state/ui";
import { consentSummary } from "../plugins/consentSummary";

// 설치/dev 런타임 → 의존 그래프 노드(매니페스트 dependencies 기준).
function depNodes(): DepNode[] {
  return Object.values(usePlugins.getState().plugins).map((p) => ({
    id: p.manifest.id,
    version: p.manifest.version,
    dependencies: p.manifest.dependencies ?? {},
  }));
}

const notFound = (what: string) => ({
  ok: false as const,
  code: "TARGET_NOT_FOUND" as const,
  message: what,
});
const invalid = (what: string) => ({
  ok: false as const,
  code: "INVALID_PARAMS" as const,
  message: what,
});

// plugin.list 응답 항목(직렬화 가능 — 핸들러/모듈 비포함).
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
    examples: ["sok program.list"],
    handler: () => ({
      // 제어판(main)은 플러그인을 싣지 않는다 — 빈 목록을 "미설치"로 오독하지 않게 스스로 설명한다.
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

  // 플러그인 단축 이름 해소 — 기본형 문법의 단일진실. "activity" ≡ "soksak-plugin-activity".
  // 설치본이 있으면 설치본 id, 없으면 레지스트리 항목으로 해소한다. 못 찾으면 null.
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

  // UNKNOWN_COMMAND 지능형 안내 — 미지의 명령이 레지스트리 카탈로그의 선언 명령과 일치하면
  // 원인(미설치/비활성)에 맞는 설치·활성 명령을 hint 로 제시한다. 발견→설치→활성 사이클이
  // 오류 응답에서도 이어진다(사용자 확정 2026-07-07).
  setUnknownCommandResolver((name): CommandHint[] => {
    const entries = useRegistry.getState().entries;
    const installed = usePlugins.getState().plugins;
    // 제어판(main)은 플러그인을 로드하지 않는다 — 여기서 플러그인 명령이 미지인 것은 설치
    // 문제가 아니라 창 문제다. 설치 안내는 오진(실측: 외부 에이전트가 재시도 반복).
    const controlPlane = currentWindowLabel() === "main";
    const controlPlaneHint = (): CommandHint[] => [
      { cmd: "sok window.projects", why: tmsg("hint.error.pluginControlPlane") },
    ];
    // 형태 ①: plugin.<플러그인 id>.<명령> — id 로 직접 판별.
    const m = /^plugin\.(soksak-plugin-[a-z0-9-]+)\.(.+)$/.exec(name);
    if (m) {
      const [, pid, sub] = m;
      const entry = entries.find((e) => e.id === pid);
      const runtime = installed[pid];
      if (runtime && runtime.status !== "enabled") {
        return [{ cmd: `sok plugin.enable ${shortName(pid)}`, why: tmsg("hint.error.pluginDisabled", { plugin: pid }) }];
      }
      if (entry && controlPlane) return controlPlaneHint();
      if (!runtime && entry) {
        return [{ cmd: `sok plugin.install ${shortName(pid)}`, why: tmsg("hint.error.pluginNotInstalled", { plugin: pid, command: sub }) }];
      }
      return [];
    }
    // 형태 ②: 접두 없는 이름 — 카탈로그의 선언 명령에서 같은 이름을 찾는다(최대 3건).
    const hits: CommandHint[] = [];
    for (const e of entries) {
      if (!e.commands?.some((c) => c.name === name)) continue;
      if (controlPlane) return controlPlaneHint();
      const runtime = installed[e.id];
      const full = `plugin.${e.id}.${name}`;
      if (runtime?.status === "enabled") {
        hits.push({ cmd: `sok ${full}`, why: tmsg("hint.error.pluginCommandFullName", { plugin: e.id }) });
      } else if (runtime) {
        hits.push({ cmd: `sok plugin.enable ${shortName(e.id)}`, why: tmsg("hint.error.pluginDisabled", { plugin: e.id }) });
      } else {
        hits.push({ cmd: `sok plugin.install ${shortName(e.id)}`, why: tmsg("hint.error.pluginNotInstalled", { plugin: e.id, command: name }) });
      }
      if (hits.length >= 3) break;
    }
    return hits;
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
    examples: ["sok plugin.list"],
    handler: () => {
      const s = usePlugins.getState();
      return {
        // 제어판(main)은 플러그인을 싣지 않는다 — 빈 목록의 이유를 응답이 스스로 설명한다.
        ...(currentWindowLabel() === "main"
          ? { note: "control-plane window loads no plugins — query a workspace window (w-*) or pass --window" }
          : {}),
        plugins: Object.values(s.plugins).map(serializeRuntime),
        rejected: s.rejected,
      };
    },
  });

  register("plugin.catalog", {
    description:
      "List the official plugin registry (the installable catalog) merged with local install state. Use to discover plugins that are not installed yet — pass the returned repo to plugin.install.",
    triggers: { ko: "플러그인 카탈로그 레지스트리 설치 가능 목록 마켓 검색" },
    params: {
      refresh: {
        type: "boolean",
        description: "Refetch the live registry before listing (default: session cache / build snapshot)",
      },
    },
    returns:
      "{ status(snapshot|live|error), plugins: [{id, name, version, description, repo, branch?, commands?, installed, runtimeStatus?}] }",
    message: (d) =>
      tmsg("msg.plugin.catalog", { n: ((d.plugins as unknown[]) ?? []).length }),
    examples: ["sok plugin.catalog", 'sok plugin.catalog \'{"refresh":true}\''],
    hint: (d) => {
      // 첫 미설치 항목을 설치 예시로 제시(가능성의 제시) — 전부 설치되어 있으면 생략.
      const plugins = (d.plugins as { id: string; installed: boolean }[] | undefined) ?? [];
      const notInstalled = plugins.find((p) => !p.installed);
      if (!notInstalled) return [];
      return [
        {
          cmd: `sok plugin.install ${shortName(notInstalled.id)}`,
          why: tmsg("hint.plugin.installNext"),
        },
      ];
    },
    handler: async (p) => {
      const reg = useRegistry.getState();
      // 기본 = 세션 1회 원격 최신화(이미 했으면 캐시), refresh=true 는 강제 재조회.
      await reg.refresh(p.refresh === true).catch(() => {});
      const st = useRegistry.getState();
      const installed = usePlugins.getState().plugins;
      return {
        status: st.status,
        plugins: st.entries.map((e) => ({
          id: e.id,
          name: e.name,
          version: e.version,
          description: e.description,
          repo: e.repo,
          ...(e.branch ? { branch: e.branch } : {}),
          ...(e.commands ? { commands: e.commands } : {}),
          installed: e.id in installed,
          runtimeStatus: installed[e.id]?.status ?? null,
        })),
      };
    },
  });

  register("command.docs", {
    description:
      "The whole command surface in one call: core command specs, installed plugin command specs (grouped by plugin), and the registry catalog including not-installed plugins (declared commands with titles). The single source for generating a full reference — sok docs renders this.",
    triggers: { ko: "전체 명령 문서 레퍼런스 매뉴얼 한눈에 코어 플러그인 미설치" },
    params: {
      refresh: {
        type: "boolean",
        description: "Refetch the live registry before answering (default: session cache / snapshot)",
      },
      lang: {
        type: "string",
        enum: ["en", "ko"],
        description: "Language for human-facing text (default: en)",
      },
    },
    returns:
      "{ core: [spec], plugins: { [pluginId]: [spec] }, registry: [{id, name, description, repo, installed, commands: [{name,title,danger?}]}] } — registry name/description/commands[].title resolved to plain strings in the requested lang",
    message: (d) =>
      tmsg("msg.command.docs", {
        core: ((d.core as unknown[]) ?? []).length,
        registry: ((d.registry as unknown[]) ?? []).length,
      }),
    examples: ["sok command.docs", "sok docs", 'sok command.docs \'{"lang":"ko"}\''],
    handler: async (p) => {
      const reg = useRegistry.getState();
      await reg.refresh(p.refresh === true).catch(() => {});
      const st = useRegistry.getState();
      const installed = usePlugins.getState().plugins;
      // core/plugins 절은 이미 영어 평문이라 lang 무관 — registry 절만 다국어(LocalizedText) 해소 대상.
      const lang = p.lang === "ko" ? "ko" : "en";
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
        registry: st.entries.map((e) => ({
          id: e.id,
          name: resolveText(e.name, lang),
          description: resolveText(e.description, lang),
          repo: e.repo,
          ...(e.branch ? { branch: e.branch } : {}),
          ...(e.commands
            ? {
                commands: e.commands.map((c) => ({
                  name: c.name,
                  ...(c.title ? { title: resolveText(c.title, lang) } : {}),
                  ...(c.danger ? { danger: c.danger } : {}),
                })),
              }
            : {}),
          installed: e.id in installed,
        })),
      };
    },
  });

  register("plugin.install", {
    description:
      'Install a plugin into ~/.soksak/plugins/<id>. Basic form: the registry short name (sok plugin.install activity). Fine-grained: a "user/repo" shorthand, a full git URL, or a local path in {"source":...}. Use when adding a new plugin for the first time.',
    triggers: { ko: "플러그인 설치 추가 install" },
    params: {
      source: {
        type: "string",
        description: 'Registry short name (e.g. "activity"), GitHub "user/repo" shorthand, git URL, or local directory path',
        required: true,
      },
      ref: { type: "string", description: "Branch, tag, or commit to pin" },
    },
    returns: "{ id, dir }",
    message: (d) => tmsg("msg.plugin.install", { id: String(d.id) }),
    errors: ["INVALID_PARAMS", "TARGET_NOT_FOUND", "INTERNAL"],
    examples: [
      "sok plugin.install activity",
      'sok plugin.install \'{"source":"user/repo","ref":"v1.0.0"}\'',
    ],
    danger: "destructive",
    hint: (d) => {
      // 실패: 이름을 못 찾았으면 카탈로그 탐색을 제시. 성공: 다음 단계(활성화)를 제시(B4).
      if (d.code === "TARGET_NOT_FOUND")
        return [{ cmd: "sok plugin.catalog", why: tmsg("hint.plugin.catalogBrowse") }];
      if (d.code) return [];
      return [
        { cmd: `sok plugin.enable ${shortName(String(d.id))}`, why: tmsg("hint.plugin.enableNext") },
      ];
    },
    handler: (p) => {
      const raw = String(p.source);
      // 기본형: 단축 이름(경로·URL·user/repo 가 아닌 순수 이름) → 레지스트리에서 repo 로 해소.
      if (/^[a-z0-9][a-z0-9-]*$/.test(raw)) {
        const id = resolveShortId(raw);
        const entry = id ? useRegistry.getState().entries.find((e) => e.id === id) : undefined;
        if (!entry) {
          return {
            ok: false,
            code: "TARGET_NOT_FOUND",
            message: tmsg("msg.plugin.install.unknownName", { name: raw }),
          };
        }
        return usePlugins
          .getState()
          .install(entry.repo, (p.ref as string | undefined) ?? entry.branch);
      }
      return usePlugins.getState().install(raw, p.ref as string | undefined);
    },
  });

  register("plugin.update", {
    description:
      "Update an installed plugin via git pull --ff-only. Re-consent is required after update because permissions may have changed.",
    triggers: { ko: "플러그인 업데이트 갱신 최신화" },
    params: {
      id: { type: "string", description: "Plugin id", required: true },
    },
    returns: "{ id, version }",
    message: (d) => tmsg("msg.plugin.update", { id: String(d.id), version: String(d.version) }),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS", "INTERNAL"],
    examples: ['sok plugin.update \'{"id":"soksak-plugin-memo"}\''],
    danger: "destructive",
    handler: (p) => usePlugins.getState().update(resolveShortId(String(p.id)) ?? String(p.id)),
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
      'sok plugin.remove \'{"id":"soksak-plugin-memo"}\'',
      'sok plugin.remove \'{"id":"soksak-plugin-acp-core","cascade":true}\'',
    ],
    danger: "destructive",
    handler: (p) =>
      usePlugins.getState().remove(resolveShortId(String(p.id)) ?? String(p.id), { cascade: p.cascade as boolean | undefined }),
  });

  register("plugin.deps", {
    description:
      "Inspect the plugin dependency graph. With an id, returns that plugin's dependencies, dependents, reference count, and cascade impact. Without an id, returns all version integrity issues across installed plugins.",
    triggers: { ko: "플러그인 의존성 의존 그래프 종속" },
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
      "sok plugin.deps",
      'sok plugin.deps \'{"id":"soksak-plugin-acp-core"}\'',
    ],
    handler: (p) => {
      const nodes = depNodes();
      if (p.id) {
        const summary = depSummary(resolveShortId(String(p.id)) ?? String(p.id), nodes);
        if (!summary) return notFound(`플러그인 없음: ${p.id}`);
        return { ok: true as const, summary };
      }
      return { ok: true as const, issues: versionIssues(nodes) };
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
    examples: ["sok plugin.enable memo", 'sok plugin.enable \'{"id":"soksak-plugin-memo"}\''],
    danger: "inject",
    hint: (d) => {
      // CONSENT_REQUIRED 는 message 에 미동의 id 목록이 실린다("활성화 동의 필요: id1, id2 …") —
      // 첫 id(종속 먼저 순서)를 뽑을 수 있으면 정밀 안내, 형식이 어긋나면 표준 안내로 폴백(무리한 파싱 금지).
      if (d.code !== "CONSENT_REQUIRED") return [];
      const prefix = "활성화 동의 필요: ";
      const msg = String(d.message ?? "");
      if (!msg.startsWith(prefix)) return [];
      const first = msg.slice(prefix.length).split(" — ")[0]?.split(",")[0]?.trim();
      if (!first) return [];
      return [
        {
          cmd: `sok plugin.consent.preview '{"id":"${first}"}'`,
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
    examples: ['sok plugin.disable \'{"id":"soksak-plugin-memo"}\''],
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
    examples: ['sok plugin.consent.summary \'{"id":"soksak-plugin-acp-orchestra"}\''],
    handler: (p) => {
      const s = usePlugins.getState();
      const plug = s.plugins[resolveShortId(String(p.id)) ?? String(p.id)];
      if (!plug) return notFound(`플러그인 없음: ${p.id}`);
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
    examples: ['sok plugin.consent.revoke \'{"id":"soksak-plugin-acp-core"}\''],
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
    examples: ['sok plugin.consent.grant \'{"id":"soksak-plugin-acp-core"}\''],
    danger: "destructive",
    handler: (p) => {
      const s = usePlugins.getState();
      const pid = resolveShortId(String(p.id)) ?? String(p.id);
      if (!s.plugins[pid]) return notFound(`플러그인 없음: ${pid}`);
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
    examples: ['sok plugin.consent.chain \'{"id":"soksak-plugin-acp-studio"}\''],
    handler: (p) => {
      const s = usePlugins.getState();
      const pid = resolveShortId(String(p.id)) ?? String(p.id);
      if (!s.plugins[pid]) return notFound(`플러그인 없음: ${pid}`);
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
      'sok plugin.consent.preview \'{"id":"soksak-plugin-acp-orchestra"}\'',
      'sok plugin.consent.preview \'{"id":""}\'  # 닫기',
    ],
    handler: (p) => {
      const id = (p.id as string | undefined) ?? "";
      if (!id) {
        useUi.getState().setConsentPreview(null);
        return { id: "", shown: false };
      }
      if (!usePlugins.getState().plugins[id]) return notFound(`플러그인 없음: ${id}`);
      useUi.getState().setConsentPreview(id);
      return { id, shown: true };
    },
  });

  // 프로젝트 id → root(영속 정체성). 생략 시 활성 프로젝트.
  const projectRoot = (projectId?: string): string | undefined => {
    const s = useSessions.getState();
    const id = projectId ?? s.activeId;
    return s.tabs.find((t) => t.id === id)?.root ?? undefined;
  };

  register("plugin.settings.schema", {
    description:
      "Return the plugin's settings schema from its manifest configuration block. This is the single source of truth from which both UI and CLI derive setting fields and validation rules.",
    triggers: { ko: "플러그인 설정 스키마 구성 항목" },
    params: { id: { type: "string", description: "Plugin id", required: true } },
    returns: "{ id, configuration: ConfigSetting[] }",
    message: (d) => tmsg("msg.plugin.settings.schema", { n: ((d.configuration as unknown[]) ?? []).length }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok plugin.settings.schema \'{"id":"soksak-plugin-acp-orchestra"}\''],
    handler: (p) => {
      const plug = usePlugins.getState().plugins[p.id as string];
      if (!plug) return notFound(`플러그인 없음: ${p.id}`);
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
    returns: "{ id, scope, values } or { id, scope, key, value }",
    message: (d) =>
      d.key !== undefined
        ? tmsg("msg.plugin.settings.get.one", { key: String(d.key), value: String(d.value) })
        : tmsg("msg.plugin.settings.get.all", { n: Object.keys((d.values as Record<string, unknown>) ?? {}).length }),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: [
      'sok plugin.settings.get \'{"id":"soksak-plugin-acp-orchestra"}\'',
      'sok plugin.settings.get \'{"id":"soksak-plugin-acp-orchestra","key":"defaultAgent","scope":"global"}\'',
    ],
    handler: (p) => {
      const plug = usePlugins.getState().plugins[p.id as string];
      if (!plug) return notFound(`플러그인 없음: ${p.id}`);
      const scope = (p.scope as string | undefined) ?? "effective";
      const root = projectRoot(p.project as string | undefined);
      const ps = usePluginSettings.getState();
      const defs = configDefaults(plug.manifest);
      const one = (key: string) => {
        if (scope === "global") return ps.getGlobal(p.id as string, key);
        if (scope === "project") return root ? ps.getProject(root, p.id as string, key) : undefined;
        return ps.effective(p.id as string, key, defs[key], root);
      };
      const key = p.key as string | undefined;
      if (key !== undefined) {
        if (!(key in defs)) return invalid(`설정 키 없음: ${key}`);
        return { id: p.id, scope, key, value: one(key) ?? null };
      }
      const values: Record<string, unknown> = {};
      for (const k of Object.keys(defs)) values[k] = one(k) ?? null;
      return { id: p.id, scope, values };
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
    returns: "{ id, scope, key, value, project? }",
    message: (d) => tmsg("msg.plugin.settings.set", { key: String(d.key), value: String(d.value) }),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: [
      'sok plugin.settings.set \'{"id":"soksak-plugin-acp-orchestra","key":"defaultAgent","value":"codex"}\'',
      'sok plugin.settings.set \'{"id":"soksak-plugin-acp-orchestra","key":"defaultAgent","value":"gemini","scope":"project"}\'',
    ],
    handler: (p) => {
      const plug = usePlugins.getState().plugins[p.id as string];
      if (!plug) return notFound(`플러그인 없음: ${p.id}`);
      const setting = configSettingOf(plug.manifest, p.key as string);
      if (!setting) return invalid(`설정 키 없음(스키마 미선언): ${p.key}`);
      const v = validateSettingValue(setting, p.value);
      if (!v.ok) return invalid(v.error);
      const scope = (p.scope as string | undefined) ?? "global";
      const ps = usePluginSettings.getState();
      if (scope === "project") {
        const root = projectRoot(p.project as string | undefined);
        if (!root) return invalid("프로젝트 root 해소 실패(프로젝트 없음)");
        ps.setProject(root, p.id as string, p.key as string, v.value);
        return { id: p.id, scope, key: p.key, value: v.value, project: root };
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
    returns: "{ id, scope, key, project? }",
    message: (d) =>
      d.key
        ? tmsg("msg.plugin.settings.reset.one", { key: String(d.key) })
        : tmsg("msg.plugin.settings.reset.all"),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: ['sok plugin.settings.reset \'{"id":"soksak-plugin-acp-orchestra","key":"defaultAgent"}\''],
    handler: (p) => {
      const plug = usePlugins.getState().plugins[p.id as string];
      if (!plug) return notFound(`플러그인 없음: ${p.id}`);
      const scope = (p.scope as string | undefined) ?? "global";
      const ps = usePluginSettings.getState();
      const key = p.key as string | undefined;
      if (scope === "project") {
        const root = projectRoot(p.project as string | undefined);
        if (!root) return invalid("프로젝트 root 해소 실패(프로젝트 없음)");
        ps.resetProject(root, p.id as string, key);
        return { id: p.id, scope, key: key ?? null, project: root };
      }
      ps.resetGlobal(p.id as string, key);
      return { id: p.id, scope, key: key ?? null };
    },
  });

  register("plugin.settings.open", {
    description:
      "Open the unified settings modal. With a plugin id, navigates directly to that plugin's settings panel. Omit id for the general preferences section. Pass an empty string to close the modal. Idempotent.",
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
      "sok plugin.settings.open",
      'sok plugin.settings.open \'{"id":"soksak-plugin-acp-orchestra"}\'',
    ],
    handler: (p) => {
      const raw = p.id as string | undefined;
      if (raw === "") {
        useUi.getState().setSettingsSection(null);
        return { section: null };
      }
      const section = raw ?? "general";
      if (section !== "general" && !usePlugins.getState().plugins[section]) {
        return notFound(`플러그인 없음: ${section}`);
      }
      useUi.getState().setSettingsSection(section);
      return { section };
    },
  });

  register("plugin.reload", {
    description:
      "Rescan the plugins directory and reactivate every plugin whose consent is still valid; the response reports which manifests were rejected during the rescan and why. With id, reload only that one plugin instead (disable then re-enable it — same consent gate as plugin.enable) without rescanning the directory or touching any other plugin. Use after manually editing plugin files or adding new plugin folders.",
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
    examples: ["sok plugin.reload", 'sok plugin.reload \'{"id":"soksak-plugin-memo"}\''],
    handler: async (p) => {
      if (p.id) {
        const id = resolveShortId(String(p.id)) ?? String(p.id);
        if (!usePlugins.getState().plugins[id]) return notFound(`플러그인 없음: ${id}`);
        await usePlugins.getState().disable(id);
        return usePlugins.getState().enable(id);
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
    triggers: { ko: "플러그인 뷰 열기 사이드바 패널 탭 보기" },
    params: {
      view: {
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
      "{ view, placement, projectId } (sidebar placements) | { view, placement, projectId, viewId, panelId, existing } (content placement)",
    message: (d) => tmsg("msg.plugin.view.open", { view: String(d.view), placement: String(d.placement) }),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: [
      'sok plugin.view.open \'{"view":"soksak-plugin-memo.panel"}\'',
      'sok plugin.view.open \'{"view":"soksak-plugin-git-diff.view","placement":"content"}\'',
    ],
    handler: (p) => {
      const s = useSessions.getState();
      const projectId = (p.project as string | undefined) ?? s.activeId;
      const project = s.tabs.find((t) => t.id === projectId);
      if (!project) return notFound(`프로젝트 없음: ${projectId}`);
      const key = p.view as string;
      const reg = getRegisteredView(key);
      if (!reg) {
        return notFound(`등록된 뷰 없음(플러그인 활성화 필요): ${key}`);
      }
      const placement =
        (p.placement as ViewPlacement | undefined) ?? reg.decl.defaultPlacement;
      if (!reg.decl.placements.includes(placement)) {
        return invalid(
          `뷰 "${key}" 는 ${placement} 배치를 지원하지 않음(지원: ${reg.decl.placements.join(", ")})`,
        );
      }
      if (placement === "sidebar-right") {
        s.toggleRightSidebar(projectId, true);
        s.setRightView(projectId, key);
        return { view: key, placement, projectId };
      }
      if (placement === "sidebar-left") {
        if (!project.sidebarOpen) s.toggleSidebar(projectId);
        s.setLeftTab(projectId, key);
        return { view: key, placement, projectId };
      }
      // content: 에디터 그룹 탭으로 — 드래그/분할/닫기는 일반 뷰와 동일.
      const r = s.openPluginView(
        projectId,
        reg.pluginId,
        reg.decl.id,
        localize(reg.decl.title),
      );
      if (!r.ok) return r;
      return {
        view: key,
        placement,
        projectId,
        viewId: r.viewId,
        panelId: r.groupId,
        existing: r.existing,
      };
    },
  });

  register("plugin.view.close", {
    description:
      "Close a plugin view. Sidebar placements are deselected and revert to the file tree. Content placements close the tab in every editor group where the view is open.",
    triggers: { ko: "플러그인 뷰 닫기 사이드바 탭 제거" },
    params: {
      view: {
        type: "string",
        description: 'Global view key in the form "<pluginId>.<viewId>"',
        required: true,
      },
      project: { type: "string", description: "Project id. Defaults to the active project." },
    },
    returns: "{ view, closed: [placement list] }",
    message: (d) => tmsg("msg.plugin.view.close", { view: String(d.view), n: ((d.closed as unknown[]) ?? []).length }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok plugin.view.close \'{"view":"soksak-plugin-memo.panel"}\''],
    handler: (p) => {
      const s = useSessions.getState();
      const projectId = (p.project as string | undefined) ?? s.activeId;
      const project = s.tabs.find((t) => t.id === projectId);
      if (!project) return notFound(`프로젝트 없음: ${projectId}`);
      const key = p.view as string;
      const closed: string[] = [];
      if (project.rightView === key) {
        s.setRightView(projectId, null);
        closed.push("sidebar-right");
      }
      // 좌측 사이드바는 registry 주도(레이아웃은 배치만) — 개별 close 는 멤버십만 보고한다.
      // 실제 제거는 플러그인 비활성/해제 시 reconcileSidebar 가 처리.
      if (hasSidebarViewKey(project.leftLayout, key)) {
        closed.push("sidebar-left");
      }
      // content 배치: 전 컨텐츠에서 이 플러그인 뷰 탭을 전부 닫는다.
      for (const content of project.contents) {
        for (const g of allGroups(content.layout)) {
          for (const v of g.views) {
            if (
              v.kind === "plugin" &&
              `${v.pluginId}.${v.view}` === key
            ) {
              const r = s.closeView(projectId, v.id);
              if (r.ok) closed.push("content");
            }
          }
        }
      }
      return { view: key, closed };
    },
  });


  register("plugin.dev.load", {
    description:
      "Development mode: load a plugin from any directory without installing it. Dev-sourced plugins bypass the consent gate (spec §0-5 exception). The inject danger policy governs this command itself.",
    triggers: { ko: "플러그인 개발 로드 dev 임시 적재" },
    params: {
      path: { type: "string", description: "Absolute path to the plugin directory", required: true },
    },
    returns: "{ id, dir }",
    message: (d) => tmsg("msg.plugin.dev.load", { id: String(d.id) }),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: ['sok plugin.dev.load \'{"path":"/path/to/my-plugin"}\''],
    danger: "inject",
    // release 게이트는 devLoad 자체가 수행(A17) — 여기선 위임만.
    handler: (p) => usePlugins.getState().devLoad(p.path as string),
  });

  register("plugin.dev.create", {
    description:
      "Scaffold a new dev plugin in place at ~/.soksak/plugins/<id>/. Creates the minimum plugin.json, main.js, and .soksak.json (version=dev), then runs git init. No external path or dev.load needed — the folder is the working artifact. Reloads plugins automatically after scaffolding.",
    triggers: { ko: "플러그인 개발 새로 만들기 스캐폴드 scaffold 생성" },
    params: {
      id: { type: "string", description: "Plugin id (must match ^[a-z0-9][a-z0-9-]*$)", required: true },
    },
    returns: "{ ok, dir, pluginId }",
    message: (d) => tmsg("msg.plugin.dev.create", { id: String(d.pluginId) }),
    errors: ["INVALID_PARAMS"],
    examples: ['sok plugin.dev.create \'{"id":"soksak-plugin-myapp"}\''],
    danger: "inject",
    handler: async (p) => {
      // release 는 설치본만(A17) — dev 스캐폴드 봉쇄.
      if (usePlugins.getState().release) {
        return { ok: false, code: "INVALID_PARAMS", message: "release 에서는 dev 로더를 제공하지 않습니다(A17)" };
      }
      const r = await invoke<{ dir: string; dir_name: string }>("plugin_dev_new", {
        id: p.id as string,
      });
      await usePlugins.getState().reload();
      return { ok: true, dir: r.dir, pluginId: r.dir_name };
    },
  });

  // declared≡actual 의 in-app 런타임 surface(M5). 발행-시점 스키마 게이트는 soksak-validate(헤드리스,
  // @soksak-ai/plugin-spec) — 별개. 여기는 "선언한 커맨드/노드가 실제 등록·노출됐나"를 e2e 소켓에서 조회한다.
  register("plugin.conformance", {
    description:
      "Report a plugin's declared-vs-actual conformance: manifest declarations vs what is actually registered/exposed at runtime, across every register-gated contribution (commands/views/fileViewers/iconSets) plus DOM nodes. Read-only diagnosis. The publish-time schema gate is soksak-validate (headless, @soksak-ai/plugin-spec); this is the in-app runtime surface.",
    triggers: { ko: "플러그인 정합성 선언 실제 conformance" },
    params: { id: { type: "string", required: true, description: "플러그인 id" } },
    returns: "{ id, commands/views/fileViewers/iconSets: { declared, registered, missing }, nodes: { declared, wired, missing, orphan } }",
    message: (d) => tmsg("msg.plugin.conformance", { id: String(d.id) }),
    examples: ["sok plugin.conformance soksak-plugin-terminal"],
    handler: (p) => {
      const id = p.id as string;
      const plug = usePlugins.getState().plugins[id];
      if (!plug) return notFound(`플러그인 없음: ${id}`);
      const c = plug.manifest.contributes;
      // commands: 선언(contributes.commands) vs 실제 등록(catalogJson 의 plugin.<id>. prefix).
      const declaredCmds = c.commands.map((x) => x.name);
      const prefix = pluginCommandName(id, "");
      const registeredCmds = catalogJson()
        .map((e) => e.name)
        .filter((n) => n.startsWith(prefix))
        .map((n) => n.slice(prefix.length));
      // nodes: 선언(contributes.nodes) vs 실제 배선(collectExposed 의 이 플러그인 뷰 노드).
      //   주소 = win/<win>/<region>/view/<id>.<viewId>/node/<path> → "/view/<id>." 로 이 플러그인 노드만.
      const declaredNodes = c.nodes.map((x) => x.id);
      const wired = collectExposed()
        .filter((n) => n.address.includes(`/view/${id}.`))
        .map((n) => n.nodePath);
      // views/fileViewers/iconSets: 선언(contributes) vs 실제 registry 등록(register-gated).
      //   actual = 각 registry 의 이 플러그인 등록분(호출 기록 아님). gateContribution 이 undeclared 를
      //   막으므로 actual ⊆ declared — missing(선언했으나 미등록)만 가능, orphan 없음.
      const declaredViews = c.views.map((x) => x.id);
      const declaredFv = c.fileViewers.map((x) => x.id);
      const declaredIcons = c.iconSets.map((x) => x.id);
      const regViews = registeredViewIds(id);
      const regFv = registeredFileViewerIds(id);
      const regIcons = registeredIconSetIds(id);
      return {
        id,
        commands: {
          declared: declaredCmds,
          registered: registeredCmds,
          missing: missingRegistrations(declaredCmds, registeredCmds),
          // message 표준(§3): 자기 답을 제공하지 않고 라벨로 열화한 명령(발행 전 채워야 함).
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
      };
    },
  });
}
