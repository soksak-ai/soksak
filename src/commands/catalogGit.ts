// git.* commands — read-only git queries delegated to Rust git.rs. path defaults to active project root.
// Registered at the end of registerCatalog() (catalog split — prevents catalog.ts bloat).

import { invoke } from "@tauri-apps/api/core";
import { tmsg } from "../i18n";
import { useSessions } from "../state/sessions";
import { register } from "./registry";

const notFound = (what: string) => ({
  ok: false as const,
  code: "TARGET_NOT_FOUND" as const,
  message: what,
});

// path resolution: explicit param > active project root. Returns null if no root available.
function resolveRepoPath(p: Record<string, unknown>): string | null {
  if (typeof p.path === "string" && p.path.trim()) return p.path;
  const s = useSessions.getState();
  return s.tabs.find((t) => t.id === s.activeId)?.root ?? null;
}

const PATH_PARAM = {
  type: "string",
  description: "Repository path (defaults to active project root when omitted)",
} as const;

export function registerGitCatalog(): void {
  register("git.init", {
    description:
      "Run git init in a directory if .git is absent (no-op when already initialized, idempotent). Use with project.created event in a git-init policy plugin to auto-initialize repos on project creation.",
    triggers: { ko: "깃 초기화 저장소 생성 init" },
    params: { path: PATH_PARAM },
    returns: "{ initialized: whether init was performed, path }",
    message: (d) => d.initialized ? tmsg("msg.git.init.created", { path: String(d.path) }) : tmsg("msg.git.init.exists"),
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
    description: "Retrieve commit history in reverse-chronological order. Supports pagination via limit (default 50, max 500) and skip.",
    triggers: { ko: "깃 로그 커밋 이력 히스토리" },
    params: {
      path: PATH_PARAM,
      limit: { type: "number", description: "Maximum number of commits to return (default 50, max 500)" },
      skip: { type: "number", description: "Number of commits to skip for pagination" },
    },
    returns: "{ commits: [{hash, short, author, date, subject}] }",
    message: (d) => tmsg("msg.git.log", { n: ((d.commits as unknown[]) ?? []).length }),
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
    description: "Show a single commit in full: metadata, changed file list, and the raw patch. Use to inspect what a specific commit introduced.",
    triggers: { ko: "깃 커밋 상세 패치 변경내용 보기" },
    params: {
      commit: {
        type: "string",
        description: "Commit hash (4–40 hex) or symbolic ref such as HEAD, HEAD~N, or HEAD^",
        required: true,
      },
      path: PATH_PARAM,
    },
    returns: "{ meta, files: [{status, path}], patch }",
    message: (d) => tmsg("msg.git.show", { n: ((d.files as unknown[]) ?? []).length }),
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
      "Return the raw unified diff for the working tree (default), the index when staged=true, or a specific commit's patch when commit is supplied. Use to inspect uncommitted or committed changes.",
    triggers: { ko: "깃 diff 변경 차이 수정내용 스테이지" },
    params: {
      path: PATH_PARAM,
      file: { type: "string", description: "Limit diff to this file (repository-relative path)" },
      commit: { type: "string", description: "Commit hash or HEAD reference" },
      staged: { type: "boolean", description: "Diff the index (staged changes) instead of the working tree", default: false },
    },
    returns: "{ diff: string }",
    message: (d) => String(d.diff ?? "").trim() ? tmsg("msg.git.diff.changes") : tmsg("msg.git.diff.empty"),
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
