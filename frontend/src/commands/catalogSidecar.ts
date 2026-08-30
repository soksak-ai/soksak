import { invoke } from "../framework";
import { key, tmsg } from "../i18n";
import { register } from "./registry";
import { DependencyVersionConflict, installLocalSidecar, planLocalSidecar, sidecarInUse, sidecarInUseMessage } from "../plugins/localReleaseInstallService";
import { writeDevelopRecord } from "./develop";
import { writeEnvironmentRevision, type HostEnvironment } from "../state/environmentEvents";
import { publishActivity } from "../state/activityFeed";

interface RunningSidecarStatus {
  name: string;
  version: string;
  process: string;
  pid: number;
}

export function registerSidecarCatalog(): void {
  register("sidecar.status", {
    description: key("cmd.sidecar.status.desc"),
    params: {},
    windowScoped: false,
    returns: "{ units: [{ name, version, process, pid }] }",
    message: (data) => tmsg("msg.sidecar.status", { n: ((data.units as unknown[]) ?? []).length }),
    errors: ["INTERNAL"],
    examples: ["sidecar.status"],
    handler: async () => {
      const status = await invoke<{ open: RunningSidecarStatus[] }>("sidecar_status");
      return {
        units: status.open.map(({ name, version, process, pid }) => ({ name, version, process, pid })),
      };
    },
  });

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
    errors: ["DEPENDENCY_VERSION_CONFLICT", "INTERNAL"],
    handler: async (params) => {
      try { return await planLocalSidecar(String(params.store), String(params.sidecarId), String(params.version)); }
      catch (cause) {
        if (cause instanceof DependencyVersionConflict) {
          return { ok: false, code: cause.code, message: cause.message, conflict: cause.conflict };
        }
        throw cause;
      }
    },
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
    errors: ["DEPENDENCY_VERSION_CONFLICT", "SIDECAR_IN_USE", "LOCAL_INSTALL_PLAN_CHANGED", "VERSION_ARTIFACT_CONFLICT", "INTERNAL"],
    examples: [`sidecar.install.local '{"store":"/absolute/releases","sidecarId":"soksak-sidecar-<id>","version":"0.0.1","planDigest":"<sha256>"}'`],
    danger: "destructive",
    handler: (params) => installLocalSidecar(String(params.store), String(params.sidecarId), String(params.version), String(params.planDigest)),
  });

  register("sidecar.develop", {
    description: key("cmd.sidecar.develop.desc"),
    params: {
      // sidecarId, not id — the S6 gate (noAlias.test.ts) refuses the plugin.develop signature under a second name.
      sidecarId: { type: "string", required: true, description: key("cmd.sidecar.develop.param.id") },
      path: { type: "string", required: true, description: key("cmd.sidecar.develop.param.path") },
    },
    windowScoped: false,
    // version: the version of the record the host wrote, read from environment_get after the write.
    returns: "{ id, path, revision, version }",
    message: (data) => tmsg("msg.sidecar.develop", { id: String(data.id), path: String(data.path), version: String(data.version) }),
    // SIDECAR_IN_USE: sidecar_status lists the id as open or recorded (same rule as sidecar.install.local and
    // sidecar.remove); no auto-stop. The host refuses a relative path, a manifest that does not declare the id, a
    // missing dist/<id>, a stale revision, or a broken dependency; each refusal is returned as INTERNAL.
    errors: ["INVALID_PARAMS", "SIDECAR_IN_USE", "INTERNAL"],
    examples: [`sidecar.develop '{"sidecarId":"soksak-sidecar-<id>","path":"/absolute/checkout"}'`],
    danger: "destructive",
    handler: async (params) => {
      const id = String(params.sidecarId);
      const path = String(params.path);
      if (await sidecarInUse(id)) return { ok: false, code: "SIDECAR_IN_USE", message: sidecarInUseMessage(id, "development") };
      const { revision } = await writeDevelopRecord("sidecar_develop", { id, path });
      const record = (await invoke<HostEnvironment>("environment_get")).sidecars[id];
      if (record === undefined) throw new Error(`environment revision ${revision} holds no sidecar record for ${id}`);
      return { id, path, revision, version: record.version };
    },
  });

  register("sidecar.remove", {
    description: key("cmd.sidecar.remove.desc"),
    params: {
      sidecarId: { type: "string", required: true, description: key("cmd.sidecar.remove.param.id") },
    },
    windowScoped: false,
    returns: "{ id, revision }",
    message: (data) => tmsg("msg.sidecar.remove", { id: String(data.id) }),
    // SIDECAR_IN_USE: sidecar_status lists the id as open or recorded (same rule as sidecar.install.local); no
    // auto-stop. The host refuses an unknown id, a stale revision, a broken dependency, or a path outside
    // <home>/components/; each refusal is a thrown host error and is returned as INTERNAL with the host message.
    // A change with artifactDeleteFailed is a success: the record is removed; one activity names the directory
    // that remains.
    errors: ["SIDECAR_IN_USE", "INTERNAL"],
    examples: [`sidecar.remove '{"sidecarId":"soksak-sidecar-<id>"}'`],
    danger: "destructive",
    handler: async (params) => {
      const id = String(params.sidecarId);
      if (await sidecarInUse(id)) return { ok: false, code: "SIDECAR_IN_USE", message: sidecarInUseMessage(id, "removal") };
      const change = await writeEnvironmentRevision("sidecar_remove", { id });
      if (change.artifactDeleteFailed) {
        const { path, error } = change.artifactDeleteFailed;
        publishActivity("sidecar.remove.artifactLeft", "core", { id, path, error, message: tmsg("sidecar.remove.artifactLeft", { id, path }) });
      }
      return { id, revision: change.revision };
    },
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
