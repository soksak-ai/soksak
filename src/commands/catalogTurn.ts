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

export function registerTurnCatalog(): void {
  register("turn.signal", {
    description:
      "turn.ended 이벤트 발행(오픈 신호). 어떤 provider(ACP·외부 도구·테스트)든 턴 종료를 알릴 때. 구독자(메일함 등)가 받는다",
    params: {
      source: {
        type: "string",
        description: "신호 출처(shell/idle/acp 등 — 기본 acp)",
      },
      paneId: { type: "string", description: "관련 pane(선택)" },
      project: { type: "string", description: "프로젝트 id(선택)" },
    },
    returns: "{ emitted }",
    errors: ["INTERNAL"],
    examples: ['sok turn.signal \'{"source":"acp","project":"projA"}\''],
    handler: (p) => {
      emitPluginEvent("turn.ended", {
        projectId: typeof p.project === "string" ? p.project : null,
        paneId: typeof p.paneId === "string" ? p.paneId : null,
        source:
          p.source === "shell" || p.source === "idle" ? p.source : "acp",
      });
      return { emitted: true };
    },
  });

  register("turn.idleDetection", {
    description:
      "출력 유휴 휴리스틱 turn.ended provider 토글(기본 OFF). 실행 중 pane 출력이 N ms 멈추면 턴 종료로 추정(오탐 가능)",
    params: {
      enabled: { type: "boolean", description: "켜기/끄기", required: true },
      ms: { type: "number", description: "무출력 임계(ms, 기본 2000, 최소 250)" },
    },
    returns: "{ enabled, ms }",
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
