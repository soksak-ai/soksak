// orchestrator.* — 자연어 콘솔 커맨드(main 창 전용 등록). main 은 컨트롤 플레인 예약어
// (docs/NAMING.md §1-4b): 워크스페이스 창에는 이 capability 가 존재하지 않는다 —
// 소켓 호출은 `sok --window main orchestrator.ask …` 로 명시 타겟한다.

import { register } from "./registry";
import { ask, cleanupOrphanTurn, stop, watchPrepInvalidation } from "../orchestrator/agent";
import { tmsg } from "../i18n";

export function registerOrchestratorCatalog(): void {
  cleanupOrphanTurn();
  watchPrepInvalidation();

  register("orchestrator.ask", {
    description:
      "Run one natural-language turn: spawns the configured agent CLI (settings orchestratorAgent) which drives the app through single `sok` commands. Every execution born from the turn carries payload.parentId=turnId, and the turn itself is recorded as chat.prompt → command.progress deltas → chat.answer — one conversation set in the activity stream. Long-running: pass a large timeoutMs when calling over the socket.",
    triggers: { ko: "자연어 명령 대화 실행 오케스트레이터 물어보기 시켜줘" },
    params: {
      text: { type: "string", description: "Natural-language instruction", required: true },
      window: {
        type: "string",
        description:
          "Stage window label for the turn (SOKSAK_WINDOW for the agent — its sok commands default there). Omit = no stage; the agent discovers windows itself.",
      },
    },
    returns: "{ turnId, answer } — message is the agent's final answer",
    message: (d) => (d.answer ? String(d.answer) : tmsg("msg.orchestrator.ask")),
    errors: ["INTERNAL", "TIMEOUT"],
    examples: ['sok --window main orchestrator.ask \'{"text":"열린 창을 알려줘","timeoutMs":300000}\''],
    // 세트는 chat.prompt/chat.answer 가 대표한다 — command.executed 중복 기록 제외.
    trace: false,
    // 답변(AI 텍스트)은 낭독하지 않는다 — 턴 안의 명령들만 각자의 tts 스펙으로 낭독된다.
    speak: () => "", // 침묵 — 세트(chat.prompt/answer)가 이 턴의 표면(§3 speak 룰)
    handler: (p) => ask({ text: String(p.text ?? ""), window: p.window as string | undefined }),
  });

  register("orchestrator.stop", {
    description: "Cancel the in-flight natural-language turn (kills the agent process; the set closes as CANCELLED).",
    triggers: { ko: "중단 멈춰 취소 턴 중지" },
    params: {},
    returns: "{ stopped }",
    message: (d) => (d.stopped ? tmsg("msg.orchestrator.stop.stopped") : tmsg("msg.orchestrator.stop.idle")),
    examples: ["sok --window main orchestrator.stop"],
    speak: () => "", // 침묵 — 세트(chat.prompt/answer)가 이 턴의 표면(§3 speak 룰)
    handler: () => stop(),
  });
}
