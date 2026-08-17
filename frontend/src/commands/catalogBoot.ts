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
    description: key("cmd.app.boot.wait.desc"),
    triggers: { ko: "앱 부트 준비 대기 사건" },
    params: { timeoutMs: { type: "number", description: key("cmd.app.boot.wait.param.timeoutMs") } },
    returns: "{ phase: 'ready' }",
    message: () => tmsg("msg.app.boot.wait"),
    handler: async (params) => awaitBootReady(Number(params.timeoutMs ?? 30_000)),
  });
  // Workspace phase and plugin boot are **different facts** — the phase is ready while the plugin
  // body is still running. Wait here to read anything stamped after that.
  register("plugin.boot.wait", {
    description: key("cmd.plugin.boot.wait.desc"),
    triggers: { ko: "플러그인 부팅 완료 대기 활성화 끝 사건 명령호스트" },
    params: { timeoutMs: { type: "number", description: key("cmd.plugin.boot.wait.param.timeoutMs") } },
    returns: "{ ready: true }",
    message: () => tmsg("msg.plugin.boot.wait"),
    errors: ["TIMEOUT"],
    examples: ["plugin.boot.wait"],
    handler: async (params) => awaitCommandHostReady(Number(params.timeoutMs ?? 30_000)),
  });
}
