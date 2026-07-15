import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseManifest, type PluginManifest } from "./spec";

const harness = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
    harness.listeners.set(name, callback);
    return () => harness.listeners.delete(name);
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => harness.invoke(...args),
}));

import { startNativePluginRuntime } from "./nativeRuntime";

const principal = {
  runtimeId: "runtime.fixture.1",
  sessionId: "session.fixture.1",
  windowLabel: "main",
  pluginId: "fixture",
  generation: 1,
  role: "controller" as const,
  contributionId: "controller",
  instanceId: "controller.1",
  domHandleId: null,
};

function manifest(): PluginManifest {
  const parsed = parseManifest({
    spec: "soksak-spec-plugin@0.0.1",
    id: "fixture",
    name: "Fixture",
    version: "0.0.1",
    description: "Native runtime fixture",
    permissions: [],
  }, "fixture");
  if (!parsed.manifest) throw new Error(parsed.validation.errors.join("; "));
  return parsed.manifest;
}

function bootstrap() {
  return {
    spec: "soksak-spec-plugin-runtime@0.0.1",
    kind: "request",
    seq: 1,
    requestId: "bootstrap.1",
    method: "runtime.bootstrap",
    params: {
      principal,
      appVersion: "0.0.1",
      capabilities: [],
      hostCommands: [],
      events: [],
      context: {
        revision: 1,
        theme: { colorMode: "system", tokens: {} },
        locale: "en",
        slot: null,
        visible: false,
        interactive: false,
        instance: null,
      },
      bootstrapArtifactSha256: "a".repeat(64),
    },
  };
}

beforeEach(() => {
  harness.invoke.mockReset();
  harness.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "plugin_runtime_start") {
      return {
        principal,
        permissions: [],
        requiredContracts: [],
        providedContracts: [],
        hostCommands: [],
        eventTopics: [],
        bootstrapEnvelope: bootstrap(),
        artifact: {
          spec: "soksak-spec-plugin-runtime@0.0.1",
          document: "about:srcdoc",
          sandboxTokens: ["allow-scripts"],
          csp: "fixture",
          html: { sha256: "a".repeat(64), bytes: 1 },
          module: { sha256: "b".repeat(64), bytes: 1 },
          transferredPorts: 1,
          ambientPostMessage: "deny",
          intrinsicsCapturedBeforePluginImport: true,
          pluginImportRealm: "opaque-child-frame-only",
        },
        entrySha256: "c".repeat(64),
        sessionBindingSha256: "d".repeat(64),
        runtimePolicy: { navigationOrigins: [], iframeOrigins: [], webRtc: false },
      };
    }
    if (command === "plugin_runtime_send") {
      const envelope = args?.envelope as { method?: string };
      if (envelope.method === "runtime.bootstrap") {
        queueMicrotask(() => harness.listeners.get("plugin-runtime-envelope")?.({
          payload: {
            runtimeId: principal.runtimeId,
            pluginId: principal.pluginId,
            generation: principal.generation,
            envelope: {
              spec: "soksak-spec-plugin-runtime@0.0.1",
              kind: "signal",
              seq: 1,
              requestId: "lifecycle.ready.1",
              method: "lifecycle.ready",
              params: { inventory: { commands: [], views: [], fileViewers: [], overlays: [] } },
            },
          },
        }));
      }
      return undefined;
    }
    if (command === "plugin_runtime_stop") return true;
    throw new Error(`unexpected invoke: ${command}`);
  });
});

describe("native runtime renderer bridge", () => {
  it("starts by unit identity and never sends entry bytes or a renderer-selected path", async () => {
    const active = await startNativePluginRuntime(manifest(), "/untrusted/renderer/path");
    expect(active.principal).toEqual(principal);
    expect(active.entrySha256).toBe("c".repeat(64));

    const startCall = harness.invoke.mock.calls.find(([name]) => name === "plugin_runtime_start");
    expect(startCall?.[1]).toEqual({ id: "fixture", hostCommands: [], eventTopics: [] });
    expect(JSON.stringify(startCall?.[1])).not.toMatch(/entry|content|code|path|manifest/i);

    await active.deactivate();
    expect(harness.invoke).toHaveBeenCalledWith("plugin_runtime_stop", { id: "fixture" });
  });
});
