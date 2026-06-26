// ai.session.* commands — AI 세션 계보(단계⑤) 식별 표면. 우리는 AI agent 특화 터미널이라, 터미널에서
// 돌던 claude/codex 세션을 식별해 복원 후 '이어가기' 의 토대를 만든다. 실시간 watch·viewId 매칭·resume
// 은 후속 — 지금은 순수 식별(commandLine 이 에이전트인가 / 세션 파일의 sessionId·cwd)만 노출한다.

import { invoke } from "@tauri-apps/api/core";
import { register } from "./registry";

export function registerAiSessionCatalog(): void {
  register("ai.session.detect", {
    description:
      "Detect whether a shell command launches a tracked AI agent (claude or codex). Returns the agent kind or null. Used to tag terminal command blocks with agentKind.",
    triggers: { ko: "에이전트탐지 세션탐지 ai탐지" },
    params: { command: { type: "string", description: "The shell command line to classify", required: true } },
    returns: "{ kind }",
    errors: ["INVALID_PARAMS"],
    examples: ['sok ai.session.detect \'{"command":"claude --resume"}\''],
    handler: async (p) => {
      if (typeof p.command !== "string") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "command 필요" };
      }
      const kind = await invoke<string | null>("ai_session_detect", { commandLine: p.command });
      return { kind };
    },
  });

  register("ai.session.lineage", {
    description:
      "Read the session-transition history for a working directory (and optionally one viewId), oldest first. Each row is {viewId, fromSession, toSession, kind, time} — the time-ordered from→to chain is the flow, and one fromSession branching to several toSession is a fork. This is what we observe via watch since claude doesn't record /clear·/resume branches itself.",
    triggers: { ko: "세션계보 세션흐름 세션분기 lineage" },
    params: {
      cwd: { type: "string", description: "Working directory (scope) to read lineage for", required: true },
      viewId: { type: "string", description: "Limit to one terminal view; omit for all in this cwd" },
    },
    returns: "{ rows }",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['sok ai.session.lineage \'{"cwd":"/Users/me/proj"}\''],
    handler: async (p) => {
      if (typeof p.cwd !== "string" || !p.cwd.trim()) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "cwd 필요" };
      }
      const rows = await invoke<unknown[]>("ai_session_lineage", {
        cwd: p.cwd,
        viewId: typeof p.viewId === "string" ? p.viewId : null,
      });
      return { rows };
    },
  });

  register("ai.session.find", {
    description:
      "Find the most recent claude session for a working directory by reading its session folder (~/.claude/projects/<encoded-cwd>/). Returns sessionId and cwd, or null. Used to tag a terminal's command block with the session it launched (on-demand, no live watch). codex uses date folders and is resolved later.",
    triggers: { ko: "세션찾기 세션조회 현세션" },
    params: { cwd: { type: "string", description: "Working directory the agent ran in", required: true } },
    returns: "{ session }",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['sok ai.session.find \'{"cwd":"/Users/me/proj"}\''],
    handler: async (p) => {
      if (typeof p.cwd !== "string" || !p.cwd.trim()) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "cwd 필요" };
      }
      const session = await invoke<unknown>("ai_session_find", { cwd: p.cwd });
      return { session };
    },
  });

  register("ai.session.inspect", {
    description:
      "Read a claude/codex session jsonl file's header and return its sessionId and cwd. Only paths under ~/.claude/projects or ~/.codex/sessions are allowed; arbitrary file reads are rejected. The sessionId is validated against a UUID whitelist.",
    triggers: { ko: "세션점검 세션식별 세션정보" },
    params: { path: { type: "string", description: "Path to the session .jsonl file", required: true } },
    returns: "{ session }",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['sok ai.session.inspect \'{"path":"~/.claude/projects/-Users-me-proj/<id>.jsonl"}\''],
    handler: async (p) => {
      if (typeof p.path !== "string" || !p.path.trim()) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "path 필요" };
      }
      const session = await invoke<unknown>("ai_session_inspect", { path: p.path });
      return { session };
    },
  });
}
