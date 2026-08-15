/**
 * Public plugin-runtime transport contract, version 0.0.1.
 *
 * This module deliberately does not enumerate application functionality. The
 * public Command Registry is the single source of truth for command parameter,
 * result, danger, permission, and domain-contract validation. This wire owns
 * only the small set of mechanisms needed to cross a runtime boundary.
 */

export const PLUGIN_RUNTIME_WIRE_SPEC = "soksak-spec-plugin-runtime@0.0.1";
export const PLUGIN_RUNTIME_BOOTSTRAP_SPEC = PLUGIN_RUNTIME_WIRE_SPEC;
export const PLUGIN_RUNTIME_CONFORMANCE_SPEC = PLUGIN_RUNTIME_WIRE_SPEC;

/** Exact policy of the canonical srcdoc artifact; native builds pin its bytes separately. */
export const PLUGIN_RUNTIME_BOOTSTRAP_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob:",
  "style-src 'unsafe-inline' blob:",
  "img-src data: blob:",
  "font-src data: blob:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'self' data: blob:",
  "child-src 'self' data: blob:",
  "worker-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * Confidentiality/integrity and availability are independent boundaries.
 * A sandbox iframe is useful for both real UI and preview, but it cannot make a
 * JavaScript infinite loop preemptible. Plugin bytes therefore never enter the
 * main shell renderer: a killable per-unit native runtime owns the trusted
 * wrapper and its opaque child frames.
 */
export const PLUGIN_RUNTIME_FRAME_POLICY = {
  hostShellPluginImport: "forbidden",
  nativeRuntime: "dedicated-killable-per-unit",
  confidentialityIntegrityBoundary: "opaque-origin-sandbox-frame",
  availabilityBoundary: "native-runtime-process-or-webview-pool",
  document: "about:srcdoc",
  sandboxTokens: ["allow-scripts"],
  forbiddenSandboxTokens: ["allow-same-origin"],
  moduleTransport: "single-message-port-then-blob-url",
  ambientPostMessage: "deny",
  nestedFrames: "local-by-default-remote-by-declared-origin",
  navigation: "declared-origin-only",
  webRtc: "declared-capability-only",
  thirdPartyFailureMode: "disabled-until-live-conformance-passes",
} as const;

/**
 * Runtime expansion is declarative. Local `srcdoc`/data/blob frames remain useful for previews
 * and composition; remote frames, document navigation and WebRTC are never inferred from plugin
 * code. The native helper certifies this snapshot before it creates the sandbox frame.
 */
export interface PluginRuntimePolicy {
  readonly navigationOrigins: readonly string[];
  readonly iframeOrigins: readonly string[];
  readonly webRtc: boolean;
}

export const DEFAULT_PLUGIN_RUNTIME_POLICY: PluginRuntimePolicy = Object.freeze({
  navigationOrigins: Object.freeze([]),
  iframeOrigins: Object.freeze([]),
  webRtc: false,
});

function parseRuntimeOrigin(value: unknown, label: string, errors: string[]): string | null {
  const before = errors.length;
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    errors.push(`${label}: bounded origin string required`);
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    errors.push(`${label}: valid URL origin required`);
    return null;
  }
  const loopback = parsed.protocol === "http:"
    && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]");
  if (parsed.protocol !== "https:" && !loopback) {
    errors.push(`${label}: https or loopback http origin required`);
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    errors.push(`${label}: scheme, host and optional port only`);
  }
  return errors.length > before ? null : parsed.origin;
}

export function parsePluginRuntimePolicy(raw: unknown): PluginRuntimeParseResult<PluginRuntimePolicy> {
  if (raw === undefined) return { ok: true, value: DEFAULT_PLUGIN_RUNTIME_POLICY };
  const errors: string[] = [];
  const value = strictObject(
    raw,
    ["navigationOrigins", "iframeOrigins", "webRtc"],
    [],
    "runtime",
    errors,
  );
  if (!value) return { ok: false, errors };
  const parseOrigins = (key: "navigationOrigins" | "iframeOrigins"): string[] => {
    const source = value[key] ?? [];
    if (!Array.isArray(source) || source.length > 64) {
      errors.push(`runtime.${key}: at most 64 origins required`);
      return [];
    }
    const output: string[] = [];
    const seen = new Set<string>();
    source.forEach((item, index) => {
      const before = errors.length;
      const origin = parseRuntimeOrigin(item, `runtime.${key}[${index}]`, errors);
      if (!origin || errors.length !== before) return;
      if (seen.has(origin)) errors.push(`runtime.${key}[${index}]: duplicate canonical origin`);
      else {
        seen.add(origin);
        output.push(origin);
      }
    });
    return output.sort();
  };
  const navigationOrigins = parseOrigins("navigationOrigins");
  const iframeOrigins = parseOrigins("iframeOrigins");
  if (value.webRtc !== undefined && typeof value.webRtc !== "boolean") {
    errors.push("runtime.webRtc: boolean required");
  }
  return errors.length > 0
    ? { ok: false, errors }
    : {
        ok: true,
        value: deepFreeze({
          navigationOrigins,
          iframeOrigins,
          webRtc: value.webRtc === true,
        }),
      };
}

export const PLUGIN_RUNTIME_REQUIRED_ATTACK_PROBES = [
  "host-shell-plugin-import",
  "authority-selector-in-envelope",
  "ambient-window-message-send",
  "ambient-window-message-receive",
  "local-storage",
  "session-storage",
  "indexed-db",
  "cache-storage",
  "origin-private-file-system",
  "cookie-read-write",
  "broadcast-channel",
  "wrapper-prototype-mutation",
  "closed-shadow-root",
  "permissions-query",
  "geolocation",
  "clipboard-api",
  "media-devices-get-user-media",
  "notifications",
  "midi",
  "usb",
  "serial",
  "hid",
  "webrtc-peer-connection",
  "webrtc-data-channel",
  "webtransport",
  "dns-prefetch",
  "preconnect",
  "link-prefetch",
  "anchor-ping",
  "global-tauri-internals",
  "global-is-tauri",
  "public-invoke",
  "random-invoke-key",
  "raw-ipc-handler",
  "self-location-navigation",
  "parent-top-navigation",
  "javascript-url-navigation",
  "data-url-navigation",
  "blob-url-navigation",
  "anchor-navigation",
  "meta-refresh-navigation",
  "form-submission",
  "window-open",
  "download-navigation",
  "fetch",
  "xml-http-request",
  "send-beacon",
  "websocket",
  "event-source",
  "worker",
  "shared-worker",
  "service-worker",
  "external-image",
  "external-style",
  "external-font",
  "external-media",
  "css-import-and-url",
  "external-object-embed-frame",
  "svg-external-reference",
  "fullscreen-and-pointer-lock",
] as const;

export const PLUGIN_RUNTIME_REQUIRED_POSITIVE_PROBES = [
  "canonical-bootstrap-bytes",
  "one-transferred-message-port",
  "captured-intrinsics-before-import",
  "blob-module-import",
  "inline-style",
  "blob-style",
  "data-image",
  "blob-image",
  "data-font",
  "blob-font",
  "data-media",
  "blob-media",
  "provider-mount",
  "provider-update",
  "provider-unmount",
  "dom-query-node-id",
  "dom-query-data-node",
  "dom-paged-snapshot",
  "dom-measure",
  "dom-input",
  "theme-context-update",
  "transferable-array-buffer-stream",
  "stream-backpressure",
  "command-registry-params-validation",
  "command-registry-result-validation",
  "command-registry-danger-enforcement",
  "command-registry-permission-enforcement",
  "command-registry-contract-enforcement",
  "host-principal-authority-injection",
] as const;

export const PLUGIN_RUNTIME_COMMAND_POLICY = {
  sourceOfTruth: "public-command-registry",
  wireMethod: "command.execute",
  registryValidatedFields: ["params", "returns", "danger", "permission", "contract"],
  hostInjectedAuthority: ["principal", "namespace", "path-authority", "window-label", "placement", "coordinates", "credentials"],
  pluginSelectedAuthority: "forbidden",
} as const;

export const PLUGIN_RUNTIME_METHODS = [
  "runtime.bootstrap", "runtime.teardown", "lifecycle.ready", "context.update",
  "provider.mount", "provider.update", "provider.unmount",
  "command.execute", "plugin-command.invoke", "plugin-command.result",
  "plugin-command.progress", "plugin-command.cancel",
  "event.subscribe", "event.unsubscribe", "event.deliver",
  "resource.open", "resource.release",
  "stream.open", "stream.chunk", "stream.ack", "stream.close",
  "dom.query", "dom.snapshot", "dom.measure", "dom.input", "dom.revision",
  "runtime.fault",
] as const;

export type PluginRuntimeMethod = (typeof PLUGIN_RUNTIME_METHODS)[number];

export const PLUGIN_RUNTIME_REQUEST_METHODS = [
  "runtime.bootstrap",
  "context.update",
  "provider.mount",
  "provider.update",
  "provider.unmount",
  "command.execute",
  "plugin-command.invoke",
  "event.subscribe",
  "event.unsubscribe",
  "resource.open",
  "resource.release",
  "dom.query",
  "dom.snapshot",
  "dom.measure",
  "dom.input",
] as const;

export const PLUGIN_RUNTIME_SIGNAL_METHODS = [
  "runtime.teardown",
  "lifecycle.ready",
  "plugin-command.result",
  "plugin-command.progress",
  "plugin-command.cancel",
  "event.deliver",
  "stream.open",
  "stream.chunk",
  "stream.ack",
  "stream.close",
  "dom.revision",
  "runtime.fault",
] as const;

export type PluginRuntimeRequestMethod = (typeof PLUGIN_RUNTIME_REQUEST_METHODS)[number];
export type PluginRuntimeSignalMethod = (typeof PLUGIN_RUNTIME_SIGNAL_METHODS)[number];
export type PluginRuntimeDirection = "plugin-to-host" | "host-to-plugin";
export type PluginRuntimeRole = "controller" | "view" | "file-viewer" | "overlay" | "preview";
export type PluginRuntimeExpectedResponse = "result" | "plugin-command.result";

export const PLUGIN_RUNTIME_LIMITS = {
  maxEnvelopeBytes: 131_072,
  maxJsonDepth: 16,
  maxJsonNodes: 8_192,
  maxObjectKeys: 256,
  maxArrayLength: 2_048,
  maxStringBytes: 32_768,
  maxFieldNameBytes: 128,
  maxIdLength: 128,
  maxPreviewInputBytes: 65_536,
  maxThemeTokens: 256,
  maxDomPageNodes: 256,
  maxDomPageBytes: 65_536,
  maxDomAttributes: 64,
  maxDomMeasurements: 256,
  maxPendingRequests: 128,
  maxRequestsPerSession: 16_384,
  maxSubscriptions: 256,
  maxActiveStreams: 128,
  maxStreamsPerSession: 4_096,
  maxDomOwnedNodes: 8_192,
  maxRequestTimeoutMs: 30_000,
  maxStreamChunkBytes: 65_536,
  maxStreamTotalBytes: 16_777_216,
  maxBootstrapHtmlBytes: 131_072,
  maxBootstrapModuleBytes: 1_048_576,
} as const;

export type PluginRuntimeJson =
  | null
  | boolean
  | number
  | string
  | PluginRuntimeJson[]
  | { [key: string]: PluginRuntimeJson };

export type PluginRuntimeReadonlyJson =
  | null
  | boolean
  | number
  | string
  | readonly PluginRuntimeReadonlyJson[]
  | { readonly [key: string]: PluginRuntimeReadonlyJson };

