// schedule.* commands — fire a registry command at an absolute epoch-ms timestamp (one-shot).
// Delegates to core ScheduleState (in-memory timer — sleeps exactly until next due, zero polling).
// One-shot by design: callers re-arm after firing for recurrence; combine with notify.show for reminders.
// Core holds no persistence — plugins store their own schedules and re-arm on activate.

import { invoke } from "../framework";
import { tmsg, key} from "../i18n";
import { register } from "./registry";

export function registerScheduleCatalog(): void {
  register("schedule.set", {
    description:
      "Schedule a registry command to fire once at an absolute epoch-ms timestamp. Generates a new id if omitted; replaces an existing schedule when id is supplied. For recurrence, re-arm after the command fires; compose with notify.show for reminders.",
    triggers: { ko: "스케줄 예약 타이머 알람 일정 등록" },
    params: {
      at: { type: "number", description: "Fire time as epoch milliseconds", required: true },
      command: { type: "string", description: "Registry command name to fire", required: true },
      params: { type: "json", description: "Command parameters (defaults to empty object when omitted)" },
      id: { type: "string", description: "Existing schedule id to replace (a new id is issued when omitted)" },
    },
    // The answer is home-wide, not per-window — same in every window (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ scheduleId }",
    message: (d) => tmsg("msg.schedule.set", { id: String(d.scheduleId) }),
    danger: "inject",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: [
      'schedule.set \'{"at":1750000000000,"command":"notify.show","params":{"title":"Reminder","body":"Time is up"}}\'',
    ],
    handler: async (p) => {
      if (typeof p.at !== "number" || typeof p.command !== "string") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.schedule.set.paramsRequired") };
      }
      const scheduleId = await invoke<string>("schedule_set", {
        at: p.at,
        command: p.command,
        params: (p.params as Record<string, unknown> | undefined) ?? null,
        id: (p.id as string | undefined) ?? null,
      });
      return { scheduleId };
    },
  });

  register("schedule.register", {
    description:
      "Register a scheduler job (trigger + registry command to fire). trigger = { kind:'at', at } | { kind:'every', every_ms, anchor? } | { kind:'cron', expr } | { kind:'reconcile' }. process_lease=true holds the lease until the fired command's process exits (no kill while running, zombie_backstop_ms cap, default 3h). retry = { max, base_ms, max_ms } for ok:false backoff. Returns the assigned id. Generalizes schedule.set.",
    triggers: { ko: "스케줄 등록 register 트리거 reconcile cron every 프로세스" },
    params: {
      trigger: { type: "json", description: "{ kind:'at'|'every'|'cron'|'reconcile', ... }", required: true },
      command: { type: "string", description: "Registry command name to fire", required: true },
      params: { type: "json", description: "Command parameters (fired with the command)" },
      id: { type: "string", description: "Existing job id to replace (new id issued when omitted)" },
      retry: { type: "json", description: "{ max, base_ms, max_ms } — backoff on ok:false" },
      concurrency: { type: "number", description: "Reserved (per-job lease is always single)" },
      timeout_ms: { type: "number", description: "Non-process wait cap (ms). Ignored when process_lease." },
      process_lease: { type: "boolean", description: "Hold lease until fired process exits (exec-one)" },
      zombie_backstop_ms: { type: "number", description: "Process-lease zombie cap (ms). null=infinite, default 3h" },
    },
    // The answer is home-wide, not per-window — same in every window (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ jobId }",
    message: (d) => tmsg("msg.schedule.register", { id: String(d.jobId) }),
    danger: "inject",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: [
      'schedule.register \'{"trigger":{"kind":"every","every_ms":60000},"command":"notify.show","params":{"title":"Tick","body":"1 minute"}}\'',
      'schedule.register \'{"trigger":{"kind":"reconcile"},"command":"plugin.soksak-plugin-<id>.<command>","process_lease":true,"retry":{"max":5,"base_ms":2000,"max_ms":60000}}\'',
    ],
    handler: async (p) => {
      if (typeof p.command !== "string" || p.trigger == null || typeof p.trigger !== "object") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.schedule.register.paramsRequired") };
      }
      const jobId = await invoke<string>("schedule_register", {
        trigger: p.trigger,
        command: p.command,
        params: (p.params as Record<string, unknown> | undefined) ?? null,
        id: (p.id as string | undefined) ?? null,
        retry: (p.retry as Record<string, unknown> | undefined) ?? null,
        concurrency: (p.concurrency as number | undefined) ?? null,
        timeout_ms: (p.timeout_ms as number | undefined) ?? null,
        process_lease: (p.process_lease as boolean | undefined) ?? null,
        zombie_backstop_ms: (p.zombie_backstop_ms as number | null | undefined) ?? null,
      });
      return { jobId };
    },
  });

  register("schedule.poke", {
    description:
      "Fire a job immediately (completion trigger / external change). id given = that job; omitted = all reconcile jobs. Running jobs coalesce (re-fire once after completion).",
    triggers: { ko: "스케줄 깨우기 poke 재평가 reconcile 틱" },
    params: { id: { type: "string", description: "Job id (omit = all reconcile jobs)" } },
    // The answer is home-wide, not per-window — same in every window (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ ok }",
    message: () => tmsg("msg.schedule.poke"),
    danger: "inject",
    errors: ["INTERNAL"],
    examples: ["schedule.poke", 'schedule.poke \'{"id":"sch-3"}\''],
    handler: async (p) => {
      await invoke("schedule_poke", { id: (p.id as string | undefined) ?? null });
      return { ok: true as const };
    },
  });

  register("schedule.cancel", {
    description: key("cmd.schedule.cancel.desc"),
    triggers: { ko: "스케줄 취소 삭제 예약취소 cancel" },
    params: { id: { type: "string", description: "Schedule id issued by schedule.set", required: true } },
    // The answer is home-wide, not per-window — same in every window (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ removed }",
    message: (d) => d.removed ? tmsg("msg.schedule.cancel.removed") : tmsg("msg.schedule.cancel.missing"),
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['schedule.cancel \'{"id":"sch-3"}\''],
    handler: async (p) => {
      if (typeof p.id !== "string") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.schedule.cancel.idRequired") };
      }
      const removed = await invoke<boolean>("schedule_cancel", { id: p.id });
      return { removed };
    },
  });

  register("schedule.list", {
    description:
      "List all jobs sorted by next fire time ascending. Each: { id, trigger, command, params, next_at, running, concurrency }. next_at=null means waiting (reconcile/event) or running. running=true means a fire is in flight (lease held).",
    triggers: { ko: "스케줄 목록 예약 리스트 조회" },
    params: {},
    // The answer is home-wide, not per-window — same in every window (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ schedules: [{ id, trigger, command, params, next_at, running, concurrency }] }",
    message: (d) => tmsg("msg.schedule.list", { n: ((d.schedules as unknown[]) ?? []).length }),
    errors: ["INTERNAL"],
    examples: ["schedule.list"],
    handler: async () => {
      const schedules = await invoke<unknown[]>("schedule_list");
      return { schedules };
    },
  });
}
