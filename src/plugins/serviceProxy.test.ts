// 서비스 프록시 계약 테스트 — 매니페스트 데이터만으로 레지스트리 등록(PS3)·봉투 통과(PS7)·
// 원장 파생(PS9). 실제 commands/registry 를 통과시켜 검증한다(모조 레지스트리 금지).
import { afterEach, describe, expect, it, vi } from "vitest";
import { execute, register, unregister } from "../commands/registry";
import { parseManifest, SERVICE_INTERFACE, type PluginManifest } from "./spec";
import {
  buildBindLedger,
  registerServiceProxies,
  type ServiceProxyDeps,
} from "./serviceProxy";

function demoManifest(): PluginManifest {
  const { manifest, validation } = parseManifest(
    {
      spec: "soksak-plugin-spec@1",
      id: "demo",
      name: "데모",
      version: "1.0.0",
      description: "테스트",
      entry: null,
      permissions: ["commands", "sidecar", "service"],
      sidecars: [{ name: "demo-svc", interface: "soksak-fixture-wire-spec@1" }],
      service: {
        sidecar: "demo-svc",
        interface: SERVICE_INTERFACE,
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
          interface: SERVICE_INTERFACE,
          ops: ["run"],
          subscribe: ["bus:kanban:changed"],
          schedules: [
            { name: "reconcile", command: "run", trigger: { reconcile: true }, timeoutMs: 1000 },
          ],
          secrets: [],
        },
      ],
    });
  });

  it("service 없는 매니페스트는 원장에 오르지 않는다", () => {
    const { manifest } = parseManifest(
      {
        spec: "soksak-plugin-spec@1",
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
});