export interface PluginRuntimeCommandOutcome {
  readonly ok: boolean;
  readonly code: string;
  readonly message: string;
  readonly data?: { readonly [key: string]: PluginRuntimeJson };
}

export interface PluginRuntimePrincipal {
  readonly runtimeId: string;
  readonly sessionId: string;
  readonly windowLabel: string;
  readonly pluginId: string;
  readonly generation: number;
  readonly role: PluginRuntimeRole;
  readonly contributionId: string;
  readonly instanceId: string;
  readonly domHandleId: string | null;
}

export interface PluginRuntimeInventory {
  readonly commands: readonly string[];
  readonly views: readonly string[];
  readonly fileViewers: readonly string[];
  readonly overlays: readonly string[];
}

export interface PluginRuntimeRequestEnvelope {
  readonly spec: typeof PLUGIN_RUNTIME_WIRE_SPEC;
  readonly kind: "request";
  readonly seq: number;
  readonly requestId: string;
  readonly method: PluginRuntimeRequestMethod;
  readonly params: { [key: string]: PluginRuntimeJson };
}

export interface PluginRuntimeSignalEnvelope {
  readonly spec: typeof PLUGIN_RUNTIME_WIRE_SPEC;
  readonly kind: "signal";
  readonly seq: number;
  readonly requestId: string;
  readonly method: PluginRuntimeSignalMethod;
  readonly params: { [key: string]: PluginRuntimeJson };
  readonly transfer?: {
    readonly kind: "array-buffer";
    readonly byteLength: number;
  };
}

export interface PluginRuntimeResultEnvelope {
  readonly spec: typeof PLUGIN_RUNTIME_WIRE_SPEC;
  readonly kind: "result";
  readonly seq: number;
  readonly requestId: string;
  readonly responseTo: PluginRuntimeRequestMethod;
  readonly value: PluginRuntimeJson;
}

export interface PluginRuntimeErrorBody {
  readonly code: string;
  readonly message: string;
  readonly details?: PluginRuntimeJson;
}

export interface PluginRuntimeErrorEnvelope {
  readonly spec: typeof PLUGIN_RUNTIME_WIRE_SPEC;
  readonly kind: "error";
  readonly seq: number;
  readonly requestId: string;
  readonly responseTo: PluginRuntimeRequestMethod;
  readonly error: PluginRuntimeErrorBody;
}

export type PluginRuntimeEnvelope =
  | PluginRuntimeRequestEnvelope
  | PluginRuntimeSignalEnvelope
  | PluginRuntimeResultEnvelope
  | PluginRuntimeErrorEnvelope;

export interface PluginRuntimeBootstrapArtifact {
  readonly spec: typeof PLUGIN_RUNTIME_BOOTSTRAP_SPEC;
  readonly document: "about:srcdoc";
  readonly sandboxTokens: readonly ["allow-scripts"];
  readonly csp: typeof PLUGIN_RUNTIME_BOOTSTRAP_CSP;
  readonly html: { readonly sha256: string; readonly bytes: number };
  readonly module: { readonly sha256: string; readonly bytes: number };
  readonly transferredPorts: 1;
  readonly ambientPostMessage: "deny";
  readonly intrinsicsCapturedBeforePluginImport: true;
  readonly pluginImportRealm: "opaque-child-frame-only";
}

export interface PluginRuntimeBootstrapArtifactExpected {
  readonly htmlSha256: string;
  readonly htmlBytes: number;
  readonly moduleSha256: string;
  readonly moduleBytes: number;
}

export type PluginRuntimeParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

const UTF8 = new TextEncoder();
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTRIBUTION_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;
const LOCAL_COMMAND_RE = /^(?=.{1,128}$)[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/;
const COMMAND_RE = /^(?=.{1,256}$)[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/;
const TOPIC_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CAPABILITY_RE = /^[a-z0-9][a-z0-9:._-]{0,127}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const TAG_RE = /^[a-z][a-z0-9-]{0,63}$/;
const ATTRIBUTE_RE = /^[A-Za-z_:][A-Za-z0-9_.:-]{0,127}$/;
const DATA_NODE_RE = /^[a-z0-9][a-z0-9-]{0,127}(?:\/[A-Za-z0-9._~-]{1,128})?$/;
const THEME_TOKEN_RE = /^--[a-z0-9][a-z0-9-]{0,126}$/;

function fail<T>(...errors: string[]): PluginRuntimeParseResult<T> {
  return { ok: false, errors };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isOneOf<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function utf8Length(value: string): number {
  return UTF8.encode(value).byteLength;
}

function strictObject(
  raw: unknown,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
  errors: string[],
): Record<string, unknown> | null {
  if (!isRecord(raw)) {
    errors.push(`${label}: object required`);
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) errors.push(`${label}.${key}: unknown field`);
  }
  for (const key of required) {
    if (!Object.hasOwn(raw, key)) errors.push(`${label}.${key}: required`);
  }
  return raw;
}

interface JsonState {
  nodes: number;
  readonly ancestors: WeakSet<object>;
}

function walkJson(
  value: unknown,
  label: string,
  depth: number,
  state: JsonState,
  errors: string[],
): void {
  state.nodes += 1;
  if (state.nodes > PLUGIN_RUNTIME_LIMITS.maxJsonNodes) {
    errors.push(`${label}: JSON node limit exceeded`);
    return;
  }
  if (depth > PLUGIN_RUNTIME_LIMITS.maxJsonDepth) {
    errors.push(`${label}: JSON depth limit exceeded`);
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) errors.push(`${label}: finite JSON number required`);
    return;
  }
  if (typeof value === "string") {
    if (utf8Length(value) > PLUGIN_RUNTIME_LIMITS.maxStringBytes) {
      errors.push(`${label}: string byte limit exceeded`);
    }
    return;
  }
  if (typeof value !== "object") {
    errors.push(`${label}: JSON value required`);
    return;
  }
  if (state.ancestors.has(value)) {
    errors.push(`${label}: cyclic values are not JSON`);
    return;
  }
  state.ancestors.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      errors.push(`${label}: plain JSON array required`);
    }
    if (value.length > PLUGIN_RUNTIME_LIMITS.maxArrayLength) {
      errors.push(`${label}: array length limit exceeded`);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
        errors.push(`${label}: non-JSON array property forbidden`);
      }
    }
    const end = Math.min(value.length, PLUGIN_RUNTIME_LIMITS.maxArrayLength);
    for (let index = 0; index < end; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) {
        errors.push(`${label}[${index}]: dense data property required`);
      } else {
        walkJson(descriptor.value, `${label}[${index}]`, depth + 1, state, errors);
      }
    }
    state.ancestors.delete(value);
    return;
  }
  if (!isRecord(value)) {
    errors.push(`${label}: plain JSON object required`);
    state.ancestors.delete(value);
    return;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > PLUGIN_RUNTIME_LIMITS.maxObjectKeys) {
    errors.push(`${label}: object key limit exceeded`);
  }
  for (const key of keys.slice(0, PLUGIN_RUNTIME_LIMITS.maxObjectKeys)) {
    if (typeof key !== "string") {
      errors.push(`${label}: symbol keys are not JSON`);
      continue;
    }
    if (utf8Length(key) > PLUGIN_RUNTIME_LIMITS.maxFieldNameBytes) {
      errors.push(`${label}: field name byte limit exceeded`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      errors.push(`${label}.${key}: enumerable JSON data property required`);
    } else {
      walkJson(descriptor.value, `${label}.${key}`, depth + 1, state, errors);
    }
  }
  state.ancestors.delete(value);
}

function validateJson(raw: unknown, errors: string[]): boolean {
  walkJson(raw, "$", 0, { nodes: 0, ancestors: new WeakSet<object>() }, errors);
  if (errors.length > 0) return false;
  const encoded = JSON.stringify(raw);
  if (utf8Length(encoded) > PLUGIN_RUNTIME_LIMITS.maxEnvelopeBytes) {
    errors.push("$: envelope byte limit exceeded");
  }
  return errors.length === 0;
}

function validateId(value: unknown, label: string, errors: string[]): value is string {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    errors.push(`${label}: bounded opaque id required`);
    return false;
  }
  return true;
}

function validateText(
  value: unknown,
  label: string,
  errors: string[],
  allowEmpty = false,
): value is string {
  if (
    typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || utf8Length(typeof value === "string" ? value : "") > PLUGIN_RUNTIME_LIMITS.maxStringBytes
  ) {
    errors.push(`${label}: bounded${allowEmpty ? "" : " non-empty"} string required`);
    return false;
  }
  return true;
}

function validatePositive(value: unknown, label: string, errors: string[]): value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    errors.push(`${label}: positive safe integer required`);
    return false;
  }
  return true;
}

function validateNonNegative(value: unknown, label: string, errors: string[]): value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    errors.push(`${label}: non-negative safe integer required`);
    return false;
  }
  return true;
}

function validateBoundedStringArray(
  raw: unknown,
  label: string,
  pattern: RegExp,
  errors: string[],
): raw is string[] {
  if (!Array.isArray(raw) || raw.length > PLUGIN_RUNTIME_LIMITS.maxArrayLength) {
    errors.push(`${label}: bounded string array required`);
    return false;
  }
  const seen = new Set<string>();
  raw.forEach((value, index) => {
    if (typeof value !== "string" || !pattern.test(value)) {
      errors.push(`${label}[${index}]: invalid value`);
    } else if (seen.has(value)) {
      errors.push(`${label}[${index}]: duplicate value`);
    } else {
      seen.add(value);
    }
  });
  return errors.length === 0;
}

function validatePrincipal(raw: unknown, label: string, errors: string[]): raw is PluginRuntimePrincipal {
  const value = strictObject(
    raw,
    ["runtimeId", "sessionId", "windowLabel", "pluginId", "generation", "role", "contributionId", "instanceId", "domHandleId"],
    ["runtimeId", "sessionId", "windowLabel", "pluginId", "generation", "role", "contributionId", "instanceId", "domHandleId"],
    label,
    errors,
  );
  if (!value) return false;
  validateId(value.runtimeId, `${label}.runtimeId`, errors);
  validateId(value.sessionId, `${label}.sessionId`, errors);
  validateId(value.windowLabel, `${label}.windowLabel`, errors);
  validateId(value.pluginId, `${label}.pluginId`, errors);
  validatePositive(value.generation, `${label}.generation`, errors);
  if (!isOneOf(["controller", "view", "file-viewer", "overlay", "preview"] as const, value.role)) {
    errors.push(`${label}.role: runtime role required`);
  }
  if (typeof value.contributionId !== "string" || !CONTRIBUTION_RE.test(value.contributionId)) {
    errors.push(`${label}.contributionId: local contribution id required`);
  }
  validateId(value.instanceId, `${label}.instanceId`, errors);
  if (value.domHandleId !== null) validateId(value.domHandleId, `${label}.domHandleId`, errors);
  if (value.role === "controller" && value.domHandleId !== null) {
    errors.push(`${label}.domHandleId: controller must not own a DOM handle`);
  }
  if (value.role !== "controller" && value.domHandleId === null) {
    errors.push(`${label}.domHandleId: visual role requires a frame-owned DOM handle`);
  }
  return errors.length === 0;
}

function validateTheme(raw: unknown, label: string, errors: string[]): void {
  const value = strictObject(raw, ["colorMode", "tokens"], ["colorMode", "tokens"], label, errors);
  if (!value) return;
  if (!isOneOf(["light", "dark", "system"] as const, value.colorMode)) {
    errors.push(`${label}.colorMode: light, dark, or system required`);
  }
  if (!isRecord(value.tokens)) {
    errors.push(`${label}.tokens: CSS token record required`);
    return;
  }
  const entries = Object.entries(value.tokens);
  if (entries.length > PLUGIN_RUNTIME_LIMITS.maxThemeTokens) {
    errors.push(`${label}.tokens: token limit exceeded`);
  }
  for (const [name, token] of entries) {
    if (!THEME_TOKEN_RE.test(name)) errors.push(`${label}.tokens.${name}: canonical CSS custom property required`);
    validateText(token, `${label}.tokens.${name}`, errors, true);
  }
}

