import { invoke } from "../framework";
import { key, tmsg } from "../i18n";
import { register } from "./registry";

type ComponentKind = "plugin" | "sidecar" | "kit" | "contract" | "spec";
type ComponentRecord = { development?: { path: string } };
type Settings = {
  revision: number;
  plugins: Record<string, ComponentRecord>;
  sidecars: Record<string, ComponentRecord>;
  kits: Record<string, ComponentRecord>;
  contracts: Record<string, ComponentRecord>;
  specs: Record<string, ComponentRecord>;
};

const CONFIG = {
  plugin: { array: "plugins", manifest: "plugin.json" },
  sidecar: { array: "sidecars", manifest: "sidecar.json" },
  kit: { array: "kits", manifest: "package.json" },
  contract: { array: "contracts", manifest: "contract.json" },
  spec: { array: "specs", manifest: "spec.json" },
} as const satisfies Record<ComponentKind, { array: keyof Omit<Settings, "revision">; manifest: string }>;

async function settings(): Promise<Settings> {
  return invoke<Settings>("settings_get");
}

function registerKind(kind: ComponentKind): void {
  const config = CONFIG[kind];
  register(`${kind}.development.list`, {
    description: key("cmd.component.development.list.desc", { kind }),
    params: {},
    windowScoped: false,
    returns: `{ revision, ${config.array}: Record<id,{development?:{path}}> }`,
    message: (data) => tmsg("msg.component.development.list", { kind, n: Object.keys(data[config.array] as object).length }),
    examples: [`${kind}.development.list`],
    handler: async () => {
      const current = await settings();
      return { revision: current.revision, [config.array]: current[config.array] };
    },
  });

  register(`${kind}.development.set`, {
    description: key("cmd.component.development.set.desc", { kind }),
    params: {
      id: { type: "string", required: true, description: key("cmd.component.development.set.param.id") },
      development: { type: "boolean", required: true, description: key("cmd.component.development.set.param.development") },
      path: { type: "string", required: true, description: key("cmd.component.development.set.param.path") },
    },
    windowScoped: false,
    returns: "{ kind, id, development, path, revision }",
    message: (data) => tmsg("msg.component.development.set", { kind, id: String(data.id) }),
    errors: ["INVALID_PARAMS", "TARGET_NOT_FOUND"],
    examples: [
      `${kind}.development.set id=demo development=true path=/absolute/path`,
      `${kind}.development.set '{"id":"demo","development":true,"path":"/absolute/path"}'`,
    ],
    danger: "inject",
    handler: async (params) => {
      const current = await settings();
      const id = params.id as string;
      const development = params.development as boolean;
      const path = params.path as string;
      const change = await invoke<{ revision: number }>(`${kind}_development_set`, {
        id, development, path, expectedRevision: current.revision,
      });
      return { kind, id, development, path, revision: change.revision };
    },
  });
}

export function registerDevelopmentCatalog(): void {
  registerKind("plugin");
  registerKind("sidecar");
  registerKind("kit");
}
