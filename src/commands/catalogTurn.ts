// turn.* 명령 — 오픈 "턴 종료" 신호 표면(CLI/MCP/플러그인 공용). turn.signal 은 임의 provider 가
// 커맨드로 turn.ended 를 발행하는 길(ACP·외부 도구·E2E 주입). turn.idleDetection 은 코어 유휴
// 휴리스틱 provider 토글(기본 OFF). 코어는 특정 소비자(메일함 등)를 모른다 — 토픽/커맨드 계약만.

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
        description: "Signal origin (shell / idle / acp — defaults to acp)",
      },
      paneId: { type: "string", description: "Related pane id (optional)" },
      project: { type: "string", description: "Project id (optional)" },
      root: { type: "string", description: "Project root path — scope key used by subscribers to filter events" },
      command: { type: "string", description: "Description of the completed task or command (optional, enriches event body)" },
    },
    returns: "{ emitted }",
    message: () => tmsg("msg.turn.signal"),
    errors: ["INTERNAL"],
    examples: ['sok turn.signal \'{"source":"acp","root":"/Users/me/proj","command":"claude 응답 완료"}\''],
    handler: (p) => {
      emitPluginEvent("turn.ended", {
        projectId: typeof p.project === "string" ? p.project : null,
        root: typeof p.root === "string" ? p.root : null,
        paneId: typeof p.paneId === "string" ? p.paneId : null,
        source:
          p.source === "shell" || p.source === "idle" ? p.source : "acp",
        command: typeof p.command === "string" ? p.command : null,
      });
      return { emitted: true };
    },
  });

  register("turn.idleDetection", {
    description:
      "Toggle the idle-output heuristic turn.ended provider (off by default). When enabled, a pane with no output for N ms is treated as a completed turn; false positives are possible.",
    triggers: { ko: "유휴감지 턴감지 아이들 idle 자동턴종료" },
    params: {
      enabled: { type: "boolean", description: "Enable or disable idle detection", required: true },
      ms: { type: "number", description: "No-output threshold in ms (default 2000, minimum 250)" },
    },
    returns: "{ enabled, ms }",
    message: (d) => d.enabled ? tmsg("msg.turn.idleDetection.on", { ms: Number(d.ms) }) : tmsg("msg.turn.idleDetection.off"),
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['sok turn.idleDetection \'{"enabled":true,"ms":1500}\''],
    handler: (p) => {
      if (typeof p.enabled !== "boolean") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "enabled(boolean) 필요" };
      }
      setIdleTurnDetection(p.enabled, typeof p.ms === "number" ? p.ms : undefined);
      return { enabled: isIdleTurnDetectionOn(), ms: idleTurnMs() };
    },
  });
}
