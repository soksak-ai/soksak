// debug.* **dev-only** test commands — fast e2e check of the scheduler process_lease logic (no kill while
// running, 0 re-fires, cancel-wakes-wait) without a real LLM or exec-one. In debug.sleep the handler holds the
// reply for ms — the front executor awaits the handler Promise (executor.ts: timeout 0), so cmd_result goes out
// ms late. Meanwhile core fire_process waits for the reply and holds the lease = a stand-in for exec-one's held-reply.
//
// import.meta.env.DEV gate — registered in dev builds only, absent from the production bundle (dev.remoteConfirmMock precedent).
// Classified danger:"inject" so it passes the remote policy gate too (socket e2e defaults to remoteInject=allow in dev).
import { register } from "./registry";
import { key, tmsg } from "../i18n";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function registerDebugCatalog(): void {
  if (!import.meta.env.DEV) return;

  register("debug.sleep", {
    description: key("cmd.debug.sleep.desc"),
    triggers: { ko: "디버그 슬립 대기 보류 테스트 lease 스케줄러" },
    params: {
      ms: { type: "number", description: key("cmd.debug.sleep.param.ms") },
      fail: { type: "boolean", description: key("cmd.debug.sleep.param.fail") },
    },
    returns: "{ slept } (ok:true) | { ok:false } when fail",
    message: (d) => tmsg("msg.debug.sleep", { ms: Number(d.slept) }),
    danger: "inject",
    errors: ["INTERNAL"],
    examples: ['debug.sleep \'{"ms":5000}\'', 'debug.sleep \'{"ms":2000,"fail":true}\''],
    handler: async (p) => {
      const ms = typeof p.ms === "number" && p.ms >= 0 ? p.ms : 3000;
      await sleep(ms);
      if (p.fail === true) {
        return { ok: false as const, code: "INTERNAL" as const, message: `debug.sleep fail after ${ms}ms` };
      }
      return { slept: ms }; // execute() wraps this as { ok:true, slept } → reply.ok=true.
    },
  });
}
