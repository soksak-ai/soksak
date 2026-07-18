// Trusted renderer bridge for the native per-plugin helper process.
//
// Plugin entry bytes never cross this module: native `plugin_runtime_start` resolves and reads
// the declared source itself. The renderer receives only a principal/grant snapshot plus public
// wire envelopes, validates each envelope, and routes command.execute through the one Command
// Registry broker. No domain operation is duplicated on the runtime wire.

import { invoke } from "@tauri-apps/api/core";
import {
  PluginRuntimeSessionValidator,
  comparePluginRuntimeInventory,
  pluginCommandName,
  type ContractProviderRef,
  type ContractRequirement,
  type PluginManifest,
  type PluginPermission,
  type PluginRuntimeBootstrapArtifact,
  type PluginRuntimeEnvelope,
  type PluginRuntimeInventory,
  type PluginRuntimeJson,
  type PluginRuntimePolicy,
  type PluginRuntimePrincipal,
} from "@soksak-ai/plugin-spec";
import {
  catalogJson,
  executeFromPlugin,
  issuePluginCommandContext,
  register,
  unregister,
  type PluginCommandContext,
} from "../commands/registry";
import { safeListen } from "../lib/safeListen";

interface NativeRuntimeStartResult {
  readonly principal: PluginRuntimePrincipal;
  readonly permissions: readonly PluginPermission[];
  readonly requiredContracts: readonly ContractRequirement[];
  readonly providedContracts: readonly ContractProviderRef[];
  readonly hostCommands: readonly string[];
  readonly eventTopics: readonly string[];
  readonly bootstrapEnvelope: PluginRuntimeEnvelope;
  readonly artifact: PluginRuntimeBootstrapArtifact;
  readonly entrySha256: string;
  readonly sessionBindingSha256: string;
  readonly runtimePolicy: PluginRuntimePolicy;
}

interface NativeRuntimeEnvelopeEvent {
  readonly runtimeId: string;
  readonly pluginId: string;
  readonly generation: number;
  readonly envelope: unknown;
}

interface NativeRuntimeStatusEvent {
  readonly runtimeId: string;
  readonly pluginId: string;
  readonly generation: number;
  readonly status: "stopped" | "faulted";
  readonly reason?: string;
}

interface PendingPluginInvocation {
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (reason: Error) => void;
  readonly cancelDeadline: () => void;
}

interface RuntimeSession {
  readonly manifest: PluginManifest;
  readonly native: NativeRuntimeStartResult;
  readonly validator: PluginRuntimeSessionValidator;
  readonly commandContext: PluginCommandContext;
  readonly declaredInventory: PluginRuntimeInventory;
  readonly ready: Promise<void>;
  readonly resolveReady: () => void;
  readonly rejectReady: (reason: Error) => void;
  readonly pendingInvocations: Map<string, PendingPluginInvocation>;
  chain: Promise<void>;
  hostSequence: number;
  requestSequence: number;
  closed: boolean;
}

type StripWireIdentity<T> = T extends unknown ? Omit<T, "spec" | "seq"> : never;
type HostEnvelopeInput = StripWireIdentity<PluginRuntimeEnvelope>;

const sessions = new Map<string, RuntimeSession>();
let listenersInstalled = false;

function toRuntimeJson(value: unknown): PluginRuntimeJson {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("runtime payload must be JSON serializable");
  return JSON.parse(encoded) as PluginRuntimeJson;
}

function oneShotDeadline(ms: number, action: () => void): () => void {
  const handle = setTimeout(action, ms);
  return () => clearTimeout(handle);
}

function expectedInventory(manifest: PluginManifest): PluginRuntimeInventory {
  return {
    commands: manifest.contributes.commands
      .filter((command) => command.bind !== "service")
      .map((command) => command.name)
      .sort(),
    views: manifest.contributes.views.map((view) => view.id).sort(),
    fileViewers: manifest.contributes.fileViewers.map((viewer) => viewer.id).sort(),
    overlays: manifest.contributes.overlays.map((overlay) => overlay.id).sort(),
  };
}

