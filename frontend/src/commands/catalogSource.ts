import { invoke } from "../framework";
import { key, tmsg } from "../i18n";
import { register } from "./registry";

type ComponentKind = "plugin" | "sidecar" | "kit" | "contract" | "spec";
type ComponentRecord = {
  version: string;
  path: string;
  source: "registry" | "development";
  registry?: string;
  target?: string;
};
type Environment = {
  revision: number;
  plugins: Record<string, ComponentRecord>;
  sidecars: Record<string, ComponentRecord>;
  kits: Record<string, ComponentRecord>;
  contracts: Record<string, ComponentRecord>;
  specs: Record<string, ComponentRecord>;
};

const CONFIG = {
  plugin: "plugins",
  sidecar: "sidecars",
  kit: "kits",
  contract: "contracts",
  spec: "specs",
} as const satisfies Record<ComponentKind, keyof Omit<Environment, "revision">>;

async function environment(): Promise<Environment> {
  return invoke<Environment>("environment_get");
}

function registerKind(kind: ComponentKind): void {
  const collection = CONFIG[kind];
  register(`${kind}.source.list`, {
    description: key("cmd.component.source.list.desc", { kind }),
    params: {},
    windowScoped: false,
    returns: `{ revision, ${collection}: Record<id,{version,path,source,registry?,target?}> }`,
    message: (data) => tmsg("msg.component.source.list", { kind, n: Object.keys(data[collection] as object).length }),
    examples: [`${kind}.source.list`],
    handler: async () => {
      const current = await environment();
      return { revision: current.revision, [collection]: current[collection] };
    },
  });

  register(`${kind}.source.set`, {
    description: key("cmd.component.source.set.desc", { kind }),
    params: {
      id: { type: "string", required: true, description: key("cmd.component.source.set.param.id") },
      version: { type: "string", required: true, description: key("cmd.component.source.set.param.version") },
      source: { type: "string", required: true, description: key("cmd.component.source.set.param.source") },
      path: { type: "string", required: true, description: key("cmd.component.source.set.param.path") },
      registry: { type: "string", required: false, description: key("cmd.component.source.set.param.registry") },
      target: { type: "string", required: false, description: key("cmd.component.source.set.param.target") },
    },
    windowScoped: false,
    returns: "{ kind, id, version, source, path, registry?, target?, revision }",
    message: (data) => tmsg("msg.component.source.set", { kind, id: String(data.id) }),
    errors: ["INVALID_PARAMS", "TARGET_NOT_FOUND"],
    examples: [
      `${kind}.source.set id=demo version=0.0.1 source=development path=/absolute/path`,
      `${kind}.source.set '{"id":"demo","version":"0.0.1","source":"development","path":"/absolute/path"}'`,
    ],
    danger: "inject",
    handler: async (params) => {
      const current = await environment();
      const id = params.id as string;
      const version = params.version as string;
      const source = params.source as string;
      const path = params.path as string;
      const registry = params.registry as string | undefined;
      const target = params.target as string | undefined;
      const change = await invoke<{ revision: number }>(`${kind}_source_set`, {
        id, version, source, path, registry, target, expectedRevision: current.revision,
      });
      return { kind, id, version, source, path, registry, target, revision: change.revision };
    },
  });
}

export function registerSourceCatalog(): void {
  registerKind("plugin");
  registerKind("sidecar");
  registerKind("kit");
  registerKind("contract");
  registerKind("spec");
}
