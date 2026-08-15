// turn.* commands — open "turn ended" signal surface (shared by CLI/MCP/plugins). turn.signal is
// the path for any provider to emit turn.ended through a command (ACP, external tool, E2E
// injection). turn.idleDetection toggles the core idle heuristic provider (OFF by default). The
// core has no reference to a specific consumer such as the mailbox — topic/command contract only.

import { emitPluginEvent } from "../plugins/hooks";
import {
  setIdleTurnDetection,
  isIdleTurnDetectionOn,
  idleTurnMs,
} from "../terminal/idleTurnDetector";
import { register } from "./registry";
import { tmsg } from "../i18n";

export function registerTurnCatalog(): void {
  register("turn.signal", {
    description:
      "Emit a turn.ended event (open signal). Use when any provider — ACP, external tool, or test harness — needs to signal that a turn has finished; subscribers such as the mailbox plugin react to this event.",
    triggers: { ko: "턴 종료 신호 발행 턴완료 acp" },
    params: {
      source: {
        type: "string",
        description: tmsg("cmd.turn.signal.param.source"),
      },
      tabId: { type: "string", description: "Related tab id (optional)" },
      workspace: { type: "string", description: "Workspace id (optional)" },
      root: { type: "string", description: "Workspace root path — scope key used by subscribers to filter events" },
      command: { type: "string", description: "Description of the completed task or command (optional, enriches event body)" },
    },
    returns: "{ emitted, projectId }",
    message: () => tmsg("msg.turn.signal"),
    errors: ["INTERNAL"],
    examples: ['turn.signal \'{"source":"acp","root":"/Users/me/proj","command":"claude reply finished"}\''],
    handler: (p) => {
      const projectId = typeof p.workspace === "string" ? p.workspace : null;
      emitPluginEvent("turn.ended", {
        projectId,
        root: typeof p.root === "string" ? p.root : null,
        paneId: typeof p.tabId === "string" ? p.tabId : null,
        source:
          p.source === "shell" || p.source === "idle" ? p.source : "acp",
        command: typeof p.command === "string" ? p.command : null,
      });
      return { emitted: true, projectId };
    },
  });

  register("turn.idleDetection", {
    description:
      "Toggle the idle-output heuristic turn.ended provider (off by default). When enabled, a terminal with no output for N ms is treated as a completed turn; false positives are possible.",
    triggers: { ko: "유휴감지 턴감지 아이들 idle 자동턴종료" },
    params: {
      enabled: { type: "boolean", description: "Enable or disable idle detection", required: true },
      ms: { type: "number", description: "No-output threshold in ms (default 2000, minimum 250)" },
    },
    returns: "{ enabled, ms }",
    message: (d) => d.enabled ? tmsg("msg.turn.idleDetection.on", { ms: Number(d.ms) }) : tmsg("msg.turn.idleDetection.off"),
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['turn.idleDetection \'{"enabled":true,"ms":1500}\''],
    handler: (p) => {
      if (typeof p.enabled !== "boolean") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.turn.idleDetection.enabledRequired") };
      }
      setIdleTurnDetection(p.enabled, typeof p.ms === "number" ? p.ms : undefined);
      return { enabled: isIdleTurnDetectionOn(), ms: idleTurnMs() };
    },
  });
}