function validateSlot(raw: unknown, label: string, errors: string[]): void {
  const value = strictObject(raw, ["width", "height", "scaleFactor"], ["width", "height", "scaleFactor"], label, errors);
  if (!value) return;
  for (const key of ["width", "height", "scaleFactor"] as const) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || (value[key] as number) <= 0) {
      errors.push(`${label}.${key}: positive finite number required`);
    }
  }
}

function validateBaseContext(
  raw: unknown,
  label: string,
  errors: string[],
  allowedExtra: readonly string[] = [],
): Record<string, unknown> | null {
  const value = strictObject(
    raw,
    ["revision", "theme", "locale", "slot", "visible", "interactive", "instance", ...allowedExtra],
    ["revision", "theme", "locale", "slot", "visible", "interactive", "instance", ...allowedExtra],
    label,
    errors,
  );
  if (!value) return null;
  validatePositive(value.revision, `${label}.revision`, errors);
  validateTheme(value.theme, `${label}.theme`, errors);
  validateText(value.locale, `${label}.locale`, errors);
  if (value.slot !== null) validateSlot(value.slot, `${label}.slot`, errors);
  if (typeof value.visible !== "boolean") errors.push(`${label}.visible: boolean required`);
  if (typeof value.interactive !== "boolean") errors.push(`${label}.interactive: boolean required`);
  if (value.instance !== null && !isRecord(value.instance)) errors.push(`${label}.instance: JSON object or null required`);
  return value;
}

function validateBootstrapContext(
  raw: unknown,
  role: PluginRuntimeRole,
  errors: string[],
): void {
  const extras = role === "overlay"
    ? ["scope"]
    : role === "preview"
      ? ["targetKind", "previewInput"]
      : [];
  const context = validateBaseContext(raw, "$.params.context", errors, extras);
  if (!context) return;
  if (role === "controller") {
    if (context.slot !== null || context.visible !== false || context.interactive !== false || context.instance !== null) {
      errors.push("$.params.context: controller must be non-visual and have no instance data");
    }
  } else if (context.slot === null) {
    errors.push("$.params.context.slot: visual role requires a slot");
  }
  if (role === "overlay") {
    if (!isOneOf(["screen", "pane"] as const, context.scope)) {
      errors.push("$.params.context.scope: screen or pane required");
    }
    if (context.visible !== false || context.interactive !== false) {
      errors.push("$.params.context: overlay must start hidden and noninteractive");
    }
  }
  if (role === "preview") {
    if (!isOneOf(["view", "file-viewer", "overlay"] as const, context.targetKind)) {
      errors.push("$.params.context.targetKind: preview provider kind required");
    }
    if (context.interactive !== false) errors.push("$.params.context.interactive: preview must be noninteractive");
    const encoded = JSON.stringify(context.previewInput);
    if (utf8Length(encoded) > PLUGIN_RUNTIME_LIMITS.maxPreviewInputBytes) {
      errors.push("$.params.context.previewInput: preview fixture byte limit exceeded");
    }
  }
}

function validateBootstrap(raw: unknown, errors: string[]): void {
  const value = strictObject(
    raw,
    ["principal", "appVersion", "capabilities", "hostCommands", "events", "context", "bootstrapArtifactSha256"],
    ["principal", "appVersion", "capabilities", "hostCommands", "events", "context", "bootstrapArtifactSha256"],
    "$.params",
    errors,
  );
  if (!value) return;
  validatePrincipal(value.principal, "$.params.principal", errors);
  validateText(value.appVersion, "$.params.appVersion", errors);
  validateBoundedStringArray(value.capabilities, "$.params.capabilities", CAPABILITY_RE, errors);
  validateBoundedStringArray(value.hostCommands, "$.params.hostCommands", COMMAND_RE, errors);
  validateBoundedStringArray(value.events, "$.params.events", TOPIC_RE, errors);
  if (typeof value.bootstrapArtifactSha256 !== "string" || !SHA256_RE.test(value.bootstrapArtifactSha256)) {
    errors.push("$.params.bootstrapArtifactSha256: lowercase SHA-256 required");
  }
  if (isRecord(value.principal) && isOneOf(["controller", "view", "file-viewer", "overlay", "preview"] as const, value.principal.role)) {
    validateBootstrapContext(value.context, value.principal.role, errors);
    if (value.principal.role === "preview") {
      for (const key of ["capabilities", "hostCommands", "events"] as const) {
        if (Array.isArray(value[key]) && value[key].length !== 0) {
          errors.push(`$.params.${key}: preview must receive an empty grant set`);
        }
      }
    }
  }
}

function validateInventory(raw: unknown, label: string, errors: string[]): raw is PluginRuntimeInventory {
  const fields = ["commands", "views", "fileViewers", "overlays"] as const;
  const value = strictObject(raw, fields, fields, label, errors);
  if (!value) return false;
  for (const field of fields) {
    const list = value[field];
    if (!Array.isArray(list)) {
      errors.push(`${label}.${field}: contribution id array required`);
      continue;
    }
    const seen = new Set<string>();
    list.forEach((item, index) => {
      const pattern = field === "commands" ? LOCAL_COMMAND_RE : CONTRIBUTION_RE;
      if (typeof item !== "string" || !pattern.test(item)) {
        errors.push(`${label}.${field}[${index}]: local contribution id required`);
      } else if (seen.has(item)) {
        errors.push(`${label}.${field}[${index}]: duplicate contribution id`);
      } else {
        seen.add(item);
      }
    });
  }
  return errors.length === 0;
}

function validateOutcome(raw: unknown, label: string, errors: string[]): void {
  const value = strictObject(raw, ["ok", "code", "message", "data"], ["ok", "code", "message"], label, errors);
  if (!value) return;
  if (typeof value.ok !== "boolean") errors.push(`${label}.ok: boolean required`);
  if (typeof value.code !== "string" || !ERROR_CODE_RE.test(value.code)) {
    errors.push(`${label}.code: uppercase public outcome code required`);
  }
  validateText(value.message, `${label}.message`, errors);
  if (Object.hasOwn(value, "data") && !isRecord(value.data)) {
    errors.push(`${label}.data: command result object required`);
  }
}

function validateRect(raw: unknown, label: string, errors: string[]): void {
  const value = strictObject(raw, ["x", "y", "width", "height"], ["x", "y", "width", "height"], label, errors);
  if (!value) return;
  for (const key of ["x", "y", "width", "height"] as const) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
      errors.push(`${label}.${key}: finite number required`);
    }
  }
  if (typeof value.width === "number" && value.width < 0) errors.push(`${label}.width: non-negative required`);
  if (typeof value.height === "number" && value.height < 0) errors.push(`${label}.height: non-negative required`);
}

function validateDomQuery(raw: unknown, label: string, errors: string[]): void {
  if (!isRecord(raw)) {
    errors.push(`${label}: query object required`);
    return;
  }
  if (Object.hasOwn(raw, "nodeId")) {
    const value = strictObject(raw, ["nodeId"], ["nodeId"], label, errors);
    if (value) validateId(value.nodeId, `${label}.nodeId`, errors);
    return;
  }
  if (Object.hasOwn(raw, "dataNode")) {
    const value = strictObject(raw, ["dataNode"], ["dataNode"], label, errors);
    if (value && (typeof value.dataNode !== "string" || !DATA_NODE_RE.test(value.dataNode))) {
      errors.push(`${label}.dataNode: exact declared data-node address required`);
    }
    return;
  }
  errors.push(`${label}: exactly nodeId or dataNode required; CSS selectors are forbidden`);
}

function validateDomNode(raw: unknown, label: string, errors: string[]): void {
  const value = strictObject(
    raw,
    ["nodeId", "parentId", "tag", "dataNode", "attrs", "text", "value", "rect"],
    ["nodeId", "parentId", "tag"],
    label,
    errors,
  );
  if (!value) return;
  validateId(value.nodeId, `${label}.nodeId`, errors);
  if (value.parentId !== null) validateId(value.parentId, `${label}.parentId`, errors);
  if (typeof value.tag !== "string" || !TAG_RE.test(value.tag)) errors.push(`${label}.tag: lowercase DOM tag required`);
  if (Object.hasOwn(value, "dataNode") && (typeof value.dataNode !== "string" || !DATA_NODE_RE.test(value.dataNode))) {
    errors.push(`${label}.dataNode: declared data-node address required`);
  }
  if (Object.hasOwn(value, "text")) validateText(value.text, `${label}.text`, errors, true);
  if (Object.hasOwn(value, "value")) validateText(value.value, `${label}.value`, errors, true);
  if (Object.hasOwn(value, "rect")) validateRect(value.rect, `${label}.rect`, errors);
  if (Object.hasOwn(value, "attrs")) {
    if (!Array.isArray(value.attrs) || value.attrs.length > PLUGIN_RUNTIME_LIMITS.maxDomAttributes) {
      errors.push(`${label}.attrs: bounded attribute array required`);
    } else {
      const names = new Set<string>();
      value.attrs.forEach((rawAttr, index) => {
        const attr = strictObject(rawAttr, ["name", "value"], ["name", "value"], `${label}.attrs[${index}]`, errors);
        if (!attr) return;
        if (typeof attr.name !== "string" || !ATTRIBUTE_RE.test(attr.name)) {
          errors.push(`${label}.attrs[${index}].name: attribute name required`);
        } else if (names.has(attr.name)) {
          errors.push(`${label}.attrs[${index}].name: duplicate attribute`);
        } else {
          names.add(attr.name);
        }
        validateText(attr.value, `${label}.attrs[${index}].value`, errors, true);
      });
    }
  }
}

function validateDomIntent(raw: unknown, label: string, errors: string[]): void {
  if (!isRecord(raw)) {
    errors.push(`${label}: input intent required`);
    return;
  }
  if (raw.kind === "click") {
    const value = strictObject(raw, ["kind", "button"], ["kind"], label, errors);
    if (value && Object.hasOwn(value, "button") && !isOneOf(["primary", "auxiliary", "secondary"] as const, value.button)) {
      errors.push(`${label}.button: mouse button required`);
    }
  } else if (raw.kind === "fill") {
    const value = strictObject(raw, ["kind", "value"], ["kind", "value"], label, errors);
    if (value) validateText(value.value, `${label}.value`, errors, true);
  } else if (raw.kind === "key") {
    const value = strictObject(raw, ["kind", "key", "code", "modifiers", "repeat"], ["kind", "key"], label, errors);
    if (!value) return;
    validateText(value.key, `${label}.key`, errors);
    if (Object.hasOwn(value, "code")) validateText(value.code, `${label}.code`, errors);
    if (Object.hasOwn(value, "repeat") && typeof value.repeat !== "boolean") errors.push(`${label}.repeat: boolean required`);
    if (Object.hasOwn(value, "modifiers") && (
      !Array.isArray(value.modifiers)
      || value.modifiers.some((item) => !isOneOf(["alt", "ctrl", "meta", "shift"] as const, item))
    )) errors.push(`${label}.modifiers: modifier array required`);
  } else if (raw.kind === "focus") {
    strictObject(raw, ["kind"], ["kind"], label, errors);
  } else {
    errors.push(`${label}.kind: click, fill, key, or focus required`);
  }
}

