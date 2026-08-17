import { tmsg, key} from "../i18n";
import { useBootPhase } from "../state/bootPhase";
import { awaitBootReady } from "../state/bootReady";
import { awaitCommandHostReady } from "./executor";
import { register } from "./registry";

export function registerBootCatalog(): void {
  register("app.boot.status", {
    description: key("cmd.app.boot.status.desc"),
    triggers: { ko: "앱 부트 준비 상태 위상" },
    params: {},
    returns: "{ phase: 'restoring'|'activating'|'ready' }",
    message: (data) => tmsg("msg.app.boot.status", { phase: String(data.phase) }),
    handler: async () => ({ phase: useBootPhase.getState().phase }),
  });
  register("app.boot.wait", {
    description:
      "Wait for the workspace boot phase to become ready through the state subscription event; no polling.",
    triggers: { ko: "앱 부트 준비 대기 사건" },
    params: { timeoutMs: { type: "number", description: "Finite timeout in milliseconds (default 30000)" } },
    returns: "{ phase: 'ready' }",
    message: () => tmsg("msg.app.boot.wait"),
    handler: async (params) => awaitBootReady(Number(params.timeoutMs ?? 30_000)),
  });
  // Workspace phase and plugin boot are **different facts** — the phase is ready while the plugin
  // body is still running. Wait here to read anything stamped after that.
  register("plugin.boot.wait", {
    description:
      "Wait until this window's plugin boot has finished — every plugin activated and the command host open. The workspace boot phase (app.boot.wait) becomes ready earlier, while the plugin body is still running, so anything a plugin stamps or registers is not there yet. Event-driven: it resolves immediately when boot already finished, otherwise it waits on that signal; it never polls. Exceeding the timeout is refused by name rather than answered as ready.",
    triggers: { ko: "플러그인 부팅 완료 대기 활성화 끝 사건 명령호스트" },
    params: { timeoutMs: { type: "number", description: "Finite timeout in milliseconds (default 30000)" } },
    returns: "{ ready: true }",
    message: () => tmsg("msg.plugin.boot.wait"),
    errors: ["TIMEOUT"],
    examples: ["plugin.boot.wait"],
    handler: async (params) => awaitCommandHostReady(Number(params.timeoutMs ?? 30_000)),
  });
}
