// ai.session.* commands — the identification surface for AI session lineage (stage ⑤). This is an AI-agent-specialized terminal, so in the terminal
// Identifies a running claude/codex session and builds the basis for 'continue' after restore. Real-time watch, tab id matching, and resume
// come later — for now only pure identification is exposed (whether commandLine is an agent / the sessionId and cwd of the session file).

import { invoke } from "../framework";
import { tmsg } from "../i18n";
import { register } from "./registry";

export function registerAiSessionCatalog(): void {
  register("ai.session.detect", {
    description:
      "Detect whether a shell command launches a tracked AI agent (claude or codex). Returns the agent kind or null. Used to tag terminal command blocks with agentKind.",
    triggers: { ko: "에이전트탐지 세션탐지 ai탐지" },
    params: { command: { type: "string", description: "The shell command line to classify", required: true } },
    // The owner produces the answer — it is the same from whichever window it runs
    // (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ kind }",
    message: (d) => (d.kind ? tmsg("msg.ai.session.detect.agent", { kind: String(d.kind) }) : tmsg("msg.ai.session.detect.none")),
    errors: ["INVALID_PARAMS"],
    examples: ['ai.session.detect \'{"command":"claude --resume"}\''],
    handler: async (p) => {
      if (typeof p.command !== "string") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "command required" };
      }
      const kind = await invoke<string | null>("ai_session_detect", { commandLine: p.command });
      return { kind };
    },
  });

  register("ai.session.lineage", {
    description:
      "Read the session-transition history for a working directory (and optionally one tab), oldest first. Each row is the stored transition record {viewId (stored key for the tab), fromSession, toSession, kind, time} — the time-ordered from→to chain is the flow, and one fromSession branching to several toSession is a fork. This is what we observe via watch since claude doesn't record /clear·/resume branches itself.",
    triggers: { ko: "세션계보 세션흐름 세션분기 lineage" },
    params: {
      cwd: { type: "string", description: "Working directory (scope) to read lineage for", required: true },
      tabId: { type: "string", description: "Limit to one terminal tab; omit for all in this cwd" },
    },
    // The owner produces the answer — it is the same from whichever window it runs
    // (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ rows }",
    message: (d) => tmsg("msg.ai.session.lineage", { n: ((d.rows as unknown[]) ?? []).length }),
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['ai.session.lineage \'{"cwd":"/Users/me/proj"}\''],
    handler: async (p) => {
      if (typeof p.cwd !== "string" || !p.cwd.trim()) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "cwd required" };
      }
      const rows = await invoke<unknown[]>("ai_session_lineage", {
        cwd: p.cwd,
        viewId: typeof p.tabId === "string" ? p.tabId : null, // the argument name at the Rust boundary
      });
      return { rows };
    },
  });

  register("ai.session.find", {
    description:
      "Find the most recent claude session for a working directory by reading its session folder (~/.claude/projects/<encoded-cwd>/). Returns sessionId and cwd, or null. Used to tag a terminal's command block with the session it launched (on-demand, no live watch). codex uses date folders and is resolved later.",
    triggers: { ko: "세션찾기 세션조회 현세션" },
    params: { cwd: { type: "string", description: "Working directory the agent ran in", required: true } },
    // The owner produces the answer — it is the same from whichever window it runs
    // (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ session }",
    message: (d) => (d.session ? tmsg("msg.ai.session.find.found") : tmsg("msg.ai.session.find.none")),
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['ai.session.find \'{"cwd":"/Users/me/proj"}\''],
    handler: async (p) => {
      if (typeof p.cwd !== "string" || !p.cwd.trim()) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "cwd required" };
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
    // The owner produces the answer — it is the same from whichever window it runs
    // (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ session }",
    message: (d) => (d.session ? tmsg("msg.ai.session.inspect.read") : tmsg("msg.ai.session.inspect.none")),
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['ai.session.inspect \'{"path":"~/.claude/projects/-Users-me-proj/<id>.jsonl"}\''],
    handler: async (p) => {
      if (typeof p.path !== "string" || !p.path.trim()) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.data.pathRequired") };
      }
      const session = await invoke<unknown>("ai_session_inspect", { path: p.path });
      return { session };
    },
  });
}
