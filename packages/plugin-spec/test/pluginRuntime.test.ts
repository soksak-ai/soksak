import { describe, expect, it } from "vitest";
import {
  PLUGIN_RUNTIME_BOOTSTRAP_CSP,
  PLUGIN_RUNTIME_BOOTSTRAP_SPEC,
  PLUGIN_RUNTIME_CONFORMANCE_SPEC,
  PLUGIN_RUNTIME_FRAME_POLICY,
  PLUGIN_RUNTIME_LIMITS,
  PLUGIN_RUNTIME_METHODS,
  PLUGIN_RUNTIME_REQUIRED_ATTACK_PROBES,
  PLUGIN_RUNTIME_REQUIRED_POSITIVE_PROBES,
  PLUGIN_RUNTIME_WIRE_SPEC,
  PluginRuntimePendingTracker,
  PluginRuntimeSessionValidator,
  authorizePluginRuntimeEnvelope,
  certifyPluginRuntimeBootstrapArtifact,
  certifyPluginRuntimeNativeConformance,
  comparePluginDomDeclarations,
  comparePluginRuntimeInventory,
  isThirdPartyPluginRuntimeEligible,
  parsePluginRuntimeEnvelope,
  type PluginRuntimeBootstrapArtifact,
  type PluginRuntimeDirection,
  type PluginRuntimeEnvelope,
  type PluginRuntimePrincipal,
} from "../src/pluginRuntime.js";
import { parseManifest } from "../src/spec.js";

const sha = (digit: string): string => digit.repeat(64);

const artifact: PluginRuntimeBootstrapArtifact = {
  spec: "soksak-spec-plugin-runtime@0.0.1",
  document: "about:srcdoc",
  sandboxTokens: ["allow-scripts"],
  csp: PLUGIN_RUNTIME_BOOTSTRAP_CSP,
  html: { sha256: sha("a"), bytes: 1_024 },
  module: { sha256: sha("b"), bytes: 4_096 },
  transferredPorts: 1,
  ambientPostMessage: "deny",
  intrinsicsCapturedBeforePluginImport: true,
  pluginImportRealm: "opaque-child-frame-only",
};

const principal: PluginRuntimePrincipal = {
  runtimeId: "runtime.weather.1",
  sessionId: "session.weather.1",
  windowLabel: "main",
  pluginId: "weather",
  generation: 7,
  role: "controller",
  contributionId: "controller",
  instanceId: "controller.1",
  domHandleId: null,
};

const theme = {
  colorMode: "dark" as const,
  tokens: { "--soksak-bg": "#111111", "--soksak-fg": "#eeeeee" },
};

function envelope(
  kind: "request" | "signal",
  method: string,
  params: Record<string, unknown>,
  requestId = `request.${method}.1`,
  seq = 1,
): Record<string, unknown> {
  return { spec: PLUGIN_RUNTIME_WIRE_SPEC, kind, seq, requestId, method, params };
}

function result(
  responseTo: string,
  value: unknown,
  requestId = `request.${responseTo}.1`,
  seq = 2,
): Record<string, unknown> {
  return { spec: PLUGIN_RUNTIME_WIRE_SPEC, kind: "result", seq, requestId, responseTo, value };
}

function bootstrap(
  role: PluginRuntimePrincipal["role"] = "controller",
): Record<string, unknown> {
  const visual = role !== "controller";
  const rolePrincipal = {
    ...principal,
    role,
    contributionId: visual ? "main" : "controller",
    instanceId: `${role}.1`,
    domHandleId: visual ? `dom.${role}.1` : null,
  };
  const context: Record<string, unknown> = {
    revision: 1,
    theme,
    locale: "ko-KR",
    slot: visual ? { width: 900, height: 600, scaleFactor: 2 } : null,
    visible: visual,
    interactive: visual && role !== "preview",
    instance: visual ? { projectId: "project.1", path: "/domain/data.txt" } : null,
  };
  if (role === "overlay") {
    context.scope = "screen";
    context.visible = false;
    context.interactive = false;
  }
  if (role === "preview") {
    context.targetKind = "view";
    context.visible = true;
    context.interactive = false;
    context.previewInput = { title: "bounded fixture", path: "/domain/value" };
  }
  return envelope("request", "runtime.bootstrap", {
    principal: rolePrincipal,
    appVersion: "0.0.1",
    capabilities: role === "preview" ? [] : ["commands"],
    hostCommands: role === "preview" ? [] : ["project.current"],
    events: role === "preview" ? [] : ["project.changed"],
    context,
    bootstrapArtifactSha256: artifact.html.sha256,
  });
}