// Session postmortems — a session dies asynchronously (fault, heartbeat loss, envelope
// rejection) and the closing reason used to vanish with it; every later call just said
// "runtime is not active". Kept per plugin id, surfaced via plugin.runtime.state.
const sessionPostmortems = new Map<string, { reason: string; at: number }>();

function closeSession(session: RuntimeSession, error: Error): void {
  if (session.closed) return;
  session.closed = true;
  sessionPostmortems.set(session.native.principal.pluginId, {
    reason: error.message,
    at: Date.now(),
  });
  console.error(
    `[plugin-runtime] session closed: ${session.native.principal.pluginId} — ${error.message}`,
  );
  session.validator.close();
  session.rejectReady(error);
  for (const pending of session.pendingInvocations.values()) {
    pending.cancelDeadline();
    pending.reject(error);
  }
  session.pendingInvocations.clear();
  sessions.delete(session.native.principal.runtimeId);
}

// Read-only diagnostic snapshot for plugin.runtime.state.
export function nativeRuntimeState(): {
  active: Array<{ pluginId: string; runtimeId: string; pendingInvocations: number }>;
  postmortems: Array<{ pluginId: string; reason: string; at: number }>;
} {
  return {
    active: [...sessions.values()]
      .filter((s) => !s.closed)
      .map((s) => ({
        pluginId: s.native.principal.pluginId,
        runtimeId: s.native.principal.runtimeId,
        pendingInvocations: s.pendingInvocations.size,
      })),
    postmortems: [...sessionPostmortems.entries()].map(([pluginId, p]) => ({
      pluginId,
      reason: p.reason,
      at: p.at,
    })),
  };
}

function nextHostEnvelope(
  session: RuntimeSession,
  envelope: HostEnvelopeInput,
): PluginRuntimeEnvelope {
  return {
    spec: "soksak-spec-plugin-runtime@0.0.1",
    seq: ++session.hostSequence,
    ...envelope,
  } as PluginRuntimeEnvelope;
}

async function sendHostEnvelope(session: RuntimeSession, envelope: PluginRuntimeEnvelope): Promise<void> {
  const accepted = session.validator.accept(
    envelope,
    "host-to-plugin",
    session.native.principal.generation,
  );
  if (!accepted.ok) throw new Error(`host runtime envelope rejected: ${accepted.errors.join("; ")}`);
  await invoke("plugin_runtime_send", {
    runtimeId: session.native.principal.runtimeId,
    envelope,
  });
}

async function handlePluginEnvelope(session: RuntimeSession, raw: unknown): Promise<void> {
  const accepted = session.validator.accept(
    raw,
    "plugin-to-host",
    session.native.principal.generation,
  );
  if (!accepted.ok) throw new Error(`plugin runtime envelope rejected: ${accepted.errors.join("; ")}`);
  const envelope = accepted.value;
  if (envelope.kind === "signal" && envelope.method === "lifecycle.ready") {
    const implemented = envelope.params.inventory as unknown as PluginRuntimeInventory;
    const compared = comparePluginRuntimeInventory(session.declaredInventory, implemented);
    if (!compared.ok) throw new Error(`plugin runtime inventory mismatch: ${compared.errors.join("; ")}`);
    session.resolveReady();
    return;
  }
  if (envelope.kind === "signal" && envelope.method === "runtime.fault") {
    throw new Error(`${envelope.params.code}: ${envelope.params.message}`);
  }
  if (envelope.kind === "request" && envelope.method === "command.execute") {
    const outcome = await executeFromPlugin(
      envelope.params.command as string,
      envelope.params.params as Record<string, unknown>,
      session.commandContext,
    );
    const wireOutcome = {
      ok: outcome.ok,
      code: outcome.code,
      message: outcome.message,
      ...(outcome.data ? { data: outcome.data } : {}),
    };
    await sendHostEnvelope(session, nextHostEnvelope(session, {
      kind: "result",
      requestId: envelope.requestId,
      responseTo: "command.execute",
      value: toRuntimeJson(wireOutcome),
    }));
    return;
  }
  if (envelope.kind === "signal" && envelope.method === "plugin-command.result") {
    const pending = session.pendingInvocations.get(envelope.requestId);
    if (!pending) throw new Error(`unsolicited plugin command result: ${envelope.requestId}`);
    session.pendingInvocations.delete(envelope.requestId);
    pending.cancelDeadline();
    pending.resolve(envelope.params.outcome as Record<string, unknown>);
    return;
  }
  throw new Error(
    `runtime method has no trusted host dispatcher: ${
      envelope.kind === "result" || envelope.kind === "error" ? envelope.responseTo : envelope.method
    }`,
  );
}

function installListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;
  safeListen<NativeRuntimeEnvelopeEvent>("plugin-runtime-envelope", ({ payload }) => {
    const session = sessions.get(payload.runtimeId);
    if (!session || session.closed) return;
    if (
      payload.pluginId !== session.native.principal.pluginId
      || payload.generation !== session.native.principal.generation
    ) {
      closeSession(session, new Error("native runtime event principal mismatch"));
      void invoke("plugin_runtime_stop", { id: session.native.principal.pluginId });
      return;
    }
    session.chain = session.chain
      .then(() => handlePluginEnvelope(session, payload.envelope))
      .catch((reason: unknown) => {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        closeSession(session, error);
        void invoke("plugin_runtime_stop", { id: session.native.principal.pluginId });
      });
  });
  safeListen<NativeRuntimeStatusEvent>("plugin-runtime-status", ({ payload }) => {
    const session = sessions.get(payload.runtimeId);
    if (!session || session.closed) return;
    closeSession(session, new Error(payload.reason ?? `native runtime ${payload.status}`));
  });
}

export interface ActiveNativePluginRuntime {
  readonly manifest: PluginManifest;
  readonly dir: string;
  readonly principal: PluginRuntimePrincipal;
  readonly artifact: PluginRuntimeBootstrapArtifact;
  readonly entrySha256: string;
  readonly sessionBindingSha256: string;
  deactivate(): Promise<void>;
}

