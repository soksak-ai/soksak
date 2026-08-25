import { invoke } from "../framework";
import { key, tmsg } from "../i18n";
import { register } from "./registry";
import { installLocalSidecar, planLocalSidecar } from "../plugins/localReleaseInstallService";

export function registerSidecarCatalog(): void {
  register("sidecar.install.local.plan", {
    description: key("cmd.sidecar.install.local.plan.desc"),
    params: {
      store: { type: "string", required: true, description: key("cmd.plugin.install.local.param.store") },
      sidecarId: { type: "string", required: true, description: key("cmd.sidecar.install.local.param.id") },
      version: { type: "string", required: true, description: key("cmd.sidecar.install.local.param.version") },
    },
    returns: "{ digest,store,id,version,releases:[{kind,id,version,artifacts:[{target,size,sha256}]}] }",
    message: (data) => tmsg("msg.sidecar.install.local.plan", { id: String(data.id) }),
    examples: [`sidecar.install.local.plan '{"store":"/absolute/releases","sidecarId":"soksak-sidecar-<id>","version":"0.0.1"}'`],
    handler: (params) => planLocalSidecar(String(params.store), String(params.sidecarId), String(params.version)),
  });

  register("sidecar.install.local", {
    description: key("cmd.sidecar.install.local.desc"),
    params: {
      store: { type: "string", required: true, description: key("cmd.plugin.install.local.param.store") },
      sidecarId: { type: "string", required: true, description: key("cmd.sidecar.install.local.param.id") },
      version: { type: "string", required: true, description: key("cmd.sidecar.install.local.param.version") },
      planDigest: { type: "string", required: true, description: key("cmd.plugin.install.local.param.planDigest") },
    },
    returns: "{ id,version,revision }",
    message: (data) => tmsg("msg.sidecar.install.local", { id: String(data.id), version: String(data.version) }),
    errors: ["SIDECAR_IN_USE", "LOCAL_INSTALL_PLAN_CHANGED", "VERSION_ARTIFACT_CONFLICT", "INTERNAL"],
    examples: [`sidecar.install.local '{"store":"/absolute/releases","sidecarId":"soksak-sidecar-<id>","version":"0.0.1","planDigest":"<sha256>"}'`],
    danger: "destructive",
    handler: (params) => installLocalSidecar(String(params.store), String(params.sidecarId), String(params.version), String(params.planDigest)),
  });

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
