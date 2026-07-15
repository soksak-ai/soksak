// 서비스 프록시 계약 테스트 — 매니페스트 데이터만으로 레지스트리 등록(PS3)·봉투 통과(PS7)·
// 원장 파생(PS9). 실제 commands/registry 를 통과시켜 검증한다(모조 레지스트리 금지).
import { afterEach, describe, expect, it, vi } from "vitest";
import { execute, register, unregister } from "../commands/registry";
import { parseManifest, SERVICE_CONTRACT_REQUIREMENT, type PluginManifest } from "./spec";
import {
  buildBindLedger,
  registerBusBridge,
  registerServiceProxies,
  syncServiceLedger,
  type ServiceProxyDeps,
} from "./serviceProxy";

function demoManifest(): PluginManifest {
  const { manifest, validation } = parseManifest(
    {
      spec: "soksak-spec-plugin@0.0.1",
      id: "demo",
      name: "데모",
      version: "0.0.1",
      description: "테스트",
      entry: null,
      permissions: ["commands", "sidecar", "service"],
      sidecars: [{ name: "demo-svc", interface: { id: "soksak-spec-sidecar-fixture-wire", range: ">=0.0.1 <1.0.0" } }],
      service: {
        sidecar: "demo-svc",
        interface: SERVICE_CONTRACT_REQUIREMENT,
        subscribe: ["bus:kanban:changed"],
      },
      contributes: {
        commands: [
          {
            name: "run",
            title: { en: "Run", ko: "실행" },
            bind: "service",
            description: "Run a demo.",
            params: { doc: { type: "string", description: "doc path", required: true } },
          },
        ],
        schedules: [
          { name: "reconcile", command: "run", trigger: { reconcile: true }, timeoutMs: 1000 },
        ],
      },
    },
    "demo",
  );
  expect(validation.errors).toEqual([]);
  if (!manifest) throw new Error("픽스처 매니페스트 파싱 실패");
  return manifest;
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function deps(invoke: ServiceProxyDeps["invoke"]): ServiceProxyDeps {
  return { invoke, registerCommand: register, unregisterCommand: unregister, locale: () => "ko" };
}

describe("registerServiceProxies — 매니페스트 데이터 합성 등록(PS3·PS7·PS11)", () => {
  it("등록된 프록시는 service_dispatch 로 포워딩하고 봉투 message·hints 를 1급으로 나른다", async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      code: "OK",
      message: "서비스가 지은 문장",
      hints: [{ cmd: "plugin.demo.run", why: "재실행" }],
      data: { n: 1 },
    }));
    const marked: string[] = [];
    cleanup = registerServiceProxies(demoManifest(), deps(invoke), (b) => marked.push(b));
    expect(marked).toEqual(["run"]);
    const out = await execute("plugin.demo.run", { doc: "a.json" }, {});
    expect(invoke).toHaveBeenCalledWith("service_dispatch", {
      method: "plugin.demo.run",
      params: { doc: "a.json" },
      parent: undefined,
      origin: undefined,
    });
    expect(out.ok).toBe(true);
    expect(out.message).toBe("서비스가 지은 문장");
    expect(out.hint).toEqual([{ cmd: "plugin.demo.run", why: "재실행" }]);
    expect(out.data).toEqual({ n: 1 });
  });

  it("params 검증은 매니페스트 선언이 구동한다 — 필수 누락 = INVALID_PARAMS(디스패치 미도달)", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    cleanup = registerServiceProxies(demoManifest(), deps(invoke));
    const out = await execute("plugin.demo.run", {}, {});
    expect(out.ok).toBe(false);
    expect(out.code).toBe("INVALID_PARAMS");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("와이어 message 부재는 title 라벨로 열화한다(MESSAGE-PROTOCOL §3)", async () => {
    const invoke = vi.fn(async () => ({ ok: true, code: "OK", data: { n: 2 } }));
    cleanup = registerServiceProxies(demoManifest(), deps(invoke));
    const out = await execute("plugin.demo.run", { doc: "a" }, {});
    expect(out.message).toBe("실행");
  });

  it("해제 함수는 등록을 전부 걷는다(프록시 수명 = 활성 수명)", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const dispose = registerServiceProxies(demoManifest(), deps(invoke));
    dispose();
    const out = await execute("plugin.demo.run", { doc: "a" }, {});
    expect(out.code).toBe("UNKNOWN_COMMAND");
  });
});

