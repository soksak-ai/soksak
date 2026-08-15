import { afterEach, describe, expect, it } from "vitest";
import {
  brokerStatus,
  catalogJson,
  execute,
  executeFromPlugin,
  getSpec,
  issuePluginCommandContext,
  register,
  unregister,
  type CommandBrokerSpec,
  type CommandContext,
  type CommandMachineSchema,
  type CommandMachineObjectSchema,
  type CommandSpec,
  type PluginCommandContext,
} from "./registry";

const registered: string[] = [];
const CALLER_CONTRACT = "soksak-spec-service-caller-fixture";
const HOST_CONTRACT = "soksak-spec-service-host-fixture";

const EMPTY_RESULT: CommandMachineObjectSchema = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};

const JSON_VALUE_SCHEMA: CommandMachineSchema = { type: "json" };

function jsonResultSchema(schema: CommandMachineSchema = JSON_VALUE_SCHEMA): CommandMachineObjectSchema {
  return {
    type: "object",
    properties: { value: schema },
    required: ["value"],
    additionalProperties: false,
  };
}

async function executeJsonFixture(name: string, value: unknown) {
  reg(name, {
    broker: basicBroker({ result: jsonResultSchema() }),
    handler: () => ({ value }),
  });
  return await executeFromPlugin(name, {}, pluginContext());
}

function basicBroker(overrides: Partial<CommandBrokerSpec> = {}): CommandBrokerSpec {
  return {
    permissions: ["commands"],
    contracts: { requires: [], provides: [] },
    authority: [],
    result: EMPTY_RESULT,
    ...overrides,
  };
}

function reg(name: string, overrides: Partial<CommandSpec> = {}): void {
  register(name, {
    description: "broker fixture",
    params: {},
    returns: "{}",
    message: () => "ok",
    handler: () => ({}),
    ...overrides,
  });
  registered.push(name);
}

function principal() {
  return {
    runtimeId: "runtime-1",
    sessionId: "session-1",
    windowLabel: "win-trusted",
    pluginId: "soksak-plugin-fixture",
    generation: 7,
    role: "view" as const,
    contributionId: "canvas",
    instanceId: "view-1",
    domHandleId: "dom-1",
  };
}

function pluginContext(overrides: {
  permissions?: readonly ("commands" | "network")[];
  requiredContracts?: readonly { id: string; range: string }[];
  providedContracts?: readonly { id: string; version: string }[];
} = {}): PluginCommandContext {
  return issuePluginCommandContext({
    principal: principal(),
    grants: {
      permissions: overrides.permissions ?? ["commands", "network"],
      requiredContracts: overrides.requiredContracts ?? [{ id: HOST_CONTRACT, range: "=0.0.1" }],
      providedContracts: overrides.providedContracts ?? [{ id: CALLER_CONTRACT, version: "0.0.1" }],
    },
    authority: {
      namespace: "plugin/soksak-plugin-fixture",
      paths: { workspace: "/trusted/workspace" },
      labels: { panel: "g-trusted" },
      coordinates: { placement: { x: 10, y: 20, width: 300, height: 180 } },
    },
  });
}

afterEach(() => {
  for (const name of registered.splice(0)) unregister(name);
});