export async function startNativePluginRuntime(
  manifest: PluginManifest,
  dir: string,
): Promise<ActiveNativePluginRuntime> {
  installListeners();
  const hostCommands = catalogJson()
    .filter((command) => command.pluginCallable)
    .map((command) => command.name)
    .sort();
  const native = await invoke<NativeRuntimeStartResult>("plugin_runtime_start", {
    id: manifest.id,
    hostCommands,
    eventTopics: [],
  });
  if (
    native.principal.pluginId !== manifest.id
    || native.principal.role !== "controller"
    || native.principal.domHandleId !== null
  ) {
    await invoke("plugin_runtime_stop", { id: manifest.id });
    throw new Error("native runtime returned an invalid controller principal");
  }
  let resolveReady!: () => void;
  let rejectReady!: (reason: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const validator = new PluginRuntimeSessionValidator({
    principal: native.principal,
    hostCommands: native.hostCommands,
    eventTopics: native.eventTopics,
  });
  const commandContext = issuePluginCommandContext({
    principal: native.principal,
    grants: {
      permissions: native.permissions,
      requiredContracts: native.requiredContracts,
      providedContracts: native.providedContracts,
    },
    authority: {
      namespace: manifest.id,
      paths: {},
      labels: {},
      coordinates: {},
    },
  });
  const session: RuntimeSession = {
    manifest,
    native,
    validator,
    commandContext,
    declaredInventory: expectedInventory(manifest),
    ready,
    resolveReady,
    rejectReady,
    pendingInvocations: new Map(),
    chain: Promise.resolve(),
    hostSequence: 1,
    requestSequence: 0,
    closed: false,
  };
  sessions.set(native.principal.runtimeId, session);
  const bootstrap = native.bootstrapEnvelope;
  const bootstrapAccepted = validator.accept(
    bootstrap,
    "host-to-plugin",
    native.principal.generation,
  );
  if (!bootstrapAccepted.ok) {
    closeSession(session, new Error(bootstrapAccepted.errors.join("; ")));
    await invoke("plugin_runtime_stop", { id: manifest.id });
    throw new Error(`native bootstrap envelope rejected: ${bootstrapAccepted.errors.join("; ")}`);
  }
  await invoke("plugin_runtime_send", {
    runtimeId: native.principal.runtimeId,
    envelope: bootstrap,
  });
  const cancelReadyDeadline = oneShotDeadline(8_000, () => {
    closeSession(session, new Error("plugin lifecycle.ready deadline exceeded"));
    void invoke("plugin_runtime_stop", { id: manifest.id });
  });
  try {
    await ready;
  } finally {
    cancelReadyDeadline();
  }
  // Registry proxies — the runtime wire carries plugin-command.invoke, but nothing
  // exposed the plugin's declared commands on the registry until now: without these
  // proxies an activated native-runtime plugin is enabled yet unreachable
  // (UNKNOWN_COMMAND). Manifest is the authority for names and danger.
  const unregisterProxies = registerNativeCommandProxies(manifest, native.principal.runtimeId);
  return {
    manifest,
    dir,
    principal: native.principal,
    artifact: native.artifact,
    entrySha256: native.entrySha256,
    sessionBindingSha256: native.sessionBindingSha256,
    deactivate: async () => {
      unregisterProxies();
      if (!session.closed) {
        const teardown = nextHostEnvelope(session, {
          kind: "signal",
          requestId: `teardown.${native.principal.generation}`,
          method: "runtime.teardown",
          params: { reason: "plugin-deactivated" },
        });
        await sendHostEnvelope(session, teardown).catch(() => {});
      }
      closeSession(session, new Error("plugin runtime deactivated"));
      await invoke("plugin_runtime_stop", { id: manifest.id });
    },
  };
}

// Manifest-declared commands → registry proxies for a native-runtime plugin.
// The manifest carries names/titles/danger only (spec prose lives plugin-side), so the
// proxy passes params through untyped and relays the runtime's CmdResult verbatim; the
// plugin handler owns ok/code/message. Returns the unregister closure.
function registerNativeCommandProxies(manifest: PluginManifest, runtimeId: string): () => void {
  const names: string[] = [];
  for (const declared of manifest.contributes?.commands ?? []) {
    const full = pluginCommandName(manifest.id, declared.name);
    register(full, {
      description: `${manifest.id} — ${declared.name} (native runtime)`,
      title: declared.title,
      params: {},
      paramsAuthority: "handler",
      returns: "object",
      message: (d) => (typeof d.message === "string" ? d.message : declared.name),
      ...(declared.danger ? { danger: declared.danger } : {}),
      handler: async (params, ctx) => {
        const outcome = await invokeNativePluginCommand(runtimeId, declared.name, params ?? {}, {
          origin: ctx?.origin ?? "human",
          parent: ctx?.parent ?? null,
        });
        return outcome as { ok: boolean; code: string; message: string; data?: Record<string, unknown> };
      },
    });
    names.push(full);
  }
  return () => {
    for (const name of names) unregister(name);
  };
}

export async function invokeNativePluginCommand(
  runtimeId: string,
  command: string,
  params: Record<string, unknown>,
  invocation: { origin: string; parent: string | null },
): Promise<Record<string, unknown>> {
  const session = sessions.get(runtimeId);
  if (!session || session.closed) throw new Error(`native plugin runtime is not active: ${runtimeId}`);
  const requestId = `invoke.${session.native.principal.generation}.${++session.requestSequence}`;
  const envelope = nextHostEnvelope(session, {
    kind: "request",
    requestId,
    method: "plugin-command.invoke",
    params: { command, params: toRuntimeJson(params), invocation },
  });
  const result = new Promise<Record<string, unknown>>((resolve, reject) => {
    const cancelDeadline = oneShotDeadline(30_000, () => {
      session.pendingInvocations.delete(requestId);
      reject(new Error(`plugin command deadline exceeded: ${command}`));
    });
    session.pendingInvocations.set(requestId, { resolve, reject, cancelDeadline });
  });
  try {
    await sendHostEnvelope(session, envelope);
  } catch (error) {
    const pending = session.pendingInvocations.get(requestId);
    pending?.cancelDeadline();
    session.pendingInvocations.delete(requestId);
    throw error;
  }
  return result;
}
