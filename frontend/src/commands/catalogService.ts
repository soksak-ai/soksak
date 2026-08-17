// service.* commands — observe resident plugin services (docs/PLUGIN-SERVICE.md).
// A plugin service is the third execution form: a manifest-declared resident process the
// core spawns, frames, and routes. Its lifecycle (spawning/ready/draining/backoff/error)
// must be observable, never silently wedged (PS10) — this is the status axis of that.
// Bind/dispatch/bus-push are core-internal invokes (the loader owns them); status is the
// one surface AI/E2E read directly.

import { invoke } from "../framework";
import { tmsg, key} from "../i18n";
import { register } from "./registry";

export function registerServiceCatalog(): void {
  register("service.status", {
    description:
      "Report resident plugin services and their live status. A live generation exposes the exact manager-owned pid and owner:'service-manager'; reaped/error/stopped generations expose pid:null. status is one of spawning|ready|draining|backoff:<n>|error:<reason>|stopped.",
    triggers: { ko: "상주 서비스 상태 조회 확인" },
    params: {
      plugin: {
        type: "string",
        required: false,
        description: key("cmd.service.status.param.plugin"),
      },
    },
    // The owner produces the answer — identical in every window (registry.ts windowScoped).
    windowScoped: false,
    returns:
      "{ services: [{ plugin, status, ops, inflight, generation, pid, owner, secretDependent }] } or { plugin, status }",
    message: (d) =>
      d.plugin !== undefined
        ? tmsg("msg.service.status.one", {
            plugin: String(d.plugin),
            status: String((d as { status?: unknown }).status ?? "?"),
          })
        : tmsg("msg.service.status", {
            n: ((d.services as unknown[]) ?? []).length,
          }),
    errors: ["INTERNAL"],
    examples: ["service.status", 'service.status \'{"plugin":"<plugin-id>"}\''],
    handler: async (params) => {
      const plugin = params.plugin as string | undefined;
      return await invoke<object>("service_status", plugin ? { plugin } : {});
    },
  });
}
