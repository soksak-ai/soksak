// plugin.* 명령 — 플러그인 관리(목록/설치/갱신/제거/활성/비활성/재적재/dev).
// 동의(§0-5)는 사람만: 원격 enable 은 기록된 동의 없으면 CONSENT_REQUIRED 로 거부되고,
// 동의 부여 명령 자체가 존재하지 않는다(UI 동의 모달 전용).
// plugin.view.* 배치 명령은 M_P5(우측 사이드바)에서 등록된다.

import { usePlugins, type PluginRuntime } from "../state/plugins";
import { allGroups, useSessions, type View } from "../state/sessions";
import { getRegisteredView } from "../plugins/viewRegistry";
import { listPrograms } from "../plugins/programRegistry";
import { localize } from "../i18n";
import { formatterFor } from "../plugins/editorRegistry";
import { VIEW_PLACEMENTS, type ViewPlacement } from "../plugins/spec";
import {
  depSummary,
  versionIssues,
  type DepNode,
} from "../plugins/dependencyGraph";
import { getFileView } from "./fileViewBridge";
import { register } from "./registry";

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

// 파일 뷰 해석: id 명시 → 전 프로젝트 검색, 생략 → 활성 체인의 파일 뷰.
function resolveFileView(
  viewId?: string,
): { projectId: string; view: Extract<View, { kind: "file" }> } | null {
  const s = useSessions.getState();
  if (viewId) {
    for (const t of s.tabs) {
      for (const c of t.contents) {
        for (const g of allGroups(c.layout)) {
          const v = g.views.find((x) => x.id === viewId);
          if (v) return v.kind === "file" ? { projectId: t.id, view: v } : null;
        }
      }
    }
    return null;
  }
  const t = s.tabs.find((x) => x.id === s.activeId);
  const c = t?.contents.find((x) => x.id === t.activeContentId);
  if (!t || !c) return null;
  const g = allGroups(c.layout).find((x) => x.id === c.activeGroupId);
  const v = g?.views.find((x) => x.id === g.activeViewId);
  return v && v.kind === "file" ? { projectId: t.id, view: v } : null;
}

