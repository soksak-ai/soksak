import { invoke } from "../framework";
import { key, tmsg } from "../i18n";
import { register } from "./registry";

type ComponentKind = "plugin" | "sidecar" | "kit";
type ComponentRecord = { id: string; version: string; development: boolean };
type CompositionSettings = {
  generation: number;
  plugins: ComponentRecord[];
  sidecars: ComponentRecord[];
  kits: ComponentRecord[];
};

const CONFIG = {
  plugin: { array: "plugins", manifest: "plugin.json" },
  sidecar: { array: "sidecars", manifest: "sidecar.json" },
  kit: { array: "kits", manifest: "package.json" },
} as const satisfies Record<ComponentKind, { array: keyof Pick<CompositionSettings, "plugins" | "sidecars" | "kits">; manifest: string }>;

async function settings(): Promise<CompositionSettings> {
  return invoke<CompositionSettings>("composition_settings");
}

function registerKind(kind: ComponentKind): void {
  const config = CONFIG[kind];
  register(`${kind}.development.list`, {
    description: key("cmd.component.development.list.desc", { kind }),
    params: {},
    windowScoped: false,
    returns: `{ generation, ${config.array}: Array<{id,version,development,...}> }`,
    message: (data) => tmsg("msg.component.development.list", { kind, n: (data[config.array] as unknown[]).length }),
    examples: [`${kind}.development.list`],
    handler: async () => {
      const current = await settings();
      return { generation: current.generation, [config.array]: current[config.array] };
    },
  });

  register(`${kind}.development.set`, {
    description: key("cmd.component.development.set.desc", { kind }),
    params: {
      id: { type: "string", required: true, description: key("cmd.component.development.set.param.id") },
      version: { type: "string", required: true, description: key("cmd.component.development.set.param.version") },
      development: { type: "boolean", required: true, description: key("cmd.component.development.set.param.development") },
      path: { type: "string", required: true, description: key("cmd.component.development.set.param.path") },
    },
    windowScoped: false,
    returns: "{ kind, id, version, development, path, generation }",
    message: (data) => tmsg("msg.component.development.set", { kind, id: String(data.id), version: String(data.version) }),
    errors: ["INVALID_PARAMS", "TARGET_NOT_FOUND"],
    examples: [
      `${kind}.development.set id=demo version=0.0.1 development=true path=/absolute/path`,
      `${kind}.development.set '{"id":"demo","version":"0.0.1","development":true,"path":"/absolute/path"}'`,
    ],
    danger: "inject",
    handler: async (params) => {
      const current = await settings();
      const id = params.id as string;
      const version = params.version as string;
      const development = params.development as boolean;
      const path = params.path as string;
      const change = await invoke<{ generation: number }>(`${kind}_development_set`, {
        id, version, development, path, manifest: config.manifest,
        source: { type: "path", path }, expectedGeneration: current.generation,
      });
      return { kind, id, version, development, path, generation: change.generation };
    },
  });
}

export function registerDevelopmentCatalog(): void {
  registerKind("plugin");
  registerKind("sidecar");
  registerKind("kit");
}