function validateRequest(method: PluginRuntimeRequestMethod, raw: unknown, errors: string[]): void {
  switch (method) {
    case "runtime.bootstrap":
      validateBootstrap(raw, errors);
      return;
    case "context.update": {
      validateBaseContext(raw, "$.params", errors);
      return;
    }
    case "provider.mount":
    case "provider.update":
    case "provider.unmount": {
      const value = strictObject(raw, ["contextRevision"], ["contextRevision"], "$.params", errors);
      if (value) validatePositive(value.contextRevision, "$.params.contextRevision", errors);
      return;
    }
    case "command.execute": {
      const value = strictObject(raw, ["command", "params"], ["command", "params"], "$.params", errors);
      if (!value) return;
      if (typeof value.command !== "string" || !COMMAND_RE.test(value.command)) errors.push("$.params.command: public Command Registry name required");
      if (!isRecord(value.params)) errors.push("$.params.params: command parameter object required");
      return;
    }
    case "plugin-command.invoke": {
      const value = strictObject(raw, ["command", "params", "invocation"], ["command", "params", "invocation"], "$.params", errors);
      if (!value) return;
      if (typeof value.command !== "string" || !LOCAL_COMMAND_RE.test(value.command)) errors.push("$.params.command: declared local command id required");
      if (!isRecord(value.params)) errors.push("$.params.params: command parameter object required");
      const invocation = strictObject(value.invocation, ["origin", "parent"], ["origin", "parent"], "$.params.invocation", errors);
      if (invocation) {
        validateText(invocation.origin, "$.params.invocation.origin", errors);
        if (invocation.parent !== null) validateId(invocation.parent, "$.params.invocation.parent", errors);
      }
      return;
    }
    case "event.subscribe": {
      const value = strictObject(raw, ["topic"], ["topic"], "$.params", errors);
      if (value && (typeof value.topic !== "string" || !TOPIC_RE.test(value.topic))) errors.push("$.params.topic: event topic required");
      return;
    }
    case "event.unsubscribe": {
      const value = strictObject(raw, ["subscriptionId"], ["subscriptionId"], "$.params", errors);
      if (value) validateId(value.subscriptionId, "$.params.subscriptionId", errors);
      return;
    }
    case "resource.open": {
      const value = strictObject(raw, ["resourceId", "offset", "length"], ["resourceId", "offset", "length"], "$.params", errors);
      if (!value) return;
      validateId(value.resourceId, "$.params.resourceId", errors);
      validateNonNegative(value.offset, "$.params.offset", errors);
      if (validatePositive(value.length, "$.params.length", errors) && (value.length as number) > PLUGIN_RUNTIME_LIMITS.maxStreamTotalBytes) {
        errors.push("$.params.length: resource read limit exceeded");
      }
      return;
    }
    case "resource.release": {
      const value = strictObject(raw, ["resourceId"], ["resourceId"], "$.params", errors);
      if (value) validateId(value.resourceId, "$.params.resourceId", errors);
      return;
    }
    case "dom.query": {
      const value = strictObject(raw, ["handleId", "query"], ["handleId", "query"], "$.params", errors);
      if (value) {
        validateId(value.handleId, "$.params.handleId", errors);
        validateDomQuery(value.query, "$.params.query", errors);
      }
      return;
    }
    case "dom.snapshot": {
      const value = strictObject(raw, ["handleId", "cursor", "maxNodes", "maxBytes"], ["handleId", "cursor", "maxNodes", "maxBytes"], "$.params", errors);
      if (!value) return;
      validateId(value.handleId, "$.params.handleId", errors);
      if (value.cursor !== null) validateId(value.cursor, "$.params.cursor", errors);
      if (validatePositive(value.maxNodes, "$.params.maxNodes", errors) && (value.maxNodes as number) > PLUGIN_RUNTIME_LIMITS.maxDomPageNodes) errors.push("$.params.maxNodes: page node limit exceeded");
      if (validatePositive(value.maxBytes, "$.params.maxBytes", errors) && (value.maxBytes as number) > PLUGIN_RUNTIME_LIMITS.maxDomPageBytes) errors.push("$.params.maxBytes: page byte limit exceeded");
      return;
    }
    case "dom.measure": {
      const value = strictObject(raw, ["handleId", "nodeIds"], ["handleId", "nodeIds"], "$.params", errors);
      if (!value) return;
      validateId(value.handleId, "$.params.handleId", errors);
      if (!Array.isArray(value.nodeIds) || value.nodeIds.length === 0 || value.nodeIds.length > PLUGIN_RUNTIME_LIMITS.maxDomMeasurements) {
        errors.push("$.params.nodeIds: bounded non-empty node id array required");
      } else value.nodeIds.forEach((nodeId, index) => validateId(nodeId, `$.params.nodeIds[${index}]`, errors));
      return;
    }
    case "dom.input": {
      const value = strictObject(raw, ["handleId", "nodeId", "intent"], ["handleId", "nodeId", "intent"], "$.params", errors);
      if (value) {
        validateId(value.handleId, "$.params.handleId", errors);
        validateId(value.nodeId, "$.params.nodeId", errors);
        validateDomIntent(value.intent, "$.params.intent", errors);
      }
      return;
    }
  }
}

function validateSignal(method: PluginRuntimeSignalMethod, raw: unknown, errors: string[]): void {
  switch (method) {
    case "runtime.teardown": {
      const value = strictObject(raw, ["reason"], ["reason"], "$.params", errors);
      if (value) validateText(value.reason, "$.params.reason", errors);
      return;
    }
    case "lifecycle.ready": {
      const value = strictObject(raw, ["inventory"], ["inventory"], "$.params", errors);
      if (value) validateInventory(value.inventory, "$.params.inventory", errors);
      return;
    }
    case "plugin-command.result": {
      const value = strictObject(raw, ["outcome"], ["outcome"], "$.params", errors);
      if (value) validateOutcome(value.outcome, "$.params.outcome", errors);
      return;
    }
    case "plugin-command.progress": {
      const value = strictObject(raw, ["progress"], ["progress"], "$.params", errors);
      if (value && (typeof value.progress !== "number" || !Number.isFinite(value.progress) || value.progress < 0 || value.progress > 1)) errors.push("$.params.progress: finite 0..1 value required");
      return;
    }
    case "plugin-command.cancel": {
      const value = strictObject(raw, ["reason"], ["reason"], "$.params", errors);
      if (value) validateText(value.reason, "$.params.reason", errors);
      return;
    }
    case "event.deliver": {
      const value = strictObject(raw, ["subscriptionId", "topic", "value"], ["subscriptionId", "topic", "value"], "$.params", errors);
      if (value) {
        validateId(value.subscriptionId, "$.params.subscriptionId", errors);
        if (typeof value.topic !== "string" || !TOPIC_RE.test(value.topic)) errors.push("$.params.topic: event topic required");
      }
      return;
    }
    case "stream.open": {
      const value = strictObject(raw, ["streamId", "totalBytes", "chunkBytes"], ["streamId", "totalBytes", "chunkBytes"], "$.params", errors);
      if (!value) return;
      validateId(value.streamId, "$.params.streamId", errors);
      if (validateNonNegative(value.totalBytes, "$.params.totalBytes", errors) && (value.totalBytes as number) > PLUGIN_RUNTIME_LIMITS.maxStreamTotalBytes) errors.push("$.params.totalBytes: stream total limit exceeded");
      if (validatePositive(value.chunkBytes, "$.params.chunkBytes", errors) && (value.chunkBytes as number) > PLUGIN_RUNTIME_LIMITS.maxStreamChunkBytes) errors.push("$.params.chunkBytes: stream chunk limit exceeded");
      return;
    }
    case "stream.chunk": {
      const value = strictObject(raw, ["streamId", "index", "byteLength"], ["streamId", "index", "byteLength"], "$.params", errors);
      if (!value) return;
      validateId(value.streamId, "$.params.streamId", errors);
      validateNonNegative(value.index, "$.params.index", errors);
      if (validatePositive(value.byteLength, "$.params.byteLength", errors) && (value.byteLength as number) > PLUGIN_RUNTIME_LIMITS.maxStreamChunkBytes) errors.push("$.params.byteLength: stream chunk limit exceeded");
      return;
    }
    case "stream.ack": {
      const value = strictObject(raw, ["streamId", "nextIndex"], ["streamId", "nextIndex"], "$.params", errors);
      if (value) {
        validateId(value.streamId, "$.params.streamId", errors);
        validatePositive(value.nextIndex, "$.params.nextIndex", errors);
      }
      return;
    }
    case "stream.close": {
      const value = strictObject(raw, ["streamId", "totalBytes"], ["streamId", "totalBytes"], "$.params", errors);
      if (value) {
        validateId(value.streamId, "$.params.streamId", errors);
        validateNonNegative(value.totalBytes, "$.params.totalBytes", errors);
      }
      return;
    }
    case "dom.revision": {
      const value = strictObject(raw, ["handleId", "revision"], ["handleId", "revision"], "$.params", errors);
      if (value) {
        validateId(value.handleId, "$.params.handleId", errors);
        validatePositive(value.revision, "$.params.revision", errors);
      }
      return;
    }
    case "runtime.fault": {
      const value = strictObject(raw, ["code", "message"], ["code", "message"], "$.params", errors);
      if (value) {
        if (typeof value.code !== "string" || !ERROR_CODE_RE.test(value.code)) errors.push("$.params.code: uppercase fault code required");
        validateText(value.message, "$.params.message", errors);
      }
      return;
    }
  }
}

function validateAcknowledged(raw: unknown, label: string, errors: string[]): void {
  const value = strictObject(raw, ["acknowledged"], ["acknowledged"], label, errors);
  if (value && value.acknowledged !== true) errors.push(`${label}.acknowledged: exact true required`);
}

