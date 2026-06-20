// schedule.* commands — fire a registry command at an absolute epoch-ms timestamp (one-shot).
// Delegates to core ScheduleState (in-memory timer — sleeps exactly until next due, zero polling).
// One-shot by design: callers re-arm after firing for recurrence; combine with notify.show for reminders.
// Core holds no persistence — plugins store their own schedules and re-arm on activate.

import { invoke } from "@tauri-apps/api/core";
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
    returns: "{ scheduleId }",
    danger: "inject",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: [
      'sok schedule.set \'{"at":1750000000000,"command":"notify.show","params":{"title":"알림","body":"시간!"}}\'',
    ],
    handler: async (p) => {
      if (typeof p.at !== "number" || typeof p.command !== "string") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "at·command 필요" };
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

  register("schedule.cancel", {
    description: "Cancel a pending schedule by id. Returns removed=true if the schedule existed.",
    triggers: { ko: "스케줄 취소 삭제 예약취소 cancel" },
    params: { id: { type: "string", description: "Schedule id issued by schedule.set", required: true } },
    returns: "{ removed }",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['sok schedule.cancel \'{"id":"sch-3"}\''],
    handler: async (p) => {
      if (typeof p.id !== "string") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "id 필요" };
      }
      const removed = await invoke<boolean>("schedule_cancel", { id: p.id });
      return { removed };
    },
  });

  register("schedule.list", {
    description: "List all pending schedules sorted by fire time ascending (id, at, command, params).",
    triggers: { ko: "스케줄 목록 예약 리스트 조회" },
    params: {},
    returns: "{ schedules: [{ id, at, command, params }] }",
    errors: ["INTERNAL"],
    examples: ["sok schedule.list"],
    handler: async () => {
      const schedules = await invoke<unknown[]>("schedule_list");
      return { schedules };
    },
  });
}
