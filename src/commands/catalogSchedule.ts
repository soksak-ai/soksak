// schedule.* 스케줄러 명령 — 절대 시각 at(epoch ms)에 registry 명령 command(params)를 한 번 발화.
// 코어 ScheduleState(인메모리 타이머 — 다음 due 까지 정확히 잠, 고정 폴링 0)에 위임. 단발이므로
// 반복은 호출자가 발화 후 재무장하고, 리마인더는 예약된 notify.show 로 조합한다(코어는 타이밍만).
// 영속은 코어가 갖지 않는다 — 플러그인이 자기 일정을 보관하고 activate 시 재무장한다.

import { invoke } from "@tauri-apps/api/core";
import { register } from "./registry";

export function registerScheduleCatalog(): void {
  register("schedule.set", {
    description:
      "절대 시각 at(epoch ms)에 registry 명령 command(params)를 한 번 발화 예약. id 생략 시 발급(있으면 교체). 단발 — 반복은 발화 후 재무장, 리마인더는 별도 예약된 notify.show 로 조합",
    params: {
      at: { type: "number", description: "발화 시각(epoch ms)", required: true },
      command: { type: "string", description: "발화할 registry 명령 이름", required: true },
      params: { type: "json", description: "명령 파라미터(생략 시 빈 오브젝트)" },
      id: { type: "string", description: "기존 일정 교체용 id(생략 시 발급)" },
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
    description: "예약된 일정 취소(id). 있었으면 removed=true.",
    params: { id: { type: "string", description: "schedule.set 이 발급한 id", required: true } },
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
    description: "예약된 일정 목록(at 오름차순 — id·at·command·params).",
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
