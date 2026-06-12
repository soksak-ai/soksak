// plugin.* 명령 — 플러그인 관리(목록/설치/갱신/제거/활성/비활성/재적재/dev).
// 동의(§0-5)는 사람만: 원격 enable 은 기록된 동의 없으면 CONSENT_REQUIRED 로 거부되고,
// 동의 부여 명령 자체가 존재하지 않는다(UI 동의 모달 전용).
// plugin.view.* 배치 명령은 M_P5(우측 사이드바)에서 등록된다.

import { usePlugins, type PluginRuntime } from "../state/plugins";
import { useSessions } from "../state/sessions";
import { getRegisteredView } from "../plugins/viewRegistry";
import { VIEW_PLACEMENTS, type ViewPlacement } from "../plugins/spec";
import { register } from "./registry";

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
      'sok plugin.install \'{"source":"user/soksak-memo"}\'',
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
    examples: ['sok plugin.update \'{"id":"soksak-memo"}\''],
    danger: "destructive",
    handler: (p) => usePlugins.getState().update(p.id as string),
  });

  register("plugin.remove", {
    description: "플러그인 제거(디렉토리째). 전용 저장소(plugins-data)는 보존",
    params: {
      id: { type: "string", description: "플러그인 id", required: true },
    },
    returns: "{ id }",
    errors: ["TARGET_NOT_FOUND", "INTERNAL"],
    examples: ['sok plugin.remove \'{"id":"soksak-memo"}\''],
    danger: "destructive",
    handler: (p) => usePlugins.getState().remove(p.id as string),
  });

  register("plugin.enable", {
    description:
      "플러그인 활성화(코드 실행 개시). 기록된 사용자 동의가 없으면 CONSENT_REQUIRED — 동의는 UI 에서만",
    params: {
      id: { type: "string", description: "플러그인 id", required: true },
    },
    returns: "{ id, status }",
    errors: ["TARGET_NOT_FOUND", "CONSENT_REQUIRED", "INTERNAL"],
    examples: ['sok plugin.enable \'{"id":"soksak-memo"}\''],
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
    examples: ['sok plugin.disable \'{"id":"soksak-memo"}\''],
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
      'sok plugin.view.open \'{"view":"soksak-memo.panel"}\'',
      'sok plugin.view.open \'{"view":"soksak-git-diff.view","placement":"content"}\'',
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
      // content 배치는 M_P6(View "plugin" variant)에서 연결된다.
      return invalid("content 배치는 아직 연결되지 않음(다음 단계 M_P6)");
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
    examples: ['sok plugin.view.close \'{"view":"soksak-memo.panel"}\''],
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
      return { view: key, closed };
    },
  });

  register("plugin.dev.load", {
    description:
      "개발 모드 — 임의 디렉토리의 플러그인을 설치 없이 적재(활성화는 별도 enable + 동의)",
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
