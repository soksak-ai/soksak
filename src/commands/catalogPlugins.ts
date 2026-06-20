// plugin.* 명령 — 플러그인 관리(목록/설치/갱신/제거/활성/비활성/재적재/dev).
// 동의(§0-5)는 사람만: 원격 enable 은 기록된 동의 없으면 CONSENT_REQUIRED 로 거부되고,
// 동의 부여 명령 자체가 존재하지 않는다(UI 동의 모달 전용).
// plugin.view.* 배치 명령은 M_P5(우측 사이드바)에서 등록된다.

import { invoke } from "@tauri-apps/api/core";
import { pendingConsentChain, usePlugins, type PluginRuntime } from "../state/plugins";
import { allGroups, useSessions } from "../state/sessions";
import { getRegisteredView } from "../plugins/viewRegistry";
import { listPrograms } from "../plugins/programRegistry";
import { localize } from "../i18n";
import {
  VIEW_PLACEMENTS,
  configDefaults,
  configSettingOf,
  validateSettingValue,
  type ViewPlacement,
} from "../plugins/spec";
import { usePluginSettings } from "../state/pluginSettings";
import {
  depSummary,
  versionIssues,
  type DepNode,
} from "../plugins/dependencyGraph";
import { register } from "./registry";
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
    examples: ["sok program.list"],
    handler: () => ({
      programs: listPrograms().map((p) => ({
        id: p.decl.id,
        title: p.decl.title,
        ...(p.decl.path ? { path: p.decl.path } : {}),
        kind: p.decl.kind,
        ...(p.decl.command ? { command: p.decl.command } : {}),
        ...(p.decl.url ? { url: p.decl.url } : {}),
        ...(p.decl.ensure ? { ensure: p.decl.ensure } : {}),
        pluginId: p.pluginId,
      })),
    }),
  });

  register("plugin.list", {
    description:
      "List all installed and dev plugins with their runtime status, permissions, and rejection reasons. Use to check which plugins exist and whether any failed to load.",
    triggers: { ko: "플러그인 목록 설치된 확장 상태" },
    params: {},
    returns: "{ plugins: [{id, name, version, status, permissions, …}], rejected }",
    examples: ["sok plugin.list"],
    handler: () => {
      const s = usePlugins.getState();
      return {
        plugins: Object.values(s.plugins).map(serializeRuntime),
        rejected: s.rejected,
      };
    },
  });

  register("plugin.install", {
    description:
      'Install a plugin from a git source into ~/.soksak/plugins/<id>. Accepts a "user/repo" shorthand, a full git URL, or a local path. Use when adding a new plugin for the first time.',
    triggers: { ko: "플러그인 설치 추가 install" },
    params: {
      source: {
        type: "string",
        description: 'GitHub "user/repo" shorthand, git URL, or local directory path',
        required: true,
      },
      ref: { type: "string", description: "Branch, tag, or commit to pin" },
    },
    returns: "{ id, dir }",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: [
      'sok plugin.install \'{"source":"user/soksak-plugin-memo"}\'',
      'sok plugin.install \'{"source":"/path/to/repo","ref":"v1.0.0"}\'',
    ],
    danger: "destructive",
    handler: (p) =>
      usePlugins.getState().install(p.source as string, p.ref as string | undefined),
  });

  register("plugin.update", {
    description:
      "Update an installed plugin via git pull --ff-only. Re-consent is required after update because permissions may have changed.",
    triggers: { ko: "플러그인 업데이트 갱신 최신화" },
    params: {
      id: { type: "string", description: "Plugin id", required: true },
    },
    returns: "{ id, version }",
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS", "INTERNAL"],
    examples: ['sok plugin.update \'{"id":"soksak-plugin-memo"}\''],
    danger: "destructive",
    handler: (p) => usePlugins.getState().update(p.id as string),
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
    errors: ["TARGET_NOT_FOUND", "CASCADE_REQUIRED", "INTERNAL"],
    examples: [
      'sok plugin.remove \'{"id":"soksak-plugin-memo"}\'',
      'sok plugin.remove \'{"id":"soksak-plugin-acp-core","cascade":true}\'',
    ],
    danger: "destructive",
    handler: (p) =>
      usePlugins.getState().remove(p.id as string, { cascade: p.cascade as boolean | undefined }),
  });

  register("plugin.deps", {
    description:
      "Inspect the plugin dependency graph. With an id, returns that plugin's dependencies, dependents, reference count, and cascade impact. Without an id, returns all version integrity issues across installed plugins.",
    triggers: { ko: "플러그인 의존성 의존 그래프 종속" },
    params: {
      id: { type: "string", description: "Plugin id. Omit to list all version integrity issues." },
    },
    returns: "{ summary?, issues? }",
    errors: ["TARGET_NOT_FOUND"],
    examples: [
      "sok plugin.deps",
      'sok plugin.deps \'{"id":"soksak-plugin-acp-core"}\'',
    ],
    handler: (p) => {
      const nodes = depNodes();
      if (p.id) {
        const summary = depSummary(p.id as string, nodes);
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
    errors: ["TARGET_NOT_FOUND", "CONSENT_REQUIRED", "INTERNAL"],
    examples: ['sok plugin.enable \'{"id":"soksak-plugin-memo"}\''],
    danger: "inject",
    handler: (p) => usePlugins.getState().enable(p.id as string),
  });

  register("plugin.disable", {
    description:
      "Deactivate a plugin and revoke all of its registered commands, views, and extensions (spec §0-4). Use when you want to stop a plugin without removing it.",
    triggers: { ko: "플러그인 비활성화 끄기 disable" },
    params: {
      id: { type: "string", description: "Plugin id", required: true },
    },
    returns: "{ id, status }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok plugin.disable \'{"id":"soksak-plugin-memo"}\''],
    danger: "destructive",
    handler: (p) => usePlugins.getState().disable(p.id as string),
  });

  register("plugin.consent.summary", {
    description:
      "Fetch the consent display data for a plugin — permissions, contribution counts, and dependency tree (plugins + libraries). Same single source used by the consent modal. Use to inspect what the user will be asked to consent to.",
    triggers: { ko: "플러그인 동의 요약 권한 확인" },
    params: { id: { type: "string", description: "Plugin id", required: true } },
    returns: "{ id, version, permissions, contributes, dependencies:{plugins,libraries} }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok plugin.consent.summary \'{"id":"soksak-plugin-acp-orchestra"}\''],
    handler: (p) => {
      const s = usePlugins.getState();
      const plug = s.plugins[p.id as string];
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
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok plugin.consent.revoke \'{"id":"soksak-plugin-acp-core"}\''],
    danger: "destructive",
    handler: (p) => usePlugins.getState().revokeConsent(p.id as string),
  });

  register("plugin.consent.chain", {
    description:
      "Return the ordered list of plugins still needing consent before the target plugin can be activated (dependencies first). Dev-sourced and already-consented plugins are excluded. An empty pending array means the plugin can be activated immediately.",
    triggers: { ko: "동의 체인 미동의 순서 활성화 전" },
    params: { id: { type: "string", description: "Plugin id", required: true } },
    returns: "{ id, pending }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok plugin.consent.chain \'{"id":"soksak-plugin-acp-studio"}\''],
    handler: (p) => {
      const s = usePlugins.getState();
      if (!s.plugins[p.id as string]) return notFound(`플러그인 없음: ${p.id}`);
      return { id: p.id, pending: pendingConsentChain(p.id as string, s.plugins, s.consents) };
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
      "Rescan the plugins directory and reactivate all plugins whose consent is still valid. Use after manually editing plugin files or adding new plugin folders.",
    triggers: { ko: "플러그인 재적재 리로드 새로고침" },
    params: {},
    returns: "{ count, rejected }",
    examples: ["sok plugin.reload"],
    handler: async () => {
      await usePlugins.getState().reload();
      const s = usePlugins.getState();
      return {
        count: Object.keys(s.plugins).length,
        rejected: s.rejected,
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
    returns: "{ view, placement, projectId }",
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
        groupId: r.groupId,
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
      if (project.leftTab === key) {
        s.setLeftTab(projectId, "files");
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
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: ['sok plugin.dev.load \'{"path":"/path/to/my-plugin"}\''],
    danger: "inject",
    handler: (p) => usePlugins.getState().devLoad(p.path as string),
  });

  register("plugin.dev.new", {
    description:
      "Scaffold a new dev plugin in place at ~/.soksak/plugins/<id>/. Creates the minimum plugin.json, main.js, and .soksak.json (version=dev), then runs git init. No external path or dev.load needed — the folder is the working artifact. Reloads plugins automatically after scaffolding.",
    triggers: { ko: "플러그인 개발 새로 만들기 스캐폴드 scaffold 생성" },
    params: {
      id: { type: "string", description: "Plugin id (must match ^[a-z0-9][a-z0-9-]*$)", required: true },
    },
    returns: "{ ok, dir, pluginId }",
    errors: ["INVALID_PARAMS"],
    examples: ['sok plugin.dev.new \'{"id":"soksak-plugin-myapp"}\''],
    danger: "inject",
    handler: async (p) => {
      const r = await invoke<{ dir: string; dir_name: string }>("plugin_dev_new", {
        id: p.id as string,
      });
      await usePlugins.getState().reload();
      return { ok: true, dir: r.dir, pluginId: r.dir_name };
    },
  });
}
