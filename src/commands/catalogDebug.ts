// debug.* **dev 전용** 테스트 커맨드 — 스케줄러 process_lease lease 로직(도는 중 무중단·재발화 0·
// cancel-wakes-wait)을 실 LLM/exec-one 없이 빠르게 e2e 검증한다. debug.sleep 은 핸들러가 ms 동안 reply 를
// 보류한다 — 프론트 executor 가 핸들러 Promise 를 await 하므로(executor.ts: timeout 0) cmd_result 가 ms 만큼
// 늦게 나간다. 그동안 코어 fire_process 는 reply 를 기다리며 lease 를 쥔다 = exec-one 의 held-reply 대체.
//
// import.meta.env.DEV 게이트 — 개발 빌드에서만 등록되고 프로덕션 번들엔 없다(dev.remoteConfirmMock 선례).
// danger:"inject" 로 분류해 원격 정책 게이트도 거친다(소켓 e2e 는 remoteInject=allow dev 기본).
import { register } from "./registry";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function registerDebugCatalog(): void {
  if (!import.meta.env.DEV) return;

  register("debug.sleep", {
    description:
      "DEV-ONLY: hold the reply for `ms` then return (ok by default; ok:false when fail=true). Simulates a held-reply process (exec-one onExit) so the scheduler's process_lease lease — no-kill while running, single in-flight, cancel-wakes-wait — can be e2e-tested without a real LLM. Absent in production builds.",
    triggers: { ko: "디버그 슬립 대기 보류 테스트 lease 스케줄러" },
    params: {
      ms: { type: "number", description: "Milliseconds to hold the reply before returning (default 3000)." },
      fail: { type: "boolean", description: "Return ok:false instead of ok:true (exercises backoff/crash path)." },
    },
    returns: "{ slept } (ok:true) | { ok:false } when fail",
    danger: "inject",
    errors: ["INTERNAL"],
    examples: ['sok debug.sleep \'{"ms":5000}\'', 'sok debug.sleep \'{"ms":2000,"fail":true}\''],
    handler: async (p) => {
      const ms = typeof p.ms === "number" && p.ms >= 0 ? p.ms : 3000;
      await sleep(ms);
      if (p.fail === true) {
        return { ok: false as const, code: "INTERNAL" as const, message: `debug.sleep fail after ${ms}ms` };
      }
      return { slept: ms }; // execute() 가 { ok:true, slept } 로 래핑 → reply.ok=true.
    },
  });
}
