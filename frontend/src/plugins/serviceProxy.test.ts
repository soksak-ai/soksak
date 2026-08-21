// Service proxy contract tests — registry registration (PS3), envelope pass-through (PS7), and
// ledger derivation (PS9) from manifest data alone. Verified through the real commands/registry
// (no mock registry).
import { afterEach, describe, expect, it, vi } from "vitest";
import { execute, register, unregister } from "../commands/registry";
import { parseManifest, SERVICE_CONTRACT_VERSION, type PluginManifest } from "./spec";
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
      name: "Demo",
      version: "0.0.1",
      description: "Test fixture",
      entry: null,
      permissions: ["commands", "sidecar", "service"],
      sidecars: [{ name: "demo-svc", interface: { id: "soksak-spec-sidecar-fixture-wire", version: "0.0.1" } }],
      service: {
        sidecar: "demo-svc",
        interface: { id: "vault", version: SERVICE_CONTRACT_VERSION },
        subscribe: ["bus:kanban:changed"],
      },
      contributes: {
        commands: [
          {
            name: "run",
            title: { en: "Run", ko: "Run (ko)" },
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
  if (!manifest) throw new Error("the fixture manifest did not parse");
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

describe("registerServiceProxies — registration synthesized from manifest data (PS3, PS7, PS11)", () => {
  it("a registered proxy forwards to service_dispatch and passes the envelope message and hints through unchanged", async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      code: "OK",
      message: "service sentence",
      hints: [{ cmd: "plugin.demo.run", why: "run it again" }],
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
    expect(out.message).toBe("service sentence");
    // Service (plugin) hints are built shape-only too; the app CLI name is prefixed at one central point.
    expect(out.hint).toEqual([{ cmd: "sok plugin.demo.run", why: "run it again" }]);
    expect(out.data).toEqual({ n: 1 });
  });

  it("the manifest declaration drives params validation — a missing required param is INVALID_PARAMS and never reaches dispatch", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    cleanup = registerServiceProxies(demoManifest(), deps(invoke));
    const out = await execute("plugin.demo.run", {}, {});
    expect(out.ok).toBe(false);
    expect(out.code).toBe("INVALID_PARAMS");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("a wire response with no message degrades to the title label (MESSAGE-PROTOCOL §3)", async () => {
    const invoke = vi.fn(async () => ({ ok: true, code: "OK", data: { n: 2 } }));
    cleanup = registerServiceProxies(demoManifest(), deps(invoke));
    const out = await execute("plugin.demo.run", { doc: "a" }, {});
    expect(out.message).toBe("Run (ko)");
  });

  it("the dispose function removes every registration (proxy lifetime = activation lifetime)", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    // One registration left behind — an empty registry after unregistering everything is a different
    // fact from "unknown name" and answers with a different code. What this test measures is that the
    // proxy name is gone.
    register("proxy.fixture.present", {
      description: "fixture",
      params: {},
      returns: "void",
      message: () => "ok",
      handler: () => ({}),
    });
    const dispose = registerServiceProxies(demoManifest(), deps(invoke));
    dispose();
    const out = await execute("plugin.demo.run", { doc: "a" }, {});
    unregister("proxy.fixture.present");
    expect(out.code).toBe("UNKNOWN_COMMAND");
  });
});

describe("buildBindLedger — ledger derivation (PS9, PS14)", () => {
  it("only a manifest that declares a service enters the ledger, in a deterministic order, as the resolved subset", () => {
    const m = demoManifest();
    const ledger = buildBindLedger([m]);
    expect(ledger).toEqual({
      version: 1,
      services: [
        {
          plugin: "demo",
          sidecar: "demo-svc",
          interface: { id: "vault", version: SERVICE_CONTRACT_VERSION },
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

  it('declaring the "secrets" permission derives vaultEnv (PS9 — env: the vault injection target)', () => {
    const { manifest, validation } = parseManifest(
      {
        spec: "soksak-spec-plugin@0.0.1",
        id: "vaulted",
        name: "Vaulted",
        version: "1.0.0",
        description: "Test fixture",
        entry: null,
        permissions: ["commands", "sidecar", "service", "secrets"],
        sidecars: [{ name: "vaulted-svc", interface: { id: "soksak-spec-sidecar-fixture-wire", version: "0.0.1" } }],
        service: { sidecar: "vaulted-svc", interface: { id: "vault", version: SERVICE_CONTRACT_VERSION }, subscribe: [] },
        contributes: {
          commands: [
            { name: "run", title: { en: "Run", ko: "Run (ko)" }, bind: "service", description: "Run." },
          ],
        },
      },
      "vaulted",
    );
    expect(validation.errors).toEqual([]);
    if (!manifest) throw new Error("the fixture did not parse");
    const ledger = buildBindLedger([manifest]);
    expect(ledger.services[0].vaultEnv).toBe(true);
  });

  it("a manifest with no service does not enter the ledger", () => {
    const { manifest } = parseManifest(
      {
        spec: "soksak-spec-plugin@0.0.1",
        id: "plain",
        name: "Plain",
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

  it("the service ledger sends only the exact consumer contract reference", async () => {
    const invoke = vi.fn<ServiceProxyDeps["invoke"]>(async () => undefined);
    await syncServiceLedger([demoManifest()], invoke);
    expect(invoke).toHaveBeenCalledTimes(1);
    const [command, args] = invoke.mock.calls[0];
    expect(command).toBe("service_ledger_sync");
    expect(args).toEqual({
      ledger: expect.objectContaining({
        services: [
          expect.objectContaining({
            interface: { id: "vault", version: SERVICE_CONTRACT_VERSION },
          }),
        ],
      }),
    });
    expect(JSON.stringify(args)).not.toContain("soksak-spec-service@0.0.1");
  });
});

describe("registerBusBridge — window bus to core bridge (PS15)", () => {
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

  it("a publish on a subscribed topic (bus: prefix removed) goes up as service_bus_push", () => {
    const h = harness();
    const off = registerBusBridge(demoManifest(), { invoke: h.invoke, busOn: h.busOn });
    // The service subscribes to "bus:kanban:changed" → the real topic on the bus axis is "kanban:changed".
    h.emit("kanban:changed", { n: 1 });
    expect(h.calls).toEqual([
      { cmd: "service_bus_push", topic: "bus:kanban:changed", payload: { n: 1 } },
    ]);
    off();
    h.emit("kanban:changed", { n: 2 });
    expect(h.calls.length).toBe(1); // no delivery after unsubscribe
  });

  it("payload.dedupKey is passed as the dedupKey argument (the key for cross-window dedup)", () => {
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

  it("a manifest with no service registers no listener", () => {
    const h = harness();
    const { manifest } = parseManifest(
      {
        spec: "soksak-spec-plugin@0.0.1",
        id: "plain",
        name: "Plain",
        version: "1.0.0",
        description: "no service",
        permissions: [],
      },
      "plain",
    );
    if (!manifest) throw new Error("the manifest did not parse");
    registerBusBridge(manifest, { invoke: h.invoke, busOn: h.busOn });
    expect(h.listeners.size).toBe(0);
  });
});