function validateResult(method: PluginRuntimeRequestMethod, raw: unknown, errors: string[]): void {
  switch (method) {
    case "runtime.bootstrap": {
      const value = strictObject(raw, ["accepted"], ["accepted"], "$.value", errors);
      if (value && value.accepted !== true) errors.push("$.value.accepted: exact true required");
      return;
    }
    case "context.update":
    case "provider.mount":
    case "provider.update":
    case "provider.unmount":
    case "event.unsubscribe":
    case "resource.release":
      validateAcknowledged(raw, "$.value", errors);
      return;
    case "command.execute":
      validateOutcome(raw, "$.value", errors);
      return;
    case "plugin-command.invoke":
      errors.push("$.responseTo: plugin-command.invoke requires plugin-command.result, not a generic result");
      return;
    case "event.subscribe": {
      const value = strictObject(raw, ["subscriptionId"], ["subscriptionId"], "$.value", errors);
      if (value) validateId(value.subscriptionId, "$.value.subscriptionId", errors);
      return;
    }
    case "resource.open": {
      const value = strictObject(raw, ["streamId", "totalBytes"], ["streamId", "totalBytes"], "$.value", errors);
      if (value) {
        validateId(value.streamId, "$.value.streamId", errors);
        if (validateNonNegative(value.totalBytes, "$.value.totalBytes", errors) && (value.totalBytes as number) > PLUGIN_RUNTIME_LIMITS.maxStreamTotalBytes) errors.push("$.value.totalBytes: resource limit exceeded");
      }
      return;
    }
    case "dom.query": {
      const value = strictObject(raw, ["handleId", "revision", "nodeId"], ["handleId", "revision", "nodeId"], "$.value", errors);
      if (value) {
        validateId(value.handleId, "$.value.handleId", errors);
        validatePositive(value.revision, "$.value.revision", errors);
        if (value.nodeId !== null) validateId(value.nodeId, "$.value.nodeId", errors);
      }
      return;
    }
    case "dom.snapshot": {
      const value = strictObject(raw, ["handleId", "revision", "cursor", "nodes"], ["handleId", "revision", "cursor", "nodes"], "$.value", errors);
      if (!value) return;
      validateId(value.handleId, "$.value.handleId", errors);
      validatePositive(value.revision, "$.value.revision", errors);
      if (value.cursor !== null) validateId(value.cursor, "$.value.cursor", errors);
      if (!Array.isArray(value.nodes) || value.nodes.length > PLUGIN_RUNTIME_LIMITS.maxDomPageNodes) {
        errors.push("$.value.nodes: bounded DOM page required");
      } else {
        const ids = new Set<string>();
        value.nodes.forEach((node, index) => {
          validateDomNode(node, `$.value.nodes[${index}]`, errors);
          if (isRecord(node) && typeof node.nodeId === "string") {
            if (ids.has(node.nodeId)) errors.push(`$.value.nodes[${index}].nodeId: duplicate node id`);
            ids.add(node.nodeId);
          }
        });
        if (utf8Length(JSON.stringify(value.nodes)) > PLUGIN_RUNTIME_LIMITS.maxDomPageBytes) {
          errors.push("$.value.nodes: DOM page byte limit exceeded");
        }
      }
      return;
    }
    case "dom.measure": {
      const value = strictObject(raw, ["handleId", "revision", "measurements"], ["handleId", "revision", "measurements"], "$.value", errors);
      if (!value) return;
      validateId(value.handleId, "$.value.handleId", errors);
      validatePositive(value.revision, "$.value.revision", errors);
      if (!Array.isArray(value.measurements) || value.measurements.length > PLUGIN_RUNTIME_LIMITS.maxDomMeasurements) {
        errors.push("$.value.measurements: bounded measurement array required");
      } else value.measurements.forEach((rawMeasurement, index) => {
        const measurement = strictObject(rawMeasurement, ["nodeId", "rect"], ["nodeId", "rect"], `$.value.measurements[${index}]`, errors);
        if (measurement) {
          validateId(measurement.nodeId, `$.value.measurements[${index}].nodeId`, errors);
          validateRect(measurement.rect, `$.value.measurements[${index}].rect`, errors);
        }
      });
      return;
    }
    case "dom.input": {
      const value = strictObject(raw, ["handleId", "nodeId", "revision", "acknowledged"], ["handleId", "nodeId", "revision", "acknowledged"], "$.value", errors);
      if (value) {
        validateId(value.handleId, "$.value.handleId", errors);
        validateId(value.nodeId, "$.value.nodeId", errors);
        validatePositive(value.revision, "$.value.revision", errors);
        if (value.acknowledged !== true) errors.push("$.value.acknowledged: exact true required");
      }
      return;
    }
  }
}

function validateError(raw: unknown, label: string, errors: string[]): void {
  const value = strictObject(raw, ["code", "message", "details"], ["code", "message"], label, errors);
  if (!value) return;
  if (typeof value.code !== "string" || !ERROR_CODE_RE.test(value.code)) errors.push(`${label}.code: uppercase error code required`);
  validateText(value.message, `${label}.message`, errors);
}

export function parsePluginRuntimeEnvelope(raw: unknown): PluginRuntimeParseResult<PluginRuntimeEnvelope> {
  const errors: string[] = [];
  if (!validateJson(raw, errors)) return { ok: false, errors };
  if (!isRecord(raw)) return fail("$: envelope object required");
  if (raw.spec !== PLUGIN_RUNTIME_WIRE_SPEC) errors.push(`$.spec: exact ${PLUGIN_RUNTIME_WIRE_SPEC} required`);
  validatePositive(raw.seq, "$.seq", errors);
  validateId(raw.requestId, "$.requestId", errors);
  if (raw.kind === "request") {
    const value = strictObject(raw, ["spec", "kind", "seq", "requestId", "method", "params"], ["spec", "kind", "seq", "requestId", "method", "params"], "$", errors);
    if (value && isOneOf(PLUGIN_RUNTIME_REQUEST_METHODS, value.method)) validateRequest(value.method, value.params, errors);
    else if (value) errors.push("$.method: unknown runtime request method");
  } else if (raw.kind === "signal") {
    const allowed = raw.method === "stream.chunk"
      ? ["spec", "kind", "seq", "requestId", "method", "params", "transfer"]
      : ["spec", "kind", "seq", "requestId", "method", "params"];
    const value = strictObject(raw, allowed, allowed, "$", errors);
    if (value && isOneOf(PLUGIN_RUNTIME_SIGNAL_METHODS, value.method)) {
      validateSignal(value.method, value.params, errors);
      if (value.method === "stream.chunk") {
        const transfer = strictObject(value.transfer, ["kind", "byteLength"], ["kind", "byteLength"], "$.transfer", errors);
        const params = isRecord(value.params) ? value.params : null;
        if (transfer) {
          if (transfer.kind !== "array-buffer") errors.push("$.transfer.kind: array-buffer required");
          if (!validatePositive(transfer.byteLength, "$.transfer.byteLength", errors) || transfer.byteLength !== params?.byteLength) {
            errors.push("$.transfer.byteLength: must equal chunk byteLength");
          }
        }
      }
    } else if (value) errors.push("$.method: unknown runtime signal method");
  } else if (raw.kind === "result") {
    const value = strictObject(raw, ["spec", "kind", "seq", "requestId", "responseTo", "value"], ["spec", "kind", "seq", "requestId", "responseTo", "value"], "$", errors);
    if (value && isOneOf(PLUGIN_RUNTIME_REQUEST_METHODS, value.responseTo)) validateResult(value.responseTo, value.value, errors);
    else if (value) errors.push("$.responseTo: unknown runtime request method");
  } else if (raw.kind === "error") {
    const value = strictObject(raw, ["spec", "kind", "seq", "requestId", "responseTo", "error"], ["spec", "kind", "seq", "requestId", "responseTo", "error"], "$", errors);
    if (value) {
      if (!isOneOf(PLUGIN_RUNTIME_REQUEST_METHODS, value.responseTo)) errors.push("$.responseTo: unknown runtime request method");
      validateError(value.error, "$.error", errors);
    }
  } else {
    errors.push("$.kind: request, signal, result, or error required");
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: raw as unknown as PluginRuntimeEnvelope };
}

type DirectionPolicy = PluginRuntimeDirection | "both";
interface DispatchPolicy {
  readonly direction: DirectionPolicy;
  readonly roles: readonly PluginRuntimeRole[];
}

const ALL_ROLES: readonly PluginRuntimeRole[] = ["controller", "view", "file-viewer", "overlay", "preview"];
const APP_ROLES: readonly PluginRuntimeRole[] = ["controller", "view", "file-viewer", "overlay"];
const VISUAL_ROLES: readonly PluginRuntimeRole[] = ["view", "file-viewer", "overlay", "preview"];
const INTERACTIVE_VISUAL_ROLES: readonly PluginRuntimeRole[] = ["view", "file-viewer", "overlay"];

const REQUEST_POLICY: Record<PluginRuntimeRequestMethod, DispatchPolicy> = {
  "runtime.bootstrap": { direction: "host-to-plugin", roles: ALL_ROLES },
  "context.update": { direction: "host-to-plugin", roles: ALL_ROLES },
  "provider.mount": { direction: "host-to-plugin", roles: VISUAL_ROLES },
  "provider.update": { direction: "host-to-plugin", roles: VISUAL_ROLES },
  "provider.unmount": { direction: "host-to-plugin", roles: VISUAL_ROLES },
  "command.execute": { direction: "plugin-to-host", roles: APP_ROLES },
  "plugin-command.invoke": { direction: "host-to-plugin", roles: ["controller"] },
  "event.subscribe": { direction: "plugin-to-host", roles: APP_ROLES },
  "event.unsubscribe": { direction: "plugin-to-host", roles: APP_ROLES },
  "resource.open": { direction: "plugin-to-host", roles: APP_ROLES },
  "resource.release": { direction: "plugin-to-host", roles: APP_ROLES },
  "dom.query": { direction: "host-to-plugin", roles: VISUAL_ROLES },
  "dom.snapshot": { direction: "host-to-plugin", roles: VISUAL_ROLES },
  "dom.measure": { direction: "host-to-plugin", roles: VISUAL_ROLES },
  "dom.input": { direction: "host-to-plugin", roles: INTERACTIVE_VISUAL_ROLES },
};

const SIGNAL_POLICY: Record<PluginRuntimeSignalMethod, DispatchPolicy> = {
  "runtime.teardown": { direction: "both", roles: ALL_ROLES },
  "lifecycle.ready": { direction: "plugin-to-host", roles: ALL_ROLES },
  "plugin-command.result": { direction: "plugin-to-host", roles: ["controller"] },
  "plugin-command.progress": { direction: "plugin-to-host", roles: ["controller"] },
  "plugin-command.cancel": { direction: "host-to-plugin", roles: ["controller"] },
  "event.deliver": { direction: "host-to-plugin", roles: APP_ROLES },
  "stream.open": { direction: "both", roles: APP_ROLES },
  "stream.chunk": { direction: "both", roles: APP_ROLES },
  "stream.ack": { direction: "both", roles: APP_ROLES },
  "stream.close": { direction: "both", roles: APP_ROLES },
  "dom.revision": { direction: "plugin-to-host", roles: VISUAL_ROLES },
  "runtime.fault": { direction: "plugin-to-host", roles: ALL_ROLES },
};

export interface PluginRuntimeAuthorizationContext {
  readonly direction: PluginRuntimeDirection;
  readonly role: PluginRuntimeRole;
  readonly hostCommands: readonly string[];
  readonly eventTopics: readonly string[];
  readonly principal?: PluginRuntimePrincipal;
}

function responseDirection(method: PluginRuntimeRequestMethod): PluginRuntimeDirection {
  return REQUEST_POLICY[method].direction === "plugin-to-host" ? "host-to-plugin" : "plugin-to-host";
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}

