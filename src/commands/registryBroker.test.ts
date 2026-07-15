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
    windowLabel: "w-trusted",
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
  it("broker 선언이 없는 기존 명령은 플러그인에 열리지 않고 UI/CLI 실행은 그대로다", async () => {
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

  it("직접 만든 principal/context는 인증된 컨텍스트를 흉내낼 수 없다", async () => {
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

  it("플러그인이 authority 파라미터를 직접 고르면 거부하고, 생략하면 호스트 값만 주입한다", async () => {
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

    expect(await executeFromPlugin("broker.authority", { window: "w-forged" }, pluginContext())).toMatchObject({
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
        window: "w-trusted",
        namespace: "plugin/soksak-plugin-fixture",
        path: "/trusted/workspace",
        label: "g-trusted",
        coordinates: { x: 10, y: 20, width: 300, height: 180 },
      },
    });
    expect(observed).toHaveLength(1);
  });

  it("명령이 요구한 모든 권한을 인증된 grant가 가져야 한다", async () => {
    reg("broker.permission", {
      broker: basicBroker({ permissions: ["commands", "network"] }),
    });

    expect(await executeFromPlugin(
      "broker.permission",
      {},
      pluginContext({ permissions: ["commands"] }),
    )).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
  });

  it("명령의 required/provided 계약을 caller의 provided/required 계약과 양방향 대조한다", async () => {
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

  it("핸들러 성공값을 정규화한 뒤 result machine schema가 다르면 성공으로 내보내지 않는다", async () => {
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

  it("발급 시 principal/grants/authority를 복제·동결해 이후 입력 변조가 권한을 바꾸지 못한다", () => {
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

  it("catalog/status는 호출 가능 여부와 선언만 노출하고 실제 principal/authority 값은 노출하지 않는다", () => {
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

  it("등록 뒤 getSpec/원본 참조를 변조해 broker를 열거나 검증된 파라미터 계약을 바꿀 수 없다", () => {
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