function parse(raw: unknown): PluginRuntimeEnvelope {
  const parsed = parsePluginRuntimeEnvelope(raw);
  expect(parsed).toMatchObject({ ok: true });
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.value;
}

function authorize(
  raw: unknown,
  direction: PluginRuntimeDirection,
  role = principal.role,
  hostCommands: readonly string[] = ["project.current"],
) {
  return authorizePluginRuntimeEnvelope(parse(raw), {
    direction,
    role,
    hostCommands,
    eventTopics: ["project.changed"],
    principal: { ...principal, role },
  });
}

describe("plugin runtime 0.0.1 closed wire", () => {
  it("parses declared iframe, navigation and WebRTC capabilities without granting them implicitly", () => {
    const base = {
      spec: "soksak-spec-plugin@0.0.1",
      id: "runtime-policy",
      name: "Runtime policy",
      version: "0.0.1",
      description: "Runtime policy fixture",
      permissions: [],
    };
    const declared = parseManifest({
      ...base,
      runtime: {
        navigationOrigins: ["https://docs.example.test"],
        iframeOrigins: ["https://preview.example.test"],
        webRtc: true,
      },
    }, base.id);
    expect(declared.validation.errors).toEqual([]);
    expect(declared.manifest?.runtime).toEqual({
      navigationOrigins: ["https://docs.example.test"],
      iframeOrigins: ["https://preview.example.test"],
      webRtc: true,
    });

    const implicit = parseManifest(base, base.id);
    expect(implicit.manifest?.runtime).toEqual({
      navigationOrigins: [],
      iframeOrigins: [],
      webRtc: false,
    });

    const unsafe = parseManifest({
      ...base,
      runtime: { navigationOrigins: ["http://example.test/path"] },
    }, base.id);
    expect(unsafe.manifest).toBeNull();
    expect(unsafe.validation.errors.join("\n")).toMatch(/runtime\.navigationOrigins/);
  });
  it("uses one 0.0.1 identity without compatibility aliases", () => {
    expect(PLUGIN_RUNTIME_WIRE_SPEC).toBe("soksak-spec-plugin-runtime@0.0.1");
    expect(PLUGIN_RUNTIME_BOOTSTRAP_SPEC).toBe(PLUGIN_RUNTIME_WIRE_SPEC);
    expect(PLUGIN_RUNTIME_CONFORMANCE_SPEC).toBe(PLUGIN_RUNTIME_WIRE_SPEC);
    for (const incompatible of [
      "soksak-spec-plugin-runtime@0.0.2",
      "soksak-spec-plugin-runtime@0.4",
      "soksak-spec-plugin-runtime@1",
    ]) {
      expect(parsePluginRuntimeEnvelope({ ...bootstrap(), spec: incompatible }).ok).toBe(false);
    }
  });
  it("keeps domain functionality in the public Command Registry, not the wire", () => {
    expect(PLUGIN_RUNTIME_METHODS).toEqual([
      "runtime.bootstrap", "runtime.teardown", "lifecycle.ready", "context.update",
      "provider.mount", "provider.update", "provider.unmount",
      "command.execute", "plugin-command.invoke", "plugin-command.result",
      "plugin-command.progress", "plugin-command.cancel",
      "event.subscribe", "event.unsubscribe", "event.deliver",
      "resource.open", "resource.release",
      "stream.open", "stream.chunk", "stream.ack", "stream.close",
      "dom.query", "dom.snapshot", "dom.measure", "dom.input", "dom.revision",
      "runtime.fault",
    ]);
    expect(PLUGIN_RUNTIME_METHODS.some((name) => /^(git|storage|network|fs|pty|webview)\./.test(name))).toBe(false);

    const command = envelope("request", "command.execute", {
      command: "project.current",
      params: {
        url: "https://example.test/domain",
        path: "/domain/value",
        pluginId: "domain-data",
        ns: "domain-namespace",
      },
    });
    expect(authorize(command, "plugin-to-host").ok).toBe(true);
    expect(authorize(command, "plugin-to-host", "controller", []).ok).toBe(false);

    const forged = structuredClone(command);
    (forged.params as Record<string, unknown>).principal = { pluginId: "victim" };
    expect(parsePluginRuntimeEnvelope(forged).ok).toBe(false);
    expect(parsePluginRuntimeEnvelope(envelope("request", "git.status", {})).ok).toBe(false);
  });

  it("uses requestId as the sole correlation id and validates typed outcomes", () => {
    const invoke = envelope("request", "plugin-command.invoke", {
      command: "refresh",
      params: {},
      invocation: { origin: "cli", parent: null },
    });
    expect(authorize(invoke, "host-to-plugin").ok).toBe(true);

    const outcome = envelope("signal", "plugin-command.result", {
      outcome: { ok: true, code: "OK", message: "refreshed", data: { count: 1 } },
    });
    expect(authorize(outcome, "plugin-to-host").ok).toBe(true);
    const callback = structuredClone(outcome);
    (callback.params as Record<string, unknown>).callbackId = "second-id";
    expect(parsePluginRuntimeEnvelope(callback).ok).toBe(false);

    expect(parsePluginRuntimeEnvelope(result("command.execute", {
      ok: false,
      code: "PERMISSION_DENIED",
      message: "not granted",
    })).ok).toBe(true);
    expect(parsePluginRuntimeEnvelope(result("command.execute", { arbitrary: true })).ok).toBe(false);
  });

  it("parses role-discriminated bootstrap and enforces preview and overlay defaults", () => {
    for (const role of ["controller", "view", "file-viewer", "overlay", "preview"] as const) {
      expect(parsePluginRuntimeEnvelope(bootstrap(role)).ok, role).toBe(true);
    }

    const overlay = bootstrap("overlay");
    ((overlay.params as Record<string, any>).context).visible = true;
    expect(parsePluginRuntimeEnvelope(overlay).ok).toBe(false);

    const preview = bootstrap("preview");
    (preview.params as Record<string, any>).hostCommands = ["project.current"];
    expect(parsePluginRuntimeEnvelope(preview).ok).toBe(false);
    (preview.params as Record<string, any>).hostCommands = [];
    (preview.params as Record<string, any>).events = ["project.changed"];
    expect(parsePluginRuntimeEnvelope(preview).ok).toBe(false);
    (preview.params as Record<string, any>).events = [];
    (preview.params as Record<string, any>).context.previewInput = "x".repeat(
      PLUGIN_RUNTIME_LIMITS.maxPreviewInputBytes + 1,
    );
    expect(parsePluginRuntimeEnvelope(preview).ok).toBe(false);

    expect(authorize(envelope("request", "command.execute", {
      command: "project.current",
      params: {},
    }), "plugin-to-host", "preview", []).ok).toBe(false);
    expect(authorize(envelope("request", "event.subscribe", {
      topic: "project.changed",
    }), "plugin-to-host", "preview", []).ok).toBe(false);
  });

  it("requires monotonic context revisions and a provider update bound to that revision", () => {
    const viewPrincipal = {
      ...principal,
      role: "view" as const,
      contributionId: "main",
      instanceId: "view.1",
      domHandleId: "dom.view.1",
    };
    const session = new PluginRuntimeSessionValidator({
      principal: viewPrincipal,
      hostCommands: ["project.current"],
      eventTopics: ["project.changed"],
    });
    expect(session.accept(bootstrap("view"), "host-to-plugin", 7).ok).toBe(true);
    expect(session.accept(envelope("request", "context.update", {
      revision: 2,
      theme: { ...theme, colorMode: "light" },
      locale: "en-US",
      slot: { width: 700, height: 500, scaleFactor: 1 },
      visible: true,
      interactive: true,
      instance: { projectId: "project.1", route: "details" },
    }, "request.context.2", 2), "host-to-plugin", 7).ok).toBe(true);
    expect(session.accept(envelope("signal", "lifecycle.ready", {
      inventory: { commands: [], views: ["main"], fileViewers: [], overlays: [] },
    }, "request.ready.context", 1), "plugin-to-host", 7).ok).toBe(true);
    expect(session.accept(envelope("request", "provider.mount", {
      contextRevision: 2,
    }, "request.provider.mount.context", 3), "host-to-plugin", 7).ok).toBe(true);
    expect(session.accept(envelope("request", "provider.update", {
      contextRevision: 2,
    }, "request.provider.2", 4), "host-to-plugin", 7).ok).toBe(true);
    expect(session.accept(envelope("request", "context.update", {
      revision: 2,
      theme,
      locale: "ko-KR",
      slot: { width: 1, height: 1, scaleFactor: 1 },
      visible: true,
      interactive: true,
      instance: null,
    }, "request.context.replay", 5), "host-to-plugin", 7).ok).toBe(false);
    expect(session.accept(envelope("request", "provider.update", {
      contextRevision: 3,
    }, "request.provider.future", 5), "host-to-plugin", 7).ok).toBe(false);
  });

  it("enforces ready then mount/update/unmount provider lifecycle order", () => {
    const viewPrincipal = {
      ...principal,
      role: "view" as const,
      contributionId: "main",
      instanceId: "view.1",
      domHandleId: "dom.view.1",
    };
    const session = new PluginRuntimeSessionValidator({
      principal: viewPrincipal,
      hostCommands: ["project.current"],
      eventTopics: ["project.changed"],
    });
    expect(session.accept(bootstrap("view"), "host-to-plugin", 7).ok).toBe(true);
    expect(session.accept(envelope("request", "provider.update", {
      contextRevision: 1,
    }, "request.provider.before-ready", 2), "host-to-plugin", 7).ok).toBe(false);
    expect(session.accept(envelope("signal", "lifecycle.ready", {
      inventory: { commands: [], views: ["main"], fileViewers: [], overlays: [] },
    }, "request.ready.1", 1), "plugin-to-host", 7).ok).toBe(true);
    expect(session.accept(envelope("request", "provider.update", {
      contextRevision: 1,
    }, "request.provider.before-mount", 2), "host-to-plugin", 7).ok).toBe(false);
    expect(session.accept(envelope("request", "provider.mount", {
      contextRevision: 1,
    }, "request.provider.mount", 2), "host-to-plugin", 7).ok).toBe(true);
    expect(session.accept(envelope("request", "provider.mount", {
      contextRevision: 1,
    }, "request.provider.remount", 3), "host-to-plugin", 7).ok).toBe(false);
    expect(session.accept(envelope("request", "provider.update", {
      contextRevision: 1,
    }, "request.provider.update", 3), "host-to-plugin", 7).ok).toBe(true);
    expect(session.accept(envelope("request", "provider.unmount", {
      contextRevision: 1,
    }, "request.provider.unmount", 4), "host-to-plugin", 7).ok).toBe(true);
    expect(session.accept(envelope("request", "provider.update", {
      contextRevision: 1,
    }, "request.provider.after-unmount", 5), "host-to-plugin", 7).ok).toBe(false);
  });

  it("copies and freezes constructor inputs and closes both directions on teardown", () => {
    const hostCommands = ["project.current"];
    const mutablePrincipal = { ...principal };
    const session = new PluginRuntimeSessionValidator({
      principal: mutablePrincipal,
      hostCommands,
      eventTopics: ["project.changed"],
    });
    mutablePrincipal.pluginId = "mutated";
    hostCommands.push("secrets.read");
    expect(session.principal.pluginId).toBe("weather");
    expect(session.hostCommands).toEqual(["project.current"]);
    expect(Object.isFrozen(session.principal)).toBe(true);
    expect(Object.isFrozen(session.hostCommands)).toBe(true);

    const originalBootstrap = bootstrap();
    expect(session.accept(originalBootstrap, "host-to-plugin", 7).ok).toBe(true);
    (originalBootstrap.params as Record<string, any>).context.locale = "mutated";
    expect(session.context?.locale).toBe("ko-KR");
    expect(Object.isFrozen(session.context)).toBe(true);
    expect(Object.isFrozen(session.context?.theme)).toBe(true);
    expect(session.accept(envelope("signal", "runtime.teardown", {
      reason: "fault",
    }, "request.teardown.1", 1), "plugin-to-host", 7).ok).toBe(true);
    expect(session.closed).toBe(true);
    expect(session.accept(envelope("signal", "lifecycle.ready", {
      inventory: { commands: [], views: [], fileViewers: [], overlays: [] },
    }, "request.ready.late", 2), "plugin-to-host", 7).ok).toBe(false);
    expect(session.accept(envelope("signal", "runtime.teardown", {
      reason: "again",
    }, "request.teardown.2", 2), "host-to-plugin", 7).ok).toBe(false);
  });

  it("binds pending requests to generation, method, response, and deadline forever", () => {
    const options = { maxPending: 2, generation: 7 };
    const pending = new PluginRuntimePendingTracker(options);
    options.generation = 99;
    expect(Object.isFrozen(pending.options)).toBe(true);
    expect(pending.begin({
      requestId: "request.1",
      method: "command.execute",
      expected: "result",
      now: 1_000,
      timeoutMs: 5_000,
    })).toEqual({ ok: true, deadline: 6_000 });
    expect(pending.settle({
      requestId: "request.1",
      generation: 8,
      response: "result",
      responseTo: "command.execute",
      now: 2_000,
    }).ok).toBe(false);
    expect(pending.settle({
      requestId: "request.1",
      generation: 7,
      response: "result",
      responseTo: "dom.query",
      now: 2_000,
    }).ok).toBe(false);
    expect(pending.settle({
      requestId: "request.1",
      generation: 7,
      response: "result",
      responseTo: "command.execute",
      now: 6_001,
    }).ok).toBe(false);
    expect(pending.begin({
      requestId: "request.1",
      method: "command.execute",
      expected: "result",
      now: 7_000,
      timeoutMs: 1_000,
    }).ok).toBe(false);
    expect(pending.settle({
      requestId: "unknown",
      generation: 7,
      response: "result",
      responseTo: "command.execute",
      now: 2_000,
    }).ok).toBe(false);
  });

  it("enforces correlation and the pending cap inside the duplex session", () => {
    const session = new PluginRuntimeSessionValidator({
      principal,
      hostCommands: ["project.current"],
      eventTopics: ["project.changed"],
      maxPending: 2,
    });
    expect(session.accept(bootstrap(), "host-to-plugin", 7).ok).toBe(true);
    expect(session.accept(result("runtime.bootstrap", { accepted: true }), "plugin-to-host", 7).ok).toBe(true);
    expect(session.accept(result("command.execute", {
      ok: true,
      code: "OK",
      message: "forged",
    }, "request.unsolicited", 2), "host-to-plugin", 7).ok).toBe(false);
    expect(session.accept(envelope("request", "command.execute", {
      command: "project.current",
      params: {},
    }, "request.command.1", 3), "plugin-to-host", 7).ok).toBe(true);
    expect(session.accept(envelope("request", "command.execute", {
      command: "project.current",
      params: {},
    }, "request.command.2", 4), "plugin-to-host", 7).ok).toBe(true);
    expect(session.accept(envelope("request", "command.execute", {
      command: "project.current",
      params: {},
    }, "request.command.3", 5), "plugin-to-host", 7).ok).toBe(false);
  });

  it("owns subscriptions and makes resource release terminal", () => {
    const session = new PluginRuntimeSessionValidator({
      principal,
      hostCommands: ["project.current"],
      eventTopics: ["project.changed"],
      resourceHandles: ["resource.one"],
    });
    expect(session.accept(bootstrap(), "host-to-plugin", 7).ok).toBe(true);
    expect(session.accept(result("runtime.bootstrap", { accepted: true }), "plugin-to-host", 7).ok).toBe(true);
    expect(session.accept(envelope("request", "event.subscribe", {
      topic: "project.changed",
    }, "request.subscribe.1", 3), "plugin-to-host", 7).ok).toBe(true);
    expect(session.accept(result("event.subscribe", {
      subscriptionId: "subscription.owned",
    }, "request.subscribe.1", 2), "host-to-plugin", 7).ok).toBe(true);
    expect(session.accept(envelope("request", "event.unsubscribe", {
      subscriptionId: "subscription.foreign",
    }, "request.unsubscribe.foreign", 4), "plugin-to-host", 7).ok).toBe(false);

    expect(session.accept(envelope("request", "resource.release", {
      resourceId: "resource.one",
    }, "request.release.1", 4), "plugin-to-host", 7).ok).toBe(true);
    expect(session.accept(result("resource.release", {
      acknowledged: true,
    }, "request.release.1", 3), "host-to-plugin", 7).ok).toBe(true);
    expect(session.accept(envelope("request", "resource.open", {
      resourceId: "resource.one",
      offset: 0,
      length: 1,
    }, "request.open.released", 5), "plugin-to-host", 7).ok).toBe(false);
  });

  it("allows only opaque node/data-node queries and bounded paged snapshots", () => {
    expect(parsePluginRuntimeEnvelope(envelope("request", "dom.query", {
      handleId: "dom.view.1",
      query: { dataNode: "result/item-1" },
    })).ok).toBe(true);
    expect(parsePluginRuntimeEnvelope(envelope("request", "dom.query", {
      handleId: "dom.view.1",
      query: { nodeId: "node.17" },
    })).ok).toBe(true);
    expect(parsePluginRuntimeEnvelope(envelope("request", "dom.query", {
      handleId: "dom.view.1",
      query: { selector: "body > *" },
    })).ok).toBe(false);

    const snapshot = result("dom.snapshot", {
      handleId: "dom.view.1",
      revision: 3,
      cursor: "cursor.page.2",
      nodes: [{
        nodeId: "node.root",
        parentId: null,
        tag: "main",
        dataNode: "result/item-1",
        attrs: [{ name: "role", value: "main" }],
        text: "hello",
        rect: { x: 0, y: 0, width: 100, height: 80 },
      }],
    });
    expect(parsePluginRuntimeEnvelope(snapshot).ok).toBe(true);
    const tooMany = structuredClone(snapshot);
    (tooMany.value as Record<string, any>).nodes = Array.from(
      { length: PLUGIN_RUNTIME_LIMITS.maxDomPageNodes + 1 },
      (_, index) => ({ nodeId: `node.${index}`, parentId: null, tag: "i" }),
    );
    expect(parsePluginRuntimeEnvelope(tooMany).ok).toBe(false);

    expect(comparePluginDomDeclarations(["result"], ["result/item-1", "result/item-2"]).ok).toBe(true);
    const drift = comparePluginDomDeclarations(["result"], ["private-node"]);
    expect(drift.ok).toBe(false);
    expect(drift.undeclared).toEqual(["private-node"]);
  });

  it("binds DOM handles/nodes and revisions to one frame session", () => {
    const viewPrincipal = {
      ...principal,
      role: "view" as const,
      contributionId: "main",
      instanceId: "view.1",
      domHandleId: "dom.view.1",
    };
    const session = new PluginRuntimeSessionValidator({
      principal: viewPrincipal,
      hostCommands: ["project.current"],
      eventTopics: ["project.changed"],
    });
    expect(session.accept(bootstrap("view"), "host-to-plugin", 7).ok).toBe(true);
    expect(session.accept(envelope("signal", "dom.revision", {
      handleId: "dom.other",
      revision: 2,
    }, "request.dom.foreign", 1), "plugin-to-host", 7).ok).toBe(false);
    expect(session.accept(envelope("signal", "dom.revision", {
      handleId: "dom.view.1",
      revision: 2,
    }, "request.dom.revision.2", 2), "plugin-to-host", 7).ok).toBe(true);
    expect(session.accept(envelope("signal", "dom.revision", {
      handleId: "dom.view.1",
      revision: 1,
    }, "request.dom.revision.old", 3), "plugin-to-host", 7).ok).toBe(false);
    expect(session.accept(envelope("request", "dom.input", {
      handleId: "dom.view.1",
      nodeId: "node.never-observed",
      intent: { kind: "click", button: "primary" },
    }, "request.dom.input.1", 2), "host-to-plugin", 7).ok).toBe(false);
  });

  it("retires stale DOM authority and forbids input in preview", () => {
    const viewPrincipal = {
      ...principal,
      role: "view" as const,
      contributionId: "main",
      instanceId: "view.1",
      domHandleId: "dom.view.1",
    };
    const session = new PluginRuntimeSessionValidator({
      principal: viewPrincipal,
      hostCommands: ["project.current"],
      eventTopics: ["project.changed"],
    });
    expect(session.accept(bootstrap("view"), "host-to-plugin", 7).ok).toBe(true);
    expect(session.accept(result("runtime.bootstrap", { accepted: true }), "plugin-to-host", 7).ok).toBe(true);
    expect(session.accept(envelope("request", "dom.query", {
      handleId: "dom.view.1",
      query: { dataNode: "result/item" },
    }, "request.dom.query.1", 2), "host-to-plugin", 7).ok).toBe(true);
    expect(session.accept(result("dom.query", {
      handleId: "dom.view.1",
      revision: 1,
      nodeId: "node.one",
    }, "request.dom.query.1", 3), "plugin-to-host", 7).ok).toBe(true);
    expect(session.accept(envelope("signal", "dom.revision", {
      handleId: "dom.view.1",
      revision: 2,
    }, "request.dom.revision.2", 4), "plugin-to-host", 7).ok).toBe(true);
    expect(session.accept(envelope("request", "dom.input", {
      handleId: "dom.view.1",
      nodeId: "node.one",
      intent: { kind: "click", button: "primary" },
    }, "request.dom.input.stale", 3), "host-to-plugin", 7).ok).toBe(false);

    expect(authorize(envelope("request", "dom.input", {
      handleId: "dom.preview.1",
      nodeId: "node.one",
      intent: { kind: "click", button: "primary" },
    }), "host-to-plugin", "preview", []).ok).toBe(false);
  });

  it("requires bounded transferable streams with one-chunk backpressure", () => {
    const session = new PluginRuntimeSessionValidator({
      principal,
      hostCommands: ["project.current"],
      eventTopics: ["project.changed"],
    });
    expect(session.accept(bootstrap(), "host-to-plugin", 7).ok).toBe(true);
    expect(session.accept({
      ...envelope("signal", "stream.open", {
        streamId: "stream.1",
        totalBytes: 10,
        chunkBytes: 8,
      }, "request.stream.open", 1),
    }, "plugin-to-host", 7).ok).toBe(true);
    const chunk = {
      ...envelope("signal", "stream.chunk", {
        streamId: "stream.1",
        index: 0,
        byteLength: 8,
      }, "request.stream.chunk.0", 2),
      transfer: { kind: "array-buffer", byteLength: 8 },
    };
    expect(session.accept(chunk, "plugin-to-host", 7).ok).toBe(false);
    expect(session.accept(chunk, "plugin-to-host", 7, new ArrayBuffer(8)).ok).toBe(true);
    expect(session.accept({
      ...chunk,
      seq: 3,
      requestId: "request.stream.chunk.1",
      params: { streamId: "stream.1", index: 1, byteLength: 2 },
      transfer: { kind: "array-buffer", byteLength: 2 },
    }, "plugin-to-host", 7).ok).toBe(false);
    expect(session.accept(envelope("signal", "stream.ack", {
      streamId: "stream.1",
      nextIndex: 1,
    }, "request.stream.ack.1", 2), "host-to-plugin", 7).ok).toBe(true);
    expect(session.accept({
      ...chunk,
      seq: 4,
      requestId: "request.stream.chunk.1",
      params: { streamId: "stream.1", index: 1, byteLength: 2 },
      transfer: { kind: "array-buffer", byteLength: 2 },
    }, "plugin-to-host", 7, new ArrayBuffer(2)).ok).toBe(true);
    expect(session.accept(envelope("signal", "stream.ack", {
      streamId: "stream.1",
      nextIndex: 2,
    }, "request.stream.ack.2", 3), "host-to-plugin", 7).ok).toBe(true);
    expect(session.accept(envelope("signal", "stream.close", {
      streamId: "stream.1",
      totalBytes: 10,
    }, "request.stream.close", 5), "plugin-to-host", 7).ok).toBe(true);
  });

  it("certifies an exact bootstrap artifact, not descriptive claims", () => {
    expect(certifyPluginRuntimeBootstrapArtifact(artifact, {
      htmlSha256: sha("a"),
      htmlBytes: 1_024,
      moduleSha256: sha("b"),
      moduleBytes: 4_096,
    }).ok).toBe(true);
    expect(certifyPluginRuntimeBootstrapArtifact({ ...artifact, transferredPorts: 2 }, {
      htmlSha256: sha("a"), htmlBytes: 1_024, moduleSha256: sha("b"), moduleBytes: 4_096,
    }).ok).toBe(false);
    expect(certifyPluginRuntimeBootstrapArtifact({ ...artifact, csp: "default-src *" }, {
      htmlSha256: sha("a"), htmlBytes: 1_024, moduleSha256: sha("b"), moduleBytes: 4_096,
    }).ok).toBe(false);
    expect(certifyPluginRuntimeBootstrapArtifact({ ...artifact, ambientPostMessage: "allow" }, {
      htmlSha256: sha("a"), htmlBytes: 1_024, moduleSha256: sha("b"), moduleBytes: 4_096,
    }).ok).toBe(false);
    expect(certifyPluginRuntimeBootstrapArtifact({
      ...artifact,
      intrinsicsCapturedBeforePluginImport: false,
    }, {
      htmlSha256: sha("a"), htmlBytes: 1_024, moduleSha256: sha("b"), moduleBytes: 4_096,
    }).ok).toBe(false);
    expect(PLUGIN_RUNTIME_FRAME_POLICY.hostShellPluginImport).toBe("forbidden");
    expect(PLUGIN_RUNTIME_FRAME_POLICY.nativeRuntime).toBe("dedicated-killable-per-unit");
  });

  it("requires complete negative, positive, and infinite-loop live conformance", () => {
    const expectedArtifact = {
      htmlSha256: sha("a"), htmlBytes: 1_024, moduleSha256: sha("b"), moduleBytes: 4_096,
    };
    const report = {
      spec: "soksak-spec-plugin-runtime@0.0.1",
      platform: "darwin-aarch64",
      tauriRevision: "a370f653330506c2a5f59b643645a15b4cc30c18",
      artifact,
      topology: {
        hostShellPluginImport: "never",
        nativeRuntime: "dedicated-per-unit",
        sandboxFrame: "opaque-origin-allow-scripts",
      },
      availability: {
        infiniteLoopInjected: true,
        hostHeartbeatAdvanced: true,
        cliRemainedResponsive: true,
        terminatedOnlyFaultingUnit: true,
      },
      attacks: PLUGIN_RUNTIME_REQUIRED_ATTACK_PROBES.map((id) => ({ id, blocked: true })),
      positives: PLUGIN_RUNTIME_REQUIRED_POSITIVE_PROBES.map((id) => ({ id, passed: true })),
    };
    expect(certifyPluginRuntimeNativeConformance(report, expectedArtifact).ok).toBe(true);
    expect(isThirdPartyPluginRuntimeEligible(report, expectedArtifact)).toBe(true);
    expect(certifyPluginRuntimeNativeConformance(report, {
      ...expectedArtifact,
      htmlSha256: sha("c"),
    }).ok).toBe(false);
    const missing = structuredClone(report);
    missing.attacks.pop();
    expect(certifyPluginRuntimeNativeConformance(missing, expectedArtifact).ok).toBe(false);
    const availabilityFailure = structuredClone(report);
    availabilityFailure.availability.cliRemainedResponsive = false;
    expect(certifyPluginRuntimeNativeConformance(availabilityFailure, expectedArtifact).ok).toBe(false);
    expect(isThirdPartyPluginRuntimeEligible(availabilityFailure, expectedArtifact)).toBe(false);
    const positiveFailure = structuredClone(report);
    positiveFailure.positives[0].passed = false;
    expect(certifyPluginRuntimeNativeConformance(positiveFailure, expectedArtifact).ok).toBe(false);
  });

  it("compares only executable runtime providers; icon sets are verified data assets", () => {
    const inventory = { commands: ["refresh"], views: ["main"], fileViewers: ["code"], overlays: ["mascot"] };
    expect(comparePluginRuntimeInventory(inventory, inventory)).toEqual({ ok: true, errors: [] });
    expect(comparePluginRuntimeInventory(inventory, { ...inventory, commands: [] }).ok).toBe(false);
    expect(() => comparePluginRuntimeInventory(inventory, { ...inventory, commands: 1 } as never)).not.toThrow();
    expect(comparePluginRuntimeInventory(inventory, { ...inventory, commands: 1 } as never).ok).toBe(false);
    expect(parsePluginRuntimeEnvelope(envelope("signal", "lifecycle.ready", {
      inventory: { ...inventory, iconSets: ["executable-icon-code"] },
    })).ok).toBe(false);
  });

  it("requires declared DOM nodes to be observed", () => {
    const drift = comparePluginDomDeclarations(["root"], []);
    expect(drift.ok).toBe(false);
    expect(drift.unobserved).toEqual(["root"]);
  });
});
