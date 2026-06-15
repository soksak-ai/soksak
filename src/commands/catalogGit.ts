// git.* 명령 — 읽기 전용 git 조회(Rust git.rs 위임). path 생략 시 활성 프로젝트 루트.
// registerCatalog() 말미에서 등록(카탈로그 분권 — catalog.ts 비대화 방지).

import { invoke } from "@tauri-apps/api/core";
import { useSessions } from "../state/sessions";
import { register } from "./registry";

const notFound = (what: string) => ({
  ok: false as const,
  code: "TARGET_NOT_FOUND" as const,
  message: what,
});

// path 파라미터 해석: 명시 > 활성 프로젝트 루트. 루트 없는 프로젝트면 에러.
function resolveRepoPath(p: Record<string, unknown>): string | null {
  if (typeof p.path === "string" && p.path.trim()) return p.path;
  const s = useSessions.getState();
  return s.tabs.find((t) => t.id === s.activeId)?.root ?? null;
}

const PATH_PARAM = {
  type: "string",
  description: "저장소 경로(생략 시 활성 프로젝트 루트)",
} as const;

export function registerGitCatalog(): void {
  register("git.init", {
    description:
      "디렉토리에 .git 이 없으면 git init(있으면 no-op, 멱등). 루트 초기화 정책 플러그인(soksak-plugin-git-init)이 project.created 이벤트와 조합해 사용",
    params: { path: PATH_PARAM },
    returns: "{ initialized(수행 여부), path }",
    errors: ["TARGET_NOT_FOUND", "INTERNAL"],
    examples: ['sok git.init \'{"path":"/Users/me/work"}\''],
    handler: async (p) => {
      const path = resolveRepoPath(p);
      if (!path) return notFound("프로젝트 루트 없음 — path 를 지정하세요");
      const initialized = await invoke<boolean>("git_init_if_missing", { path });
      return { initialized, path };
    },
  });

  register("git.log", {
    description: "커밋 이력(최신순). limit 기본 50/최대 500, skip 으로 페이지네이션",
    params: {
      path: PATH_PARAM,
      limit: { type: "number", description: "최대 건수(기본 50, 상한 500)" },
      skip: { type: "number", description: "건너뛸 건수(페이지네이션)" },
    },
    returns: "{ commits: [{hash, short, author, date, subject}] }",
    errors: ["TARGET_NOT_FOUND", "INTERNAL"],
    examples: ["sok git.log", 'sok git.log \'{"limit":10,"skip":10}\''],
    handler: async (p) => {
      const path = resolveRepoPath(p);
      if (!path) return notFound("프로젝트 루트 없음 — path 를 명시하세요");
      const commits = await invoke("git_log", {
        path,
        limit: p.limit,
        skip: p.skip,
      });
      return { commits };
    },
  });

  register("git.show", {
    description: "커밋 1개 상세 — 메타 + 변경 파일 목록 + 패치 전문",
    params: {
      commit: {
        type: "string",
        description: "커밋 해시(4~40 hex) 또는 HEAD/HEAD~N/HEAD^",
        required: true,
      },
      path: PATH_PARAM,
    },
    returns: "{ meta, files: [{status, path}], patch }",
    errors: ["TARGET_NOT_FOUND", "INTERNAL"],
    examples: ['sok git.show \'{"commit":"HEAD"}\''],
    handler: async (p) => {
      const path = resolveRepoPath(p);
      if (!path) return notFound("프로젝트 루트 없음 — path 를 명시하세요");
      const detail = await invoke<object>("git_show", {
        path,
        commit: p.commit,
      });
      return { ...detail };
    },
  });

  register("git.diff", {
    description:
      "unified diff 원문 — 기본 작업트리, staged=true 면 index, commit 지정 시 그 커밋의 패치",
    params: {
      path: PATH_PARAM,
      file: { type: "string", description: "특정 파일로 한정(저장소 상대경로)" },
      commit: { type: "string", description: "커밋 해시/HEAD 참조" },
      staged: { type: "boolean", description: "index(staged) diff", default: false },
    },
    returns: "{ diff: string }",
    errors: ["TARGET_NOT_FOUND", "INTERNAL"],
    examples: ["sok git.diff", 'sok git.diff \'{"file":"src/main.ts","staged":true}\''],
    handler: async (p) => {
      const path = resolveRepoPath(p);
      if (!path) return notFound("프로젝트 루트 없음 — path 를 명시하세요");
      const diff = await invoke<string>("git_diff", {
        path,
        file: p.file,
        commit: p.commit,
        staged: p.staged,
      });
      return { diff };
    },
  });
}
