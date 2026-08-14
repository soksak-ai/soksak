// orchestrator.* — natural-language console commands, registered in the main window only. main is a
// control-plane reserved word (docs/NAMING.md §1-4b): this capability does not exist in workspace
// windows — socket calls target it explicitly with `sok --window main orchestrator.ask …`.

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
    examples: ['--window main orchestrator.ask \'{"text":"list the open windows","timeoutMs":300000}\''],
    // chat.prompt/chat.answer represent the set — the duplicate command.executed record is excluded.
    trace: false,
    // The answer (AI text) is not spoken — only the commands inside the turn speak, each by its own tts spec.
    speak: () => "", // silence — the set (chat.prompt/answer) is this turn's surface (§3 speak rule)
    handler: (p) => ask({ text: String(p.text ?? ""), window: p.window as string | undefined }),
  });

  register("orchestrator.stop", {
    description: "Cancel the in-flight natural-language turn (kills the agent process; the set closes as CANCELLED).",
    triggers: { ko: "중단 멈춰 취소 턴 중지" },
    params: {},
    returns: "{ stopped }",
    message: (d) => (d.stopped ? tmsg("msg.orchestrator.stop.stopped") : tmsg("msg.orchestrator.stop.idle")),
    examples: ["--window main orchestrator.stop"],
    speak: () => "", // silence — the set (chat.prompt/answer) is this turn's surface (§3 speak rule)
    handler: () => stop(),
  });
}