describe("Command Registry plugin broker — fail closed", () => {
  it("an existing command with no broker declaration stays closed to plugins, and UI/CLI execution is unchanged", async () => {
    reg("broker.legacy", { handler: () => ({ value: "host-only" }) });

    expect(await execute("broker.legacy", {}, {})).toMatchObject({
      ok: true,
      data: { value: "host-only" },
    });
    expect(await executeFromPlugin("broker.legacy", {}, pluginContext())).toMatchObject({
      ok: false,
      code: "PLUGIN_CALL_FORBIDDEN",
    });
  });

  it("a hand-built principal/context cannot imitate an authenticated context", async () => {
    reg("broker.auth", { broker: basicBroker() });
    const forged = {
      remote: true,
      plugin: {
        principal: principal(),
        grants: { permissions: ["commands"], requiredContracts: [], providedContracts: [] },
        authority: { namespace: "forged", paths: {}, labels: {}, coordinates: {} },
      },
    } as unknown as PluginCommandContext;

    expect(await executeFromPlugin("broker.auth", {}, forged)).toMatchObject({
      ok: false,
      code: "PLUGIN_AUTH_REQUIRED",
    });
    expect(await execute("broker.auth", {}, forged as CommandContext)).toMatchObject({
      ok: false,
      code: "PLUGIN_ENTRYPOINT_REQUIRED",
    });
  });

  it("refuses a plugin that picks the authority parameter itself, and injects only the host value when it is omitted", async () => {
    const observed: Record<string, unknown>[] = [];
    const result: CommandMachineObjectSchema = {
      type: "object",
      properties: {
        plugin: { type: "string" },
        contribution: { type: "string" },
        window: { type: "string" },
        namespace: { type: "string" },
        path: { type: "string" },
        label: { type: "string" },
        coordinates: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            width: { type: "number" },
            height: { type: "number" },
          },
          required: ["x", "y", "width", "height"],
          additionalProperties: false,
        },
      },
      required: ["plugin", "contribution", "window", "namespace", "path", "label", "coordinates"],
      additionalProperties: false,
    };
    reg("broker.authority", {
      params: {
        plugin: { type: "string", description: "" },
        contribution: { type: "string", description: "" },
        window: { type: "string", description: "" },
        namespace: { type: "string", description: "" },
        path: { type: "string", description: "" },
        label: { type: "string", description: "" },
        coordinates: { type: "json", description: "" },
      },
      broker: basicBroker({
        result,
        authority: [
          { param: "plugin", source: { kind: "plugin-id" } },
          { param: "contribution", source: { kind: "contribution-id" } },
          { param: "window", source: { kind: "window-label" } },
          { param: "namespace", source: { kind: "namespace" } },
          { param: "path", source: { kind: "path", key: "workspace" } },
          { param: "label", source: { kind: "label", key: "panel" } },
          { param: "coordinates", source: { kind: "coordinates", key: "placement" } },
        ],
      }),
      handler: (params) => {
        observed.push(params);
        return params;
      },
    });

    expect(await executeFromPlugin("broker.authority", { window: "win-forged" }, pluginContext())).toMatchObject({
      ok: false,
      code: "PLUGIN_AUTHORITY_FORBIDDEN",
    });
    expect(observed).toHaveLength(0);

    const valid = await executeFromPlugin("broker.authority", {}, pluginContext());
    expect(valid).toMatchObject({
      ok: true,
      data: {
        plugin: "soksak-plugin-fixture",
        contribution: "canvas",
        window: "win-trusted",
        namespace: "plugin/soksak-plugin-fixture",
        path: "/trusted/workspace",
        label: "g-trusted",
        coordinates: { x: 10, y: 20, width: 300, height: 180 },
      },
    });
    expect(observed).toHaveLength(1);
  });

  it("requires the authenticated grant to hold every permission the command declared", async () => {
    reg("broker.permission", {
      broker: basicBroker({ permissions: ["commands", "network"] }),
    });

    expect(await executeFromPlugin(
      "broker.permission",
      {},
      pluginContext({ permissions: ["commands"] }),
    )).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
  });

  it("checks the command's required/provided contract against the caller's provided/required contract in both directions", async () => {
    reg("broker.contract", {
      broker: basicBroker({
        contracts: {
          requires: [{ id: CALLER_CONTRACT, range: "=0.0.1" }],
          provides: [{ id: HOST_CONTRACT, version: "0.0.1" }],
        },
      }),
    });

    expect(await executeFromPlugin(
      "broker.contract",
      {},
      pluginContext({ providedContracts: [] }),
    )).toMatchObject({ ok: false, code: "PLUGIN_CONTRACT_DENIED" });
    expect(await executeFromPlugin(
      "broker.contract",
      {},
      pluginContext({ requiredContracts: [] }),
    )).toMatchObject({ ok: false, code: "PLUGIN_CONTRACT_DENIED" });
    expect(await executeFromPlugin("broker.contract", {}, pluginContext())).toMatchObject({ ok: true });
  });

  it("normalizes a handler success value and does not emit it as success when the result machine schema differs", async () => {
    reg("broker.bad-result", {
      broker: basicBroker({
        result: {
          type: "object",
          properties: { count: { type: "integer" } },
          required: ["count"],
          additionalProperties: false,
        },
      }),
      handler: () => ({ count: "not-an-integer" }),
    });

    expect(await executeFromPlugin("broker.bad-result", {}, pluginContext())).toMatchObject({
      ok: false,
      code: "PLUGIN_RESULT_INVALID",
    });
  });

  it.each([
    ["null", null],
    ["boolean", true],
    ["string", "json text"],
    ["finite number", -12.5],
    ["array", [null, false, "nested", 3.25, { ok: true }]],
    ["plain object", { "": "empty keys are JSON", nested: { list: [1, 2, 3], empty: {} } }],
  ])("json machine schema admits a %s value with its nesting intact", async (label, value) => {
    const outcome = await executeJsonFixture(`broker.json.valid.${label}`, value);
    expect(outcome).toMatchObject({ ok: true, data: { value } });
  });

  it.each([
    ["undefined", undefined],
    ["function", () => "not json"],
    ["symbol", Symbol("not-json")],
    ["bigint", 1n],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("json machine schema fails closed on a %s value", async (label, value) => {
    const outcome = await executeJsonFixture(`broker.json.invalid.${label}`, value);
    expect(outcome).toMatchObject({ ok: false, code: "PLUGIN_RESULT_INVALID" });
  });

  it("json machine schema refuses a cycle and an unsafe prototype", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const inherited = Object.create({ inherited: true }) as Record<string, unknown>;
    inherited.own = "value";
    const inheritedArray: unknown[] = [];
    Object.setPrototypeOf(inheritedArray, { inherited: true });

    for (const [label, value] of [
      ["cycle", cyclic],
      ["date", new Date(0)],
      ["custom-prototype", inherited],
      ["custom-array-prototype", inheritedArray],
    ] as const) {
      const outcome = await executeJsonFixture(`broker.json.unsafe.${label}`, value);
      expect(outcome).toMatchObject({ ok: false, code: "PLUGIN_RESULT_INVALID" });
    }
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "json machine schema refuses the nested unsafe key %s",
    async (key) => {
      const unsafe = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(unsafe, key, {
        value: { nested: true },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      const outcome = await executeJsonFixture(`broker.json.unsafe-key.${key}`, { unsafe });
      expect(outcome).toMatchObject({ ok: false, code: "PLUGIN_RESULT_INVALID" });
    },
  );

  it("a json value keeps the existing 16-level depth cap and 16-violation cap", async () => {
    const nested = (levels: number): unknown => {
      let value: unknown = "leaf";
      for (let index = 0; index < levels; index += 1) value = [value];
      return value;
    };

    expect(await executeJsonFixture("broker.json.depth.allowed", nested(15)))
      .toMatchObject({ ok: true });
    expect(await executeJsonFixture("broker.json.depth.rejected", nested(16)))
      .toMatchObject({ ok: false, code: "PLUGIN_RESULT_INVALID" });

    const capped = await executeJsonFixture(
      "broker.json.error-cap",
      Array.from({ length: 40 }, () => undefined),
    );
    expect(capped).toMatchObject({ ok: false, code: "PLUGIN_RESULT_INVALID" });
    expect((capped.data?.violations as unknown[])).toHaveLength(16);
  });

  it("a json schema definition admits no keyword other than type", () => {
    expect(() => reg("broker.json.bad-definition", {
      broker: basicBroker({
        result: jsonResultSchema({ type: "json", maxLength: 3 } as unknown as CommandMachineSchema),
      }),
    })).toThrow(/unknown schema keyword/);
  });

  it("copies and freezes principal/grants/authority at issue, so later input tampering cannot change a permission", () => {
    const source = {
      principal: principal(),
      grants: {
        permissions: ["commands"] as ("commands" | "network")[],
        requiredContracts: [{ id: HOST_CONTRACT, range: "=0.0.1" }],
        providedContracts: [{ id: CALLER_CONTRACT, version: "0.0.1" }],
      },
      authority: {
        namespace: "trusted",
        paths: { workspace: "/trusted" },
        labels: { panel: "g1" },
        coordinates: { placement: { x: 1 } },
      },
    };
    const ctx = issuePluginCommandContext(source);
    source.principal.pluginId = "soksak-plugin-forged";
    source.grants.permissions.push("network");
    source.authority.paths.workspace = "/forged";

    expect(ctx.plugin.principal.pluginId).toBe("soksak-plugin-fixture");
    expect(ctx.plugin.grants.permissions).toEqual(["commands"]);
    expect(ctx.plugin.authority.paths.workspace).toBe("/trusted");
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.plugin)).toBe(true);
    expect(Object.isFrozen(ctx.plugin.grants.permissions)).toBe(true);
  });

  it("catalog/status exposes callability and declarations only, never the actual principal/authority values", () => {
    reg("broker.public", {
      broker: basicBroker({
        permissions: ["commands", "network"],
        authority: [{ param: "path", source: { kind: "path", key: "workspace" } }],
      }),
      params: { path: { type: "string", description: "" } },
    });
    reg("broker.private", {});

    const publicEntry = catalogJson().find((entry) => entry.name === "broker.public");
    const privateEntry = catalogJson().find((entry) => entry.name === "broker.private");
    expect(publicEntry).toMatchObject({ pluginCallable: true, broker: { permissions: ["commands", "network"] } });
    expect(privateEntry).toMatchObject({ pluginCallable: false });
    expect(brokerStatus("broker.public")).toMatchObject({ registered: true, pluginCallable: true });
    expect(brokerStatus("broker.private")).toEqual({ registered: true, pluginCallable: false });
    expect(brokerStatus("broker.missing")).toEqual({ registered: false, pluginCallable: false });

    const serialized = JSON.stringify({ publicEntry, status: brokerStatus("broker.public") });
    expect(serialized).not.toContain("/trusted/workspace");
    expect(serialized).not.toContain("soksak-plugin-fixture");
  });

  it("tampering with getSpec or the original reference after registration cannot open the broker or change the verified parameter contract", () => {
    const params = { path: { type: "string" as const, description: "" } };
    reg("broker.immutable", {
      params,
      broker: basicBroker({
        authority: [{ param: "path", source: { kind: "path", key: "workspace" } }],
      }),
    });
    reg("broker.closed-immutable", {});

    const openSpec = getSpec("broker.immutable")!;
    const closedSpec = getSpec("broker.closed-immutable")!;
    expect(Object.isFrozen(openSpec)).toBe(true);
    expect(Object.isFrozen(openSpec.params)).toBe(true);
    expect(Object.isFrozen(closedSpec)).toBe(true);
    expect(() => { (openSpec as { broker?: unknown }).broker = undefined; }).toThrow();
    expect(() => { (closedSpec as { broker?: unknown }).broker = basicBroker(); }).toThrow();

    params.path.type = "number" as unknown as "string";
    expect(getSpec("broker.immutable")!.params.path.type).toBe("string");
    expect(brokerStatus("broker.closed-immutable")).toEqual({ registered: true, pluginCallable: false });
  });
});