// 파일명 끝의 확장자(소문자) — 포매터/언어 매칭 키.
function extOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

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
      "사용 가능한 프로그램 목록(새 탭 + 메뉴와 동일) — 내장 없음, 전부 플러그인 등록분. path 는 메뉴 카테고리 경로",
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
      "플러그인 전체 상태 — 설치/dev 목록(status 포함) + 검증 거부(rejected) 사유",
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
      'git 소스에서 플러그인 설치(~/.soksak/plugins/<id>) — "user/repo" 단축형, URL, 로컬 경로',
    params: {
      source: {
        type: "string",
        description: 'GitHub "user/repo" | git URL | 로컬 경로',
        required: true,
      },
      ref: { type: "string", description: "브랜치/태그/커밋 핀" },
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
    description: "설치된 플러그인 갱신(git pull --ff-only). 갱신 후 재동의 필요",
    params: {
      id: { type: "string", description: "플러그인 id", required: true },
    },
    returns: "{ id, version }",
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS", "INTERNAL"],
    examples: ['sok plugin.update \'{"id":"soksak-plugin-memo"}\''],
    danger: "destructive",
    handler: (p) => usePlugins.getState().update(p.id as string),
  });

  register("plugin.remove", {
    description:
      "플러그인 제거(디렉토리째). 전용 저장소(plugins-data)는 보존. 의존자가 있으면 cascade:true 동의 없이는 CASCADE_REQUIRED 로 차단(고아 방지)",
    params: {
      id: { type: "string", description: "플러그인 id", required: true },
      cascade: {
        type: "boolean",
        description: "true 면 의존자(전이)까지 함께 삭제(동의). 생략 시 의존자 있으면 차단",
      },
    },
    returns: "{ id, removed: [삭제된 id …] }",
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
      "플러그인 의존 그래프 — id 지정 시 그 플러그인의 의존/의존자/참조수/cascade, 생략 시 전체 버전 무결성 이슈",
    params: {
      id: { type: "string", description: "플러그인 id(생략 시 전체 버전 이슈)" },
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
      "플러그인 활성화(코드 실행 개시). 기록된 사용자 동의가 없으면 CONSENT_REQUIRED — 동의는 UI 에서만",
    params: {
      id: { type: "string", description: "플러그인 id", required: true },
    },
    returns: "{ id, status }",
    errors: ["TARGET_NOT_FOUND", "CONSENT_REQUIRED", "INTERNAL"],
    examples: ['sok plugin.enable \'{"id":"soksak-plugin-memo"}\''],
    danger: "inject",
    handler: (p) => usePlugins.getState().enable(p.id as string),
  });

  register("plugin.disable", {
    description: "플러그인 비활성화 — 등록한 명령/뷰/확장 전부 회수(§0-4)",
    params: {
      id: { type: "string", description: "플러그인 id", required: true },
    },
    returns: "{ id, status }",
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok plugin.disable \'{"id":"soksak-plugin-memo"}\''],
    danger: "destructive",
    handler: (p) => usePlugins.getState().disable(p.id as string),
  });

  register("plugin.reload", {
    description:
      "플러그인 전체 재적재 — 디렉토리 재스캔 + 활성(동의 유효) 플러그인 재활성화",
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
      "플러그인 뷰 열기 — placement 생략 시 매니페스트 기본 배치. 뷰 구현과 배치는 직교(스펙 §0-6)",
    params: {
      view: {
        type: "string",
        description: '뷰 전역 키 "<pluginId>.<viewId>"',
        required: true,
      },
      placement: {
        type: "string",
        description: "배치(생략 시 뷰의 defaultPlacement)",
        enum: VIEW_PLACEMENTS,
      },
      project: { type: "string", description: "프로젝트 id(생략 시 활성)" },
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
    description: "플러그인 뷰 닫기 — 사이드바 배치는 선택 해제(파일 트리/관리로 복귀)",
    params: {
      view: {
        type: "string",
        description: '뷰 전역 키 "<pluginId>.<viewId>"',
        required: true,
      },
      project: { type: "string", description: "프로젝트 id(생략 시 활성)" },
    },
    returns: "{ view, closed: [배치 목록] }",
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

  register("editor.format", {
    description:
      "파일 뷰를 등록된 플러그인 포매터로 정리(⇧⌥F). 포매터는 contributes.formatters 선언 + registerFormatter 바인딩",
    params: {
      view: { type: "string", description: "파일 뷰 id(생략 시 활성 체인)" },
    },
    returns: "{ formatted, changed, formatter }",
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS", "INTERNAL"],
    examples: ["sok editor.format", 'sok editor.format \'{"view":"v12"}\''],
    handler: async (p) => {
      const target = resolveFileView(p.view as string | undefined);
      if (!target) return notFound("파일 뷰 없음(활성 뷰가 파일이 아님)");
      const ext = extOf(target.view.path);
      const fmt = formatterFor(ext);
      if (!fmt) return notFound(`포매터 없음: ${ext || "(확장자 없음)"}`);
      const api = getFileView(target.view.id);
      const text = api?.getText?.();
      if (text == null) {
        return invalid("코드 편집 뷰가 아니거나 로딩 전(프리뷰/미디어)");
      }
      const formatter = `${fmt.pluginId}.${fmt.id}`;
      const out = await fmt.format(text, { path: target.view.path, ext });
      if (typeof out !== "string") {
        return {
          ok: false as const,
          code: "INTERNAL" as const,
          message: `포매터(${formatter})가 문자열을 반환하지 않음`,
        };
      }
      if (out === text) return { formatted: true, changed: false, formatter };
      if (!(api?.setText?.(out) ?? false)) {
        return invalid("쓰기 불가(읽기 전용 또는 코드 모드 아님)");
      }
      return { formatted: true, changed: true, formatter };
    },
  });

  register("plugin.dev.load", {
    description:
      "개발 모드 — 임의 디렉토리의 플러그인을 설치 없이 적재. dev 소스는 동의 게이트 면제(§0-5 예외 — 게이트는 이 명령의 inject 정책)",
    params: {
      path: { type: "string", description: "플러그인 디렉토리 절대경로", required: true },
    },
    returns: "{ id, dir }",
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: ['sok plugin.dev.load \'{"path":"/path/to/my-plugin"}\''],
    danger: "inject",
    handler: (p) => usePlugins.getState().devLoad(p.path as string),
  });
}