describe("buildBindLedger — 원장 파생(PS9·PS14)", () => {
  it("service 선언 매니페스트만, 결정적 순서로, 판정된 부분집합을 나른다", () => {
    const m = demoManifest();
    const ledger = buildBindLedger([m]);
    expect(ledger).toEqual({
      version: 1,
      services: [
        {
          plugin: "demo",
          sidecar: "demo-svc",
          interface: SERVICE_CONTRACT_REQUIREMENT,
          ops: ["run"],
          subscribe: ["bus:kanban:changed"],
          schedules: [
            { name: "reconcile", command: "run", trigger: { reconcile: true }, timeoutMs: 1000 },
          ],
          secrets: [],
          vaultEnv: false,
          dependencies: [],
        },
      ],
    });
  });

  it('"secrets" 권한을 선언하면 vaultEnv 가 파생된다(PS9 — env: 볼트 주입 대상)', () => {
    const { manifest, validation } = parseManifest(
      {
        spec: "soksak-spec-plugin@0.0.1",
        id: "vaulted",
        name: "볼트",
        version: "1.0.0",
        description: "테스트",
        entry: null,
        permissions: ["commands", "sidecar", "service", "secrets"],
        sidecars: [{ name: "vaulted-svc", interface: { id: "soksak-spec-sidecar-fixture-wire", range: ">=0.0.1 <1.0.0" } }],
        service: { sidecar: "vaulted-svc", interface: SERVICE_CONTRACT_REQUIREMENT, subscribe: [] },
        contributes: {
          commands: [
            { name: "run", title: { en: "Run", ko: "실행" }, bind: "service", description: "Run." },
          ],
        },
      },
      "vaulted",
    );
    expect(validation.errors).toEqual([]);
    if (!manifest) throw new Error("픽스처 파싱 실패");
    const ledger = buildBindLedger([manifest]);
    expect(ledger.services[0].vaultEnv).toBe(true);
  });

  it("service 없는 매니페스트는 원장에 오르지 않는다", () => {
    const { manifest } = parseManifest(
      {
        spec: "soksak-spec-plugin@0.0.1",
        id: "plain",
        name: "일반",
        version: "1.0.0",
        description: "no service",
        permissions: [],
      },
      "plain",
    );
    expect(manifest).not.toBeNull();
    if (!manifest) return;
    expect(buildBindLedger([manifest]).services).toEqual([]);
  });

  it("Tauri 원장 경계는 consumer {id,range} 객체만 전송한다", async () => {
    const invoke = vi.fn<ServiceProxyDeps["invoke"]>(async () => undefined);
    await syncServiceLedger([demoManifest()], invoke);
    expect(invoke).toHaveBeenCalledTimes(1);
    const [command, args] = invoke.mock.calls[0];
    expect(command).toBe("service_ledger_sync");
    expect(args).toEqual({
      ledger: expect.objectContaining({
        services: [
          expect.objectContaining({
            interface: SERVICE_CONTRACT_REQUIREMENT,
          }),
        ],
      }),
    });
    expect(JSON.stringify(args)).not.toContain("soksak-spec-service@0.0.1");
  });
});

describe("registerBusBridge — 창 bus → 코어 브리지(PS15)", () => {
  type BusFn = (payload: unknown) => void;

  function harness() {
    const listeners = new Map<string, Set<BusFn>>();
    const calls: Array<Record<string, unknown>> = [];
    const busOn = (topic: string, fn: BusFn): (() => void) => {
      const set = listeners.get(topic) ?? new Set<BusFn>();
      set.add(fn);
      listeners.set(topic, set);
      return () => set.delete(fn);
    };
    const emit = (topic: string, payload: unknown) => {
      for (const fn of listeners.get(topic) ?? []) fn(payload);
    };
    const invoke = async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, ...(args ?? {}) });
      return 1;
    };
    return { busOn, emit, invoke, calls, listeners };
  }

  it("subscribe 토픽(bus: 접두 제거) 발행을 service_bus_push 로 올린다", () => {
    const h = harness();
    const off = registerBusBridge(demoManifest(), { invoke: h.invoke, busOn: h.busOn });
    // 서비스는 "bus:kanban:changed" 구독 → bus 축 실토픽은 "kanban:changed".
    h.emit("kanban:changed", { n: 1 });
    expect(h.calls).toEqual([
      { cmd: "service_bus_push", topic: "bus:kanban:changed", payload: { n: 1 } },
    ]);
    off();
    h.emit("kanban:changed", { n: 2 });
    expect(h.calls.length).toBe(1); // 해제 후 미전달
  });

  it("payload.dedupKey 는 dedupKey 인자로 실린다(창 간 dedup의 키)", () => {
    const h = harness();
    registerBusBridge(demoManifest(), { invoke: h.invoke, busOn: h.busOn });
    h.emit("kanban:changed", { dedupKey: "rev-7", changed: true });
    expect(h.calls[0]).toEqual({
      cmd: "service_bus_push",
      topic: "bus:kanban:changed",
      payload: { dedupKey: "rev-7", changed: true },
      dedupKey: "rev-7",
    });
  });

  it("service 없는 매니페스트는 리스너를 걸지 않는다", () => {
    const h = harness();
    const { manifest } = parseManifest(
      {
        spec: "soksak-spec-plugin@0.0.1",
        id: "plain",
        name: "일반",
        version: "1.0.0",
        description: "no service",
        permissions: [],
      },
      "plain",
    );
    if (!manifest) throw new Error("파싱 실패");
    registerBusBridge(manifest, { invoke: h.invoke, busOn: h.busOn });
    expect(h.listeners.size).toBe(0);
  });
});
