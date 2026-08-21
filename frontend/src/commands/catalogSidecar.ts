import { invoke } from "../framework";
import { key, tmsg } from "../i18n";
import { register } from "./registry";

export function registerSidecarCatalog(): void {
  register("sidecar.request", {
    description: key("cmd.sidecar.request.desc"),
    params: {
      name: { type: "string", required: true, description: key("cmd.sidecar.request.param.name") },
      request: { type: "json", required: true, description: key("cmd.sidecar.request.param.request") },
    },
    windowScoped: false,
    danger: "inject",
    returns: "The sidecar control-protocol response",
    message: (data) => tmsg("msg.sidecar.request", { name: String(data.sidecar ?? "") }),
    examples: [
      'sidecar.request \'{"name":"pty","request":{"id":"inspect","command":"pty.pane","args":{"request":{"paneId":"p1"}}}}\'',
    ],
    handler: async (params) => {
      if (typeof params.request !== "object" || params.request === null || Array.isArray(params.request)) {
        return { ok: false, code: "INVALID_PARAMS", message: tmsg("msg.sidecar.request.objectRequired") };
      }
      const result = await invoke<Record<string, unknown>>("sidecar_send", {
        name: params.name,
        payload: JSON.stringify(params.request),
      });
      return { sidecar: params.name, response: result };
    },
  });
}