export function authorizePluginRuntimeEnvelope(
  envelope: PluginRuntimeEnvelope,
  context: PluginRuntimeAuthorizationContext,
): PluginRuntimeParseResult<PluginRuntimeEnvelope> {
  const errors: string[] = [];
  if (context.role === "preview" && (context.hostCommands.length !== 0 || context.eventTopics.length !== 0)) {
    errors.push("policy: preview has zero commands and event topics");
  }
  let dispatch: DispatchPolicy | null = null;
  if (envelope.kind === "request") dispatch = REQUEST_POLICY[envelope.method];
  else if (envelope.kind === "signal") dispatch = SIGNAL_POLICY[envelope.method];
  else {
    const expectedDirection = responseDirection(envelope.responseTo);
    if (expectedDirection !== context.direction) errors.push(`$.responseTo: response forbidden in ${context.direction}`);
    dispatch = REQUEST_POLICY[envelope.responseTo];
  }
  if (dispatch) {
    if (dispatch.direction !== "both" && dispatch.direction !== context.direction && envelope.kind !== "result" && envelope.kind !== "error") {
      errors.push(`policy: message forbidden in ${context.direction}`);
    }
    if (!dispatch.roles.includes(context.role)) errors.push(`policy: message forbidden for ${context.role}`);
  }
  if (envelope.kind === "request" && envelope.method === "command.execute") {
    const command = envelope.params.command as string;
    if (!context.hostCommands.includes(command)) errors.push(`$.params.command: ${command} not granted by the Command Registry`);
  }
  if (envelope.kind === "request" && envelope.method === "event.subscribe") {
    const topic = envelope.params.topic as string;
    if (!context.eventTopics.includes(topic)) errors.push(`$.params.topic: ${topic} not granted by the event registry`);
  }
  if (envelope.kind === "signal" && envelope.method === "event.deliver") {
    const topic = envelope.params.topic as string;
    if (!context.eventTopics.includes(topic)) errors.push(`$.params.topic: ${topic} not granted by the event registry`);
  }
  if (envelope.kind === "request" && envelope.method === "runtime.bootstrap") {
    const params = envelope.params as Record<string, unknown>;
    const bootstrapPrincipal = params.principal as unknown as PluginRuntimePrincipal;
    if (bootstrapPrincipal.role !== context.role) errors.push("$.params.principal.role: does not match trusted runtime role");
    if (!sameSet(params.hostCommands as string[], context.hostCommands)) errors.push("$.params.hostCommands: does not match host grant set");
    if (!sameSet(params.events as string[], context.eventTopics)) errors.push("$.params.events: does not match host event grant set");
    if (context.principal) {
      for (const key of ["runtimeId", "sessionId", "windowLabel", "pluginId", "generation", "role", "contributionId", "instanceId", "domHandleId"] as const) {
        if (bootstrapPrincipal[key] !== context.principal[key]) errors.push(`$.params.principal.${key}: does not match host principal`);
      }
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: envelope };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function copyAndFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

interface StreamState {
  readonly owner: PluginRuntimeDirection;
  readonly totalBytes: number;
  readonly chunkBytes: number;
  nextIndex: number;
  transferredBytes: number;
  inFlight: boolean;
}

interface SessionPendingRequest {
  readonly direction: PluginRuntimeDirection;
  readonly method: PluginRuntimeRequestMethod;
  readonly params: Readonly<Record<string, PluginRuntimeJson>>;
}

export interface PluginRuntimeSessionOptions {
  readonly principal: PluginRuntimePrincipal;
  readonly hostCommands: readonly string[];
  readonly eventTopics: readonly string[];
  readonly resourceHandles?: readonly string[];
  readonly maxPending?: number;
}

/** Duplex validator: accepting teardown from either direction closes the pair. */
export class PluginRuntimeSessionValidator {
  readonly principal: PluginRuntimePrincipal;
  readonly hostCommands: readonly string[];
  readonly eventTopics: readonly string[];
  readonly resourceHandles: readonly string[];
  readonly maxPending: number;
  readonly #lastSequence: Record<PluginRuntimeDirection, number> = {
    "host-to-plugin": 0,
    "plugin-to-host": 0,
  };
  readonly #requestIds = new Set<string>();
  readonly #pending = new Map<string, SessionPendingRequest>();
  readonly #subscriptions = new Map<string, string>();
  readonly #releasedResources = new Set<string>();
  readonly #nodeIds = new Set<string>();
  readonly #streams = new Map<string, StreamState>();
  readonly #retiredStreamIds = new Set<string>();
  #bootstrapped = false;
  #ready = false;
  #providerState: "idle" | "mounted" | "unmounted" = "idle";
  #closed = false;
  #contextRevision = 0;
  #domRevision = 0;
  #context: Readonly<Record<string, unknown>> | null = null;
  #previewInput: PluginRuntimeJson | null = null;

  constructor(options: PluginRuntimeSessionOptions) {
    const errors: string[] = [];
    const input = {
      principal: options.principal,
      hostCommands: options.hostCommands,
      eventTopics: options.eventTopics,
      resourceHandles: options.resourceHandles ?? [],
      maxPending: options.maxPending ?? PLUGIN_RUNTIME_LIMITS.maxPendingRequests,
    };
    validateJson(input, errors);
    if (errors.length > 0) throw new TypeError(errors.join("; "));
    const snapshot = structuredClone(input);
    validatePrincipal(snapshot.principal, "principal", errors);
    validateBoundedStringArray(snapshot.hostCommands, "hostCommands", COMMAND_RE, errors);
    validateBoundedStringArray(snapshot.eventTopics, "eventTopics", TOPIC_RE, errors);
    validateBoundedStringArray(snapshot.resourceHandles, "resourceHandles", ID_RE, errors);
    if (
      !Number.isSafeInteger(snapshot.maxPending)
      || snapshot.maxPending <= 0
      || snapshot.maxPending > PLUGIN_RUNTIME_LIMITS.maxPendingRequests
    ) errors.push("maxPending: bounded positive integer required");
    if (snapshot.principal.role === "preview" && (
      snapshot.hostCommands.length !== 0
      || snapshot.eventTopics.length !== 0
      || snapshot.resourceHandles.length !== 0
    )) errors.push("preview constructor grants must be empty");
    if (errors.length > 0) throw new TypeError(errors.join("; "));
    this.principal = deepFreeze(snapshot.principal);
    this.hostCommands = deepFreeze([...snapshot.hostCommands]);
    this.eventTopics = deepFreeze([...snapshot.eventTopics]);
    this.resourceHandles = deepFreeze([...snapshot.resourceHandles]);
    this.maxPending = snapshot.maxPending;
  }

  get closed(): boolean { return this.#closed; }
  get contextRevision(): number { return this.#contextRevision; }
  get context(): Readonly<Record<string, unknown>> | null { return this.#context; }
  get previewInput(): PluginRuntimeReadonlyJson | null { return this.#previewInput; }

  accept(
    raw: unknown,
    direction: PluginRuntimeDirection,
    currentGeneration: number,
    transferredBuffer?: ArrayBuffer,
  ): PluginRuntimeParseResult<PluginRuntimeEnvelope> {
    if (this.#closed) return fail("session: both directions are closed");
    if (currentGeneration !== this.principal.generation) return fail("session: stale host generation");
    const parsed = parsePluginRuntimeEnvelope(raw);
    if (!parsed.ok) return parsed;
    const authorized = authorizePluginRuntimeEnvelope(parsed.value, {
      direction,
      role: this.principal.role,
      hostCommands: this.hostCommands,
      eventTopics: this.eventTopics,
      principal: this.principal,
    });
    if (!authorized.ok) return authorized;
    const envelope = parsed.value;
    if (envelope.seq <= this.#lastSequence[direction]) {
      return fail(`$.seq: ${envelope.seq} is not newer than ${this.#lastSequence[direction]}`);
    }
    if (!this.#bootstrapped && (
      direction !== "host-to-plugin"
      || envelope.kind !== "request"
      || envelope.method !== "runtime.bootstrap"
    )) return fail("session: host bootstrap must be first");
    if (envelope.kind === "request") {
      if (this.#requestIds.has(envelope.requestId)) return fail("$.requestId: request id was already used");
      if (this.#requestIds.size >= PLUGIN_RUNTIME_LIMITS.maxRequestsPerSession) {
        return fail("session: request lifetime limit reached; recycle the runtime session");
      }
      if (envelope.method === "runtime.bootstrap" && this.#bootstrapped) return fail("session: bootstrap may occur only once");
    }
    const transferError = this.#validateTransfer(envelope, transferredBuffer);
    if (transferError) return fail(transferError);
    const correlationError = this.#validateCorrelation(envelope, direction);
    if (correlationError) return fail(correlationError);
    const stateError = this.#validateState(envelope, direction);
    if (stateError) return fail(stateError);
    this.#commitCorrelation(envelope, direction);
    this.#lastSequence[direction] = envelope.seq;
    if (envelope.kind === "request" && envelope.method === "runtime.bootstrap") {
      this.#bootstrapped = true;
      const params = envelope.params as Record<string, unknown>;
      const context = params.context as Record<string, unknown>;
      this.#contextRevision = context.revision as number;
      this.#context = copyAndFreeze(context);
      if (this.principal.role === "preview") {
        this.#previewInput = copyAndFreeze(context.previewInput as PluginRuntimeJson);
      }
    }
    if (envelope.kind === "request" && envelope.method === "context.update") {
      this.#contextRevision = envelope.params.revision as number;
      this.#context = copyAndFreeze(envelope.params);
    }
    if (envelope.kind === "signal" && envelope.method === "runtime.teardown") this.#closed = true;
    return parsed;
  }

  close(): void {
    this.#closed = true;
    this.#pending.clear();
    this.#subscriptions.clear();
    this.#streams.clear();
  }

  #validateTransfer(envelope: PluginRuntimeEnvelope, buffer: ArrayBuffer | undefined): string | null {
    const isChunk = envelope.kind === "signal" && envelope.method === "stream.chunk";
    if (!isChunk) return buffer === undefined ? null : "transfer: only stream.chunk may carry an ArrayBuffer";
    if (!(buffer instanceof ArrayBuffer)) return "transfer: stream.chunk requires one ArrayBuffer";
    if (buffer.byteLength !== envelope.params.byteLength || buffer.byteLength !== envelope.transfer?.byteLength) {
      return "transfer: ArrayBuffer length must exactly match stream.chunk metadata";
    }
    return null;
  }

  #validateCorrelation(envelope: PluginRuntimeEnvelope, direction: PluginRuntimeDirection): string | null {
    if (envelope.kind === "request") {
      if (this.#pending.size >= this.maxPending) return "session: pending request limit exceeded";
      return null;
    }
    if (envelope.kind === "result" || envelope.kind === "error") {
      const pending = this.#pending.get(envelope.requestId);
      if (!pending) return "session: unsolicited or retired response";
      if (pending.direction === direction) return "session: response must come from the opposite endpoint";
      if (pending.method !== envelope.responseTo) return "session: response method mismatch";
      if (expectedPluginRuntimeResponse(pending.method) !== "result") {
        return "session: request requires plugin-command.result rather than a generic response";
      }
      return null;
    }
    if (
      envelope.kind === "signal"
      && ["plugin-command.result", "plugin-command.progress", "plugin-command.cancel"].includes(envelope.method)
    ) {
      const pending = this.#pending.get(envelope.requestId);
      if (!pending || pending.method !== "plugin-command.invoke") {
        return "session: plugin-command signal has no matching invocation";
      }
      if (envelope.method === "plugin-command.cancel") {
        if (direction !== pending.direction) return "session: only the invocation owner may cancel";
      } else if (direction === pending.direction) {
        return "session: plugin-command response must come from the opposite endpoint";
      }
    }
    return null;
  }

  #commitCorrelation(envelope: PluginRuntimeEnvelope, direction: PluginRuntimeDirection): void {
    if (envelope.kind === "request") {
      this.#requestIds.add(envelope.requestId);
      this.#pending.set(envelope.requestId, copyAndFreeze({
        direction,
        method: envelope.method,
        params: envelope.params,
      }));
    } else if (
      envelope.kind === "result"
      || envelope.kind === "error"
      || (envelope.kind === "signal" && envelope.method === "plugin-command.result")
    ) {
      this.#pending.delete(envelope.requestId);
    }
  }

  #validateState(envelope: PluginRuntimeEnvelope, direction: PluginRuntimeDirection): string | null {
    if (envelope.kind === "signal" && envelope.method === "lifecycle.ready") {
      if (this.#ready) return "session: lifecycle.ready may occur only once";
      this.#ready = true;
    }
    if (envelope.kind === "request" && envelope.method === "context.update") {
      const revision = envelope.params.revision as number;
      if (revision <= this.#contextRevision) return "$.params.revision: context revision must increase";
      const roleError = validateContextForRole(envelope.params, this.principal.role);
      if (roleError) return roleError;
    }
    if (envelope.kind === "request" && envelope.method.startsWith("provider.")) {
      if (envelope.params.contextRevision !== this.#contextRevision) return "$.params.contextRevision: must equal accepted context revision";
      if (!this.#ready) return "session: provider lifecycle requires lifecycle.ready";
      if (envelope.method === "provider.mount") {
        if (this.#providerState !== "idle") return "session: provider.mount requires the idle state";
        this.#providerState = "mounted";
      } else if (envelope.method === "provider.update") {
        if (this.#providerState !== "mounted") return "session: provider.update requires a mounted provider";
      } else {
        if (this.#providerState !== "mounted") return "session: provider.unmount requires a mounted provider";
        this.#providerState = "unmounted";
      }
    }
    const domError = this.#validateDomState(envelope);
    if (domError) return domError;
    if (envelope.kind === "request" && envelope.method === "resource.open") {
      if (!this.resourceHandles.includes(envelope.params.resourceId as string)) return "$.params.resourceId: resource handle is not owned by this session";
      if (this.#releasedResources.has(envelope.params.resourceId as string)) return "$.params.resourceId: released resource cannot be reopened";
    }
    if (envelope.kind === "request" && envelope.method === "resource.release") {
      if (!this.resourceHandles.includes(envelope.params.resourceId as string)) return "$.params.resourceId: resource handle is not owned by this session";
      if (this.#releasedResources.has(envelope.params.resourceId as string)) return "$.params.resourceId: resource was already released";
    }
    if (envelope.kind === "request" && envelope.method === "event.unsubscribe") {
      if (!this.#subscriptions.has(envelope.params.subscriptionId as string)) {
        return "$.params.subscriptionId: subscription is not owned by this session";
      }
    }
    if (envelope.kind === "signal" && envelope.method === "event.deliver") {
      const topic = this.#subscriptions.get(envelope.params.subscriptionId as string);
      if (topic === undefined || topic !== envelope.params.topic) {
        return "event.deliver: subscription id/topic is not owned by this session";
      }
    }
    if (envelope.kind === "result" && envelope.responseTo === "event.subscribe") {
      const subscriptionId = (envelope.value as Record<string, unknown>).subscriptionId as string;
      if (this.#subscriptions.has(subscriptionId)) return "$.value.subscriptionId: subscription id was already used";
      if (this.#subscriptions.size >= PLUGIN_RUNTIME_LIMITS.maxSubscriptions) return "session: subscription limit exceeded";
      const pending = this.#pending.get(envelope.requestId);
      this.#subscriptions.set(subscriptionId, pending?.params.topic as string);
    }
    if (envelope.kind === "result" && envelope.responseTo === "event.unsubscribe") {
      const pending = this.#pending.get(envelope.requestId);
      this.#subscriptions.delete(pending?.params.subscriptionId as string);
    }
    if (envelope.kind === "result" && envelope.responseTo === "resource.release") {
      const pending = this.#pending.get(envelope.requestId);
      this.#releasedResources.add(pending?.params.resourceId as string);
    }
    if (envelope.kind === "signal" && envelope.method.startsWith("stream.")) {
      return this.#validateStream(envelope, direction);
    }
    return null;
  }

  #validateDomState(envelope: PluginRuntimeEnvelope): string | null {
    const method = envelope.kind === "request" || envelope.kind === "signal"
      ? envelope.method
      : envelope.responseTo;
    if (!method.startsWith("dom.")) return null;
    const payload = envelope.kind === "result"
      ? envelope.value
      : envelope.kind === "error"
        ? null
        : envelope.params;
    if (payload === null || !isRecord(payload)) return null;
    if (payload.handleId !== this.principal.domHandleId) return "DOM handle is not owned by this frame session";
    if (envelope.kind === "request") {
      if (method === "dom.query" && isRecord(payload.query) && Object.hasOwn(payload.query, "nodeId") && !this.#nodeIds.has(payload.query.nodeId as string)) {
        return "$.params.query.nodeId: node id is not owned by this frame session";
      }
      if (method === "dom.input" && !this.#nodeIds.has(payload.nodeId as string)) return "$.params.nodeId: node id is not owned by this frame session";
      if (method === "dom.measure" && (payload.nodeIds as unknown[]).some((nodeId) => !this.#nodeIds.has(nodeId as string))) return "$.params.nodeIds: node id is not owned by this frame session";
    }
    if (envelope.kind === "signal" && method === "dom.revision") {
      const revision = payload.revision as number;
      if (revision <= this.#domRevision) return "$.params.revision: DOM revision must increase";
      this.#nodeIds.clear();
      this.#domRevision = revision;
    }
    if (envelope.kind === "result") {
      const revision = payload.revision as number | undefined;
      if (revision !== undefined && revision < this.#domRevision) return "$.value.revision: stale DOM revision";
      if (revision !== undefined && revision > this.#domRevision) {
        this.#nodeIds.clear();
        this.#domRevision = revision;
      }
      if (method === "dom.snapshot" && Array.isArray(payload.nodes)) {
        const incoming: string[] = [];
        for (const node of payload.nodes) {
          if (isRecord(node) && typeof node.nodeId === "string" && !this.#nodeIds.has(node.nodeId)) {
            incoming.push(node.nodeId);
          }
        }
        if (this.#nodeIds.size + incoming.length > PLUGIN_RUNTIME_LIMITS.maxDomOwnedNodes) {
          return "session: DOM node authority limit exceeded";
        }
        for (const nodeId of incoming) this.#nodeIds.add(nodeId);
      }
      if (method === "dom.query" && typeof payload.nodeId === "string" && !this.#nodeIds.has(payload.nodeId)) {
        if (this.#nodeIds.size >= PLUGIN_RUNTIME_LIMITS.maxDomOwnedNodes) {
          return "session: DOM node authority limit exceeded";
        }
        this.#nodeIds.add(payload.nodeId);
      }
    }
    return null;
  }

  #validateStream(envelope: PluginRuntimeSignalEnvelope, direction: PluginRuntimeDirection): string | null {
    const streamId = envelope.params.streamId as string;
    if (envelope.method === "stream.open") {
      if (this.#streams.has(streamId) || this.#retiredStreamIds.has(streamId)) return "$.params.streamId: stream id was already used";
      if (this.#streams.size >= PLUGIN_RUNTIME_LIMITS.maxActiveStreams) return "session: active stream limit exceeded";
      if (this.#streams.size + this.#retiredStreamIds.size >= PLUGIN_RUNTIME_LIMITS.maxStreamsPerSession) {
        return "session: stream lifetime limit reached; recycle the runtime session";
      }
      this.#streams.set(streamId, {
        owner: direction,
        totalBytes: envelope.params.totalBytes as number,
        chunkBytes: envelope.params.chunkBytes as number,
        nextIndex: 0,
        transferredBytes: 0,
        inFlight: false,
      });
      return null;
    }
    const state = this.#streams.get(streamId);
    if (!state) return "$.params.streamId: unknown stream";
    if (envelope.method === "stream.chunk") {
      if (direction !== state.owner) return "stream.chunk: only stream owner may produce chunks";
      if (state.inFlight) return "stream.chunk: previous chunk requires acknowledgement";
      if (envelope.params.index !== state.nextIndex) return "$.params.index: next stream index required";
      const bytes = envelope.params.byteLength as number;
      if (bytes > state.chunkBytes || state.transferredBytes + bytes > state.totalBytes) return "$.params.byteLength: exceeds declared stream bounds";
      state.transferredBytes += bytes;
      state.nextIndex += 1;
      state.inFlight = true;
      return null;
    }
    if (envelope.method === "stream.ack") {
      if (direction === state.owner) return "stream.ack: consumer acknowledgement required";
      if (!state.inFlight || envelope.params.nextIndex !== state.nextIndex) return "$.params.nextIndex: does not acknowledge the in-flight chunk";
      state.inFlight = false;
      return null;
    }
    if (envelope.method === "stream.close") {
      if (direction !== state.owner) return "stream.close: only stream owner may close";
      if (state.inFlight) return "stream.close: in-flight chunk is not acknowledged";
      if (envelope.params.totalBytes !== state.transferredBytes || state.transferredBytes !== state.totalBytes) return "$.params.totalBytes: incomplete or mismatched stream";
      this.#streams.delete(streamId);
      this.#retiredStreamIds.add(streamId);
    }
    return null;
  }
}

function validateContextForRole(
  context: { [key: string]: PluginRuntimeJson },
  role: PluginRuntimeRole,
): string | null {
  if (role === "controller" && (
    context.slot !== null
    || context.visible !== false
    || context.interactive !== false
    || context.instance !== null
  )) return "context.update: controller must remain non-visual";
  if (role !== "controller" && context.slot === null) return "context.update: visual role requires a slot";
  if (role === "preview" && context.interactive !== false) return "context.update: preview must remain noninteractive";
  return null;
}

export type PluginRuntimePendingResult =
  | { readonly ok: true; readonly deadline?: number }
  | { readonly ok: false; readonly error: string };

export interface PluginRuntimePendingOptions {
  readonly generation: number;
  readonly maxPending?: number;
}

export interface PluginRuntimePendingBegin {
  readonly requestId: string;
  readonly method: PluginRuntimeRequestMethod;
  readonly expected: PluginRuntimeExpectedResponse;
  readonly now: number;
  readonly timeoutMs: number;
}

export interface PluginRuntimePendingSettle {
  readonly requestId: string;
  readonly generation: number;
  readonly response: PluginRuntimeExpectedResponse;
  readonly responseTo: PluginRuntimeRequestMethod;
  readonly now: number;
}

interface PendingRecord {
  readonly generation: number;
  readonly method: PluginRuntimeRequestMethod;
  readonly expected: PluginRuntimeExpectedResponse;
  readonly deadline: number;
}

export function expectedPluginRuntimeResponse(method: PluginRuntimeRequestMethod): PluginRuntimeExpectedResponse {
  return method === "plugin-command.invoke" ? "plugin-command.result" : "result";
}

export class PluginRuntimePendingTracker {
  readonly options: Readonly<Required<PluginRuntimePendingOptions>>;
  readonly #pending = new Map<string, PendingRecord>();
  readonly #used = new Set<string>();
  #closed = false;

  constructor(options: PluginRuntimePendingOptions) {
    const maxPending = options.maxPending ?? PLUGIN_RUNTIME_LIMITS.maxPendingRequests;
    if (!Number.isSafeInteger(options.generation) || options.generation <= 0) throw new TypeError("invalid generation");
    if (!Number.isSafeInteger(maxPending) || maxPending <= 0 || maxPending > PLUGIN_RUNTIME_LIMITS.maxPendingRequests) throw new TypeError("invalid maxPending");
    this.options = copyAndFreeze({ generation: options.generation, maxPending });
  }

  begin(input: PluginRuntimePendingBegin): PluginRuntimePendingResult {
    if (this.#closed) return { ok: false, error: "tracker closed" };
    const idErrors: string[] = [];
    if (!validateId(input.requestId, "requestId", idErrors)) return { ok: false, error: idErrors[0] };
    if (this.#used.has(input.requestId)) return { ok: false, error: "request id was already used" };
    if (this.#pending.size >= this.options.maxPending) return { ok: false, error: "pending request limit exceeded" };
    if (!isOneOf(PLUGIN_RUNTIME_REQUEST_METHODS, input.method)) return { ok: false, error: "unknown request method" };
    if (input.expected !== expectedPluginRuntimeResponse(input.method)) return { ok: false, error: "response type does not match request method" };
    if (!Number.isSafeInteger(input.now) || input.now < 0) return { ok: false, error: "invalid current time" };
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > PLUGIN_RUNTIME_LIMITS.maxRequestTimeoutMs) return { ok: false, error: "timeout out of bounds" };
    const deadline = input.now + input.timeoutMs;
    if (!Number.isSafeInteger(deadline)) return { ok: false, error: "deadline out of bounds" };
    this.#used.add(input.requestId);
    this.#pending.set(input.requestId, copyAndFreeze({
      generation: this.options.generation,
      method: input.method,
      expected: input.expected,
      deadline,
    }));
    return { ok: true, deadline };
  }

  settle(input: PluginRuntimePendingSettle): PluginRuntimePendingResult {
    const record = this.#pending.get(input.requestId);
    if (!record) return { ok: false, error: "unknown or retired request" };
    if (input.generation !== record.generation) return { ok: false, error: "response generation mismatch" };
    if (input.response !== record.expected || input.responseTo !== record.method) return { ok: false, error: "response method mismatch" };
    if (!Number.isSafeInteger(input.now) || input.now < 0) return { ok: false, error: "invalid current time" };
    if (input.now > record.deadline) {
      this.#pending.delete(input.requestId);
      return { ok: false, error: "late response rejected" };
    }
    this.#pending.delete(input.requestId);
    return { ok: true };
  }

  close(): void {
    this.#closed = true;
    this.#pending.clear();
  }
}

export function comparePluginRuntimeInventory(
  declared: PluginRuntimeInventory,
  implemented: PluginRuntimeInventory,
): { readonly ok: boolean; readonly errors: readonly string[] } {
  const errors: string[] = [];
  validateInventory(declared, "declared", errors);
  validateInventory(implemented, "implemented", errors);
  if (errors.length > 0) return { ok: false, errors };
  for (const field of ["commands", "views", "fileViewers", "overlays"] as const) {
    const expected = [...(declared[field] ?? [])].sort();
    const actual = [...(implemented[field] ?? [])].sort();
    if (expected.length !== actual.length || expected.some((item, index) => item !== actual[index])) {
      errors.push(`${field}: module exports must exactly match manifest runtime inventory`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function comparePluginDomDeclarations(
  declared: readonly string[],
  actual: readonly string[],
): {
  readonly ok: boolean;
  readonly undeclared: readonly string[];
  readonly unobserved: readonly string[];
  readonly errors: readonly string[];
} {
  const errors: string[] = [];
  const declarationSet = new Set<string>();
  for (const [index, id] of declared.entries()) {
    if (!CONTRIBUTION_RE.test(id)) errors.push(`declared[${index}]: local node declaration id required`);
    else if (declarationSet.has(id)) errors.push(`declared[${index}]: duplicate node declaration`);
    else declarationSet.add(id);
  }
  const observed = new Set<string>();
  const undeclared = new Set<string>();
  for (const [index, address] of actual.entries()) {
    if (!DATA_NODE_RE.test(address)) {
      errors.push(`actual[${index}]: invalid data-node address`);
      continue;
    }
    const declaration = address.split("/", 1)[0];
    observed.add(declaration);
    if (!declarationSet.has(declaration)) undeclared.add(address);
  }
  const unobserved = [...declarationSet].filter((id) => !observed.has(id)).sort();
  return {
    ok: errors.length === 0 && undeclared.size === 0 && unobserved.length === 0,
    undeclared: [...undeclared].sort(),
    unobserved,
    errors,
  };
}

function validateArtifactExpected(raw: unknown, label: string, errors: string[]): raw is PluginRuntimeBootstrapArtifactExpected {
  const value = strictObject(raw, ["htmlSha256", "htmlBytes", "moduleSha256", "moduleBytes"], ["htmlSha256", "htmlBytes", "moduleSha256", "moduleBytes"], label, errors);
  if (!value) return false;
  for (const key of ["htmlSha256", "moduleSha256"] as const) {
    if (typeof value[key] !== "string" || !SHA256_RE.test(value[key])) errors.push(`${label}.${key}: lowercase SHA-256 required`);
  }
  validatePositive(value.htmlBytes, `${label}.htmlBytes`, errors);
  validatePositive(value.moduleBytes, `${label}.moduleBytes`, errors);
  return errors.length === 0;
}

export function certifyPluginRuntimeBootstrapArtifact(
  raw: unknown,
  expected: PluginRuntimeBootstrapArtifactExpected,
): PluginRuntimeParseResult<Readonly<PluginRuntimeBootstrapArtifact>> {
  const errors: string[] = [];
  if (!validateJson(raw, errors)) return { ok: false, errors };
  validateArtifactExpected(expected, "expected", errors);
  const value = strictObject(
    raw,
    ["spec", "document", "sandboxTokens", "csp", "html", "module", "transferredPorts", "ambientPostMessage", "intrinsicsCapturedBeforePluginImport", "pluginImportRealm"],
    ["spec", "document", "sandboxTokens", "csp", "html", "module", "transferredPorts", "ambientPostMessage", "intrinsicsCapturedBeforePluginImport", "pluginImportRealm"],
    "artifact",
    errors,
  );
  if (!value) return { ok: false, errors };
  if (value.spec !== PLUGIN_RUNTIME_BOOTSTRAP_SPEC) errors.push(`artifact.spec: exact ${PLUGIN_RUNTIME_BOOTSTRAP_SPEC} required`);
  if (value.document !== "about:srcdoc") errors.push("artifact.document: about:srcdoc required");
  if (!Array.isArray(value.sandboxTokens) || value.sandboxTokens.length !== 1 || value.sandboxTokens[0] !== "allow-scripts") errors.push("artifact.sandboxTokens: exact allow-scripts tuple required");
  if (value.csp !== PLUGIN_RUNTIME_BOOTSTRAP_CSP) errors.push("artifact.csp: exact canonical CSP required");
  const html = strictObject(value.html, ["sha256", "bytes"], ["sha256", "bytes"], "artifact.html", errors);
  const module = strictObject(value.module, ["sha256", "bytes"], ["sha256", "bytes"], "artifact.module", errors);
  if (html) {
    if (html.sha256 !== expected.htmlSha256) errors.push("artifact.html.sha256: does not match release-pinned HTML bytes");
    if (html.bytes !== expected.htmlBytes) errors.push("artifact.html.bytes: does not match release-pinned HTML size");
    if (!validatePositive(html.bytes, "artifact.html.bytes", errors) || (html.bytes as number) > PLUGIN_RUNTIME_LIMITS.maxBootstrapHtmlBytes) errors.push("artifact.html.bytes: bootstrap HTML limit exceeded");
  }
  if (module) {
    if (module.sha256 !== expected.moduleSha256) errors.push("artifact.module.sha256: does not match release-pinned wrapper module bytes");
    if (module.bytes !== expected.moduleBytes) errors.push("artifact.module.bytes: does not match release-pinned module size");
    if (!validatePositive(module.bytes, "artifact.module.bytes", errors) || (module.bytes as number) > PLUGIN_RUNTIME_LIMITS.maxBootstrapModuleBytes) errors.push("artifact.module.bytes: bootstrap module limit exceeded");
  }
  if (value.transferredPorts !== 1) errors.push("artifact.transferredPorts: exactly one MessagePort required");
  if (value.ambientPostMessage !== "deny") errors.push("artifact.ambientPostMessage: deny required");
  if (value.intrinsicsCapturedBeforePluginImport !== true) errors.push("artifact.intrinsicsCapturedBeforePluginImport: exact true required");
  if (value.pluginImportRealm !== "opaque-child-frame-only") errors.push("artifact.pluginImportRealm: plugin import in opaque child frame only");
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: copyAndFreeze(raw as PluginRuntimeBootstrapArtifact) };
}

function validateProbeSet(
  raw: unknown,
  required: readonly string[],
  resultKey: "blocked" | "passed",
  label: string,
  errors: string[],
): void {
  if (!Array.isArray(raw)) {
    errors.push(`${label}: probe result array required`);
    return;
  }
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    const value = strictObject(item, ["id", resultKey], ["id", resultKey], `${label}[${index}]`, errors);
    if (!value) return;
    if (typeof value.id !== "string" || !required.includes(value.id)) errors.push(`${label}[${index}].id: unknown probe`);
    else if (seen.has(value.id)) errors.push(`${label}[${index}].id: duplicate probe`);
    else seen.add(value.id);
    if (value[resultKey] !== true) errors.push(`${label}[${index}].${resultKey}: exact true required`);
  });
  for (const id of required) if (!seen.has(id)) errors.push(`${label}: missing required probe ${id}`);
}

export function certifyPluginRuntimeNativeConformance(
  raw: unknown,
  expectedArtifact: PluginRuntimeBootstrapArtifactExpected,
): PluginRuntimeParseResult<Readonly<Record<string, unknown>>> {
  const errors: string[] = [];
  if (!validateJson(raw, errors)) return { ok: false, errors };
  const value = strictObject(
    raw,
    ["spec", "platform", "tauriRevision", "artifact", "topology", "availability", "attacks", "positives"],
    ["spec", "platform", "tauriRevision", "artifact", "topology", "availability", "attacks", "positives"],
    "report",
    errors,
  );
  if (!value) return { ok: false, errors };
  if (value.spec !== PLUGIN_RUNTIME_CONFORMANCE_SPEC) errors.push(`report.spec: exact ${PLUGIN_RUNTIME_CONFORMANCE_SPEC} required`);
  validateText(value.platform, "report.platform", errors);
  if (typeof value.tauriRevision !== "string" || !/^[0-9a-f]{40}$/.test(value.tauriRevision)) errors.push("report.tauriRevision: exact 40-character revision required");
  const expectedErrors: string[] = [];
  const expectedOk = validateArtifactExpected(expectedArtifact, "expectedArtifact", expectedErrors);
  errors.push(...expectedErrors);
  if (expectedOk) {
    const artifactResult = certifyPluginRuntimeBootstrapArtifact(value.artifact, expectedArtifact);
    if (!artifactResult.ok) errors.push(...artifactResult.errors.map((error) => `report.${error}`));
  }
  const topology = strictObject(value.topology, ["hostShellPluginImport", "nativeRuntime", "sandboxFrame"], ["hostShellPluginImport", "nativeRuntime", "sandboxFrame"], "report.topology", errors);
  if (topology) {
    if (topology.hostShellPluginImport !== "never") errors.push("report.topology.hostShellPluginImport: never required");
    if (topology.nativeRuntime !== "dedicated-per-unit") errors.push("report.topology.nativeRuntime: dedicated-per-unit required");
    if (topology.sandboxFrame !== "opaque-origin-allow-scripts") errors.push("report.topology.sandboxFrame: opaque-origin-allow-scripts required");
  }
  const availability = strictObject(value.availability, ["infiniteLoopInjected", "hostHeartbeatAdvanced", "cliRemainedResponsive", "terminatedOnlyFaultingUnit"], ["infiniteLoopInjected", "hostHeartbeatAdvanced", "cliRemainedResponsive", "terminatedOnlyFaultingUnit"], "report.availability", errors);
  if (availability) {
    for (const key of ["infiniteLoopInjected", "hostHeartbeatAdvanced", "cliRemainedResponsive", "terminatedOnlyFaultingUnit"] as const) {
      if (availability[key] !== true) errors.push(`report.availability.${key}: exact true required`);
    }
  }
  validateProbeSet(value.attacks, PLUGIN_RUNTIME_REQUIRED_ATTACK_PROBES, "blocked", "report.attacks", errors);
  validateProbeSet(value.positives, PLUGIN_RUNTIME_REQUIRED_POSITIVE_PROBES, "passed", "report.positives", errors);
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: copyAndFreeze(raw as Record<string, unknown>) };
}

/** Third-party execution is default-deny until the native live report certifies. */
export function isThirdPartyPluginRuntimeEligible(
  report: unknown,
  expectedArtifact: PluginRuntimeBootstrapArtifactExpected,
): boolean {
  return certifyPluginRuntimeNativeConformance(report, expectedArtifact).ok;
}
