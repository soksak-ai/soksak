// plugin.* 명령 — 플러그인 관리(목록/설치/갱신/제거/활성/비활성/재적재/dev).
// 동의(§0-5)는 사람만: 원격 enable 은 기록된 동의 없으면 CONSENT_REQUIRED 로 거부되고,
// 동의 부여 명령 자체가 존재하지 않는다(UI 동의 모달 전용).
// plugin.view.* 배치 명령은 M_P5(우측 사이드바)에서 등록된다.

import { usePlugins, type PluginRuntime } from "../state/plugins";
import { register } from "./registry";

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
